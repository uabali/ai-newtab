import { expect, test } from "bun:test";
import {
  DEFAULT_MODEL,
  HOMEPAGE_TOOLS,
  OUTPUT_PATH,
  STORAGE_KEYS,
  Workspace,
  compactMessages,
  normalizeBaseUrl,
  runHomepageBuild,
  type BrowserBridge,
  type ChatMessage,
  type RunCheckpoint,
} from "@homepage/agent-core";
import { COMPONENT, MemoryStore, call, mockClient, toolResults } from "./mock-llm";
import { fixtureHistory } from "./node-bridge";

const PAGE = `<html><body><h2><a href="https://news.ycombinator.com/item?id=1">Rust 2.0 released</a></h2><p>Big news</p><h2><a href="/item?id=2">Second story</a></h2></body></html>`;

function bridge(scrapes: string[][] = []): BrowserBridge {
  return {
    getHistory: async () => ({ sites: fixtureHistory(), totalSitesSeen: fixtureHistory().length }),
    getPageHtml: async ({ urls }) => {
      scrapes.push(urls);
      return { pages: urls.map((url) => ({ url, finalUrl: url, title: "HN", html: PAGE })), failed: [] };
    },
  };
}

test("runs the whole build over a mock endpoint and returns the written component", async () => {
  const scrapes: string[][] = [];
  const phases: string[] = [];
  const text: string[] = [];
  const { llm, requests, remaining } = mockClient([
    { content: "Looking at your history.", toolCalls: [call("getHistory", {}, "h")] },
    { toolCalls: [call("getPageHtml", { urls: ["https://news.ycombinator.com/"] }, "p")] },
    { toolCalls: [call("glob", { pattern: "*.html" }, "g"), call("grep", { pattern: "<h2" }, "s")] },
    { toolCalls: [call("read", { path: "/pages/news_ycombinator_com_0.html", offset: 1, limit: 5 }, "r")] },
    { toolCalls: [call("write", { path: OUTPUT_PATH, content: "```tsx\n" + COMPONENT + "\n```" }, "w")] },
    { content: "Built a one-column HN digest." },
  ]);
  const store = new MemoryStore();
  const result = await runHomepageBuild({
    llm,
    store,
    bridge: bridge(scrapes),
    callbacks: { onPhase: (p) => phases.push(p), onText: (t) => text.push(t) },
  });

  expect(remaining()).toBe(0);
  expect(result.code).toBe(COMPONENT);
  expect(result.source).toBe("session-output");
  expect(result.sessionId).toMatch(/^run-/);
  expect(scrapes).toEqual([["https://news.ycombinator.com/"]]);
  expect(text.join(" ")).toContain("Built a one-column HN digest.");
  for (const p of ["setup", "history", "scraping", "analyzing", "writing", "cleanup", "done"]) expect(phases).toContain(p);

  // Request shape: OpenRouter's endpoint, bearer auth, the default model, every tool offered.
  const first = requests[0]!;
  expect(first.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(first.headers.authorization).toBe("Bearer test-key-not-real");
  expect(first.body.model).toBe(DEFAULT_MODEL);
  expect(first.body.tool_choice).toBe("auto");
  expect(first.body.tools.map((t: any) => t.function.name)).toEqual(["getHistory", "getPageHtml", "read", "grep", "glob", "write"]);
  expect(first.body.max_tokens).toBeUndefined();
  expect(first.body.messages[0].role).toBe("system");

  // Tool results went back as role:tool messages, matched by id.
  const results = toolResults(requests.at(-1)!);
  expect(JSON.parse(results.p!).pages[0].mountPath).toBe("/pages/news_ycombinator_com_0.html");
  expect(results.g).toContain("/pages/news_ycombinator_com_0.html");
  expect(results.s).toContain("Rust 2.0 released");
  expect(results.r).toMatch(/^\/pages\/news_ycombinator_com_0\.html — lines 1-5 of \d+/);
  expect(results.w).toContain("Wrote /outputs/homepage.tsx");

  // Nothing is left behind once the build ends.
  expect(store.data.size).toBe(0);
});

test("uses a configured base URL and model", async () => {
  const { llm, requests } = mockClient(
    [{ toolCalls: [call("write", { path: OUTPUT_PATH, content: COMPONENT })] }, { content: "ok" }],
    { baseUrl: "https://llm.example.com/v1/chat/completions/" },
  );
  await runHomepageBuild({ llm, store: new MemoryStore(), bridge: bridge(), model: "  google/gemma-4-31b-it:free " });
  expect(requests[0]!.url).toBe("https://llm.example.com/v1/chat/completions");
  expect(requests[0]!.body.model).toBe("google/gemma-4-31b-it:free");
});

test("rejects a non-https base URL", () => {
  expect(() => normalizeBaseUrl("http://openrouter.ai/api/v1")).toThrow(/https/);
  expect(() => normalizeBaseUrl("not a url")).toThrow(/Invalid/);
  expect(normalizeBaseUrl("")).toBe("https://openrouter.ai/api/v1");
});

test("supports writing the component in parts with append", async () => {
  const half = Math.floor(COMPONENT.length / 2);
  const { llm } = mockClient([
    { toolCalls: [call("write", { path: OUTPUT_PATH, content: COMPONENT.slice(0, half) })] },
    { toolCalls: [call("write", { path: OUTPUT_PATH, content: COMPONENT.slice(half), append: true })] },
    { content: "done" },
  ]);
  const result = await runHomepageBuild({ llm, store: new MemoryStore(), bridge: bridge() });
  expect(result.code).toBe(COMPONENT);
});

test("reminds a model that stops without writing, then accepts the write", async () => {
  const logs: string[] = [];
  const { llm, requests } = mockClient([
    { content: "I think the page should have news." },
    { toolCalls: [call("write", { path: OUTPUT_PATH, content: COMPONENT })] },
    { content: "done" },
  ]);
  const result = await runHomepageBuild({ llm, store: new MemoryStore(), bridge: bridge(), callbacks: { onLog: (l) => logs.push(l) } });
  expect(result.code).toBe(COMPONENT);
  const nudge = requests[1]!.body.messages.at(-1);
  expect(nudge.role).toBe("user");
  expect(nudge.content).toContain("You have not written /outputs/homepage.tsx");
  expect(logs.some((l) => l.includes("reminding the model"))).toBe(true);
});

test("falls back to a fenced component in the final message", async () => {
  const fenced = "Here it is:\n```tsx\n" + COMPONENT + "\n```";
  const { llm } = mockClient([{ content: fenced }, { content: fenced }, { content: fenced }]);
  const result = await runHomepageBuild({ llm, store: new MemoryStore(), bridge: bridge() });
  expect(result.source).toBe("message-fence");
  expect(result.code).toBe(COMPONENT);
});

test("fails clearly when no homepage is produced", async () => {
  const { llm } = mockClient([{ content: "no" }, { content: "no" }, { content: "no" }]);
  const store = new MemoryStore();
  await expect(runHomepageBuild({ llm, store, bridge: bridge() })).rejects.toThrow(/Agent produced no homepage/);
  expect(store.data.size).toBe(0);
});

test("answers malformed tool arguments with an error instead of crashing", async () => {
  const { llm, requests } = mockClient([
    { toolCalls: [call("write", '{"path": "/outputs/homepage.tsx", "content": "import Rea', "bad")], finishReason: "length" },
    { toolCalls: [call("write", { path: "/etc/passwd.ts", content: "x" }, "outside")] },
    { toolCalls: [call("nope", {}, "unknown")] },
    { toolCalls: [call("write", { path: OUTPUT_PATH, content: COMPONENT })] },
    { content: "done" },
  ]);
  const result = await runHomepageBuild({ llm, store: new MemoryStore(), bridge: bridge() });
  expect(result.code).toBe(COMPONENT);
  const results = toolResults(requests.at(-1)!);
  expect(results.bad).toMatch(/^Error: could not parse the arguments for write/);
  expect(results.outside).toMatch(/only allowed under \/outputs/);
  expect(results.unknown).toMatch(/Unknown tool: nope/);
});

test("truncates large tool results for small-context models", async () => {
  const big = `<div>${Array.from({ length: 3000 }, (_, i) => `<p>headline number ${i} ${"x".repeat(40)}</p>`).join("")}</div>`;
  const { llm, requests } = mockClient([
    { toolCalls: [call("getPageHtml", { urls: ["https://big.test/"] }, "p")] },
    { toolCalls: [call("read", { path: "/pages/big_test_0.html", limit: 400 }, "r"), call("grep", { pattern: "headline", maxResults: 200 }, "s")] },
    { toolCalls: [call("getHistory", { maxResults: 50 }, "h")] },
    { toolCalls: [call("write", { path: OUTPUT_PATH, content: COMPONENT })] },
    { content: "done" },
  ]);
  const b: BrowserBridge = {
    ...bridge(),
    getPageHtml: async ({ urls }) => ({ pages: urls.map((url) => ({ url, title: "big", html: big })), failed: [] }),
  };
  await runHomepageBuild({ llm, store: new MemoryStore(), bridge: b, maxToolResultChars: 2_000, contextBudgetChars: 1_000_000 });
  const results = toolResults(requests.at(-1)!);
  expect(results.r!.length).toBeLessThan(2_200);
  expect(results.r).toContain("Continue with offset=");
  expect(results.s!.length).toBeLessThan(2_300);
  expect(results.s).toMatch(/not shown/);
  // The history digest shrinks by whole sites, so it stays valid JSON.
  expect(results.h!.length).toBeLessThanOrEqual(2_000);
  expect(() => JSON.parse(results.h!)).not.toThrow();
});

test("elides the oldest tool results when the conversation outgrows the budget", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: "A".repeat(5_000) },
    { role: "assistant", content: null, tool_calls: [{ id: "w", type: "function", function: { name: "write", arguments: JSON.stringify({ path: OUTPUT_PATH, content: "B".repeat(5_000) }) } }] },
    { role: "tool", tool_call_id: "w", content: "Wrote" },
    { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c", content: "C".repeat(5_000) },
    { role: "assistant", content: "latest" },
    { role: "user", content: "go on" },
  ];
  const elided = compactMessages(messages, 6_000);
  expect(elided).toBe(2);
  expect((messages[3] as any).content).toContain("Earlier tool result removed");
  expect(JSON.parse((messages[4] as any).tool_calls[0].function.arguments).content).toContain("omitted");
  // The most recent messages are untouched.
  expect((messages[7] as any).content).toBe("C".repeat(5_000));
});

test("retries rate limits and server errors, then succeeds", async () => {
  const { llm, requests } = mockClient([
    () => new Response(JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-min" } }), { status: 429 }),
    () => new Response("upstream down", { status: 502 }),
    () => new Response(JSON.stringify({ error: { message: "Provider returned error", code: 502 } }), { status: 200 }),
    { toolCalls: [call("write", { path: OUTPUT_PATH, content: COMPONENT })] },
    { content: "done" },
  ]);
  const result = await runHomepageBuild({ llm, store: new MemoryStore(), bridge: bridge() });
  expect(result.code).toBe(COMPONENT);
  expect(requests).toHaveLength(5);
});

test("surfaces a bad key without retrying, and cleans up", async () => {
  const { llm, requests } = mockClient([
    () => new Response(JSON.stringify({ error: { message: "No auth credentials found", code: 401 } }), { status: 401 }),
  ]);
  const store = new MemoryStore();
  await expect(runHomepageBuild({ llm, store, bridge: bridge() })).rejects.toThrow("OpenRouter request failed (401): No auth credentials found");
  expect(requests).toHaveLength(1);
  expect(store.data.size).toBe(0);
});

test("stops when cancelled", async () => {
  const controller = new AbortController();
  const { llm } = mockClient([
    () => {
      controller.abort();
      return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }));
    },
  ]);
  const store = new MemoryStore();
  await expect(runHomepageBuild({ llm, store, bridge: bridge(), signal: controller.signal })).rejects.toThrow(/aborted/);
  expect(store.data.size).toBe(0);
});

test("checkpoints after each turn and resumes a killed build without scraping again", async () => {
  // Phase 1: a build gets as far as scraping, then the worker "dies". Snapshot
  // the store at that moment: a killed worker never runs its finally.
  const scrapes: string[][] = [];
  const store = new MemoryStore();
  let snapshot: Map<string, unknown> | undefined;
  const crashing = mockClient([
    { toolCalls: [call("getHistory", {}, "h")] },
    { toolCalls: [call("getPageHtml", { urls: ["https://news.ycombinator.com/"] }, "p")] },
    () => {
      snapshot = new Map([...store.data].map(([k, v]) => [k, structuredClone(v)]));
      throw new Error("worker killed");
    },
  ]);
  await expect(runHomepageBuild({ llm: crashing.llm, store, bridge: bridge(scrapes), model: "x-ai/grok-4.7" })).rejects.toThrow();
  expect(snapshot).toBeDefined();
  const runId = snapshot!.get(STORAGE_KEYS.activeSessionId) as string;
  const checkpoint = snapshot!.get(STORAGE_KEYS.runCheckpoint) as RunCheckpoint;
  expect(checkpoint.id).toBe(runId);
  expect(checkpoint.steps).toBe(2);
  expect(Object.keys(checkpoint.files)).toEqual(["/pages/news_ycombinator_com_0.html"]);

  // Phase 2: a fresh worker resumes from that checkpoint.
  const revived = new MemoryStore();
  for (const [k, v] of snapshot!) await revived.set(k, v);
  const resumed = mockClient([
    { toolCalls: [call("grep", { pattern: "Rust" }, "s")] },
    { toolCalls: [call("write", { path: OUTPUT_PATH, content: COMPONENT })] },
    { content: "done" },
  ]);
  const result = await runHomepageBuild({ llm: resumed.llm, store: revived, bridge: bridge(scrapes), resumeSessionId: runId });
  expect(result.sessionId).toBe(runId);
  expect(result.code).toBe(COMPONENT);
  expect(scrapes).toHaveLength(1); // not scraped again
  expect(resumed.requests[0]!.body.model).toBe("x-ai/grok-4.7"); // a build keeps its model
  expect(toolResults(resumed.requests.at(-1)!).s).toContain("Rust 2.0 released");
  expect(revived.data.size).toBe(0);
});

test("workspace grep/glob/read behave on line-split HTML", () => {
  const ws = new Workspace();
  const { path, bytes } = ws.addPage("a.html", PAGE);
  expect(path).toBe("/pages/a.html");
  expect(bytes).toBeGreaterThan(0);
  expect(ws.glob({ pattern: "/pages/*.html" })).toContain("/pages/a.html");
  expect(ws.glob({ pattern: "**/*.tsx" })).toMatch(/^No files match/);
  expect(ws.grep({ pattern: "second story" }, 10_000)).toContain("/pages/a.html:");
  // A headline, its link and its text land on one line, so a grep for "<h2" is useful on its own.
  expect(ws.grep({ pattern: "<h2" }, 10_000)).toContain('<h2><a href="https://news.ycombinator.com/item?id=1">Rust 2.0 released</a></h2>');
  expect(ws.get("/pages/a.html")!.split("\n").length).toBe(5);
  expect(ws.grep({ pattern: "second story", ignoreCase: false }, 10_000)).toMatch(/^No matches/);
  expect(ws.grep({ pattern: "(unclosed" }, 10_000)).toMatch(/^No matches/); // invalid regex → literal
  expect(ws.read({ path: "/mnt/session/uploads/pages/a.html" }, 10_000)).toContain("Rust 2.0 released");
  expect(() => ws.read({ path: "/pages/missing.html" }, 10_000)).toThrow(/No such file/);
  expect(() => ws.write({ path: "/outputs/../pages/a.html", content: "x" })).toThrow(/only allowed under/);
  expect(HOMEPAGE_TOOLS.every((t) => t.function.parameters.type === "object")).toBe(true);
});
