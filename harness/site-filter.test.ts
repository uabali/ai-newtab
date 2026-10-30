import { expect, test } from "bun:test";
import { isBlocked, isPrivateAddress, normalizeBlockList, runHomepageBuild, type BrowserBridge } from "@homepage/agent-core";
import { fixtureHistory } from "./node-bridge";
import { COMPONENT, MemoryStore, call, mockClient, toolResults } from "./mock-llm";

test("normalizes pasted hosts and URLs", () => {
  expect(normalizeBlockList([" HTTPS://WWW.Google.COM/path ", "", " # comment", "*.Example.COM", "google.com"])).toEqual(["google.com", "*.example.com"]);
});

test("matches hosts and subdomains without matching lookalikes", () => {
  for (const host of ["google.com", "mail.google.com", "https://WWW.GOOGLE.COM./path"]) {
    expect(isBlocked(host, ["google.com"])).toBe(true);
  }
  expect(isBlocked("deep.sub.example.com", ["*.example.com"])).toBe(true);
  expect(isBlocked("example.com", ["*.example.com"])).toBe(true);
  for (const url of ["https:/mail.google.com", "https:\\mail.google.com", "HTTPS://user:pw@Mail.Google.com:443/x"]) {
    expect(isBlocked(url, ["google.com"])).toBe(true);
  }
  expect(isBlocked("localhost:3000", ["localhost"])).toBe(true);
  expect(isBlocked("notgoogle.com", ["google.com"])).toBe(false);
  expect(isBlocked("google.com.evil.test", ["google.com"])).toBe(false);
});

/**
 * Run the real loop against a scripted model that calls getHistory, then
 * getPageHtml with `urls`, then writes the homepage. Returns what each tool
 * answered (as the model saw it) and what reached the browser bridge.
 */
async function runTools(urls: string[], blockedSites?: string[] | (() => Promise<string[]>), afterHistory?: () => void, scrape?: BrowserBridge["getPageHtml"]) {
  const calls: string[][] = [];
  const logs: string[] = [];
  let historyReturned = false;
  const { llm, requests } = mockClient([
    { toolCalls: [call("getHistory", { maxResults: 1 }, "history")] },
    () => {
      afterHistory?.();
      return turnResponse([call("getPageHtml", { urls }, "pages")]);
    },
    { toolCalls: [call("write", { path: "/outputs/homepage.tsx", content: COMPONENT })] },
    { content: "Done." },
  ]);
  const bridge: BrowserBridge = {
    getHistory: async () => {
      historyReturned = true;
      return { sites: fixtureHistory(), totalSitesSeen: fixtureHistory().length };
    },
    getPageHtml: scrape ?? (async ({ urls }) => { calls.push(urls); return { pages: [], failed: urls.map(url => ({ url, reason: "unavailable" })) }; }),
  };
  const store = new MemoryStore();
  await runHomepageBuild({ llm, store, bridge, blockedSites, callbacks: { onLog: line => logs.push(line) } });
  expect(historyReturned).toBe(true);
  const results = toolResults(requests.at(-1)!);
  return { history: results.history!, pages: results.pages!, calls, logs, requests };
}

function turnResponse(toolCalls: ReturnType<typeof call>[]) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] }), { status: 200 });
}

test("filters history before capping and excludes blocked sites from the count", async () => {
  const { history } = await runTools(["https://public.test"], ["news.ycombinator.com"]);
  const digest = JSON.parse(history);
  expect(digest.totalSitesSeen).toBe(fixtureHistory().length - 1);
  expect(digest.sites).toHaveLength(1);
  expect(JSON.stringify(digest)).not.toContain("news.ycombinator.com");
});

test("uses newly saved blocked sites for the next tool call in an active build", async () => {
  let savedSites: string[] = [];
  const { history, pages, calls } = await runTools(
    ["https://news.ycombinator.com"],
    async () => savedSites,
    () => { savedSites = ["news.ycombinator.com"]; },
  );
  expect(history).toContain("news.ycombinator.com");
  expect(calls).toEqual([]);
  expect(JSON.parse(pages)).toEqual({
    pages: [],
    failed: [{ url: "https://news.ycombinator.com", reason: "blocked by the user's settings" }],
  });
});

test("never forwards blocked or non-http URLs", async () => {
  const urls = ["https://bank.test", "https://sub.bank.test", "https:/bank.test", "https:\\bank.test", "file:///secret", "chrome://settings", "javascript:alert(1)", "not a url"];
  const { pages, calls, logs } = await runTools(urls, ["bank.test"]);
  expect(calls).toEqual([]);
  expect(pages.startsWith("Error")).toBe(false);
  expect(JSON.parse(pages)).toEqual({ pages: [], failed: urls.map(url => ({ url, reason: "blocked by the user's settings" })) });
  expect(logs).toContain("blocked: 8 url(s)");
});

test("only forwards allowed URLs in mixed batches", async () => {
  const { pages, calls } = await runTools(["https://bank.test", "https://public.test"], ["bank.test"]);
  expect(calls).toEqual([["https://public.test"]]);
  expect(JSON.parse(pages).failed).toEqual([
    { url: "https://bank.test", reason: "blocked by the user's settings" },
    { url: "https://public.test", reason: "unavailable" },
  ]);
});

test("uses defaults when unset and honors an explicitly empty list", async () => {
  expect((await runTools(["https://mail.google.com"])).calls).toEqual([]);
  expect((await runTools(["https://mail.google.com"], [])).calls).toEqual([["https://mail.google.com"]]);
});

test("always blocks loopback, private and local-network hosts", () => {
  for (const url of [
    "http://localhost:5173", "http://127.0.0.2/", "http://0.0.0.0:8080", "http://2130706433/",
    "http://[::1]:3000/", "http://[::ffff:127.0.0.1]/", "http://[fd12::1]/", "http://[fe80::1]/",
    "http://10.0.0.5/", "http://172.20.1.1/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data",
    "http://100.100.1.1/", "http://router/", "http://printer.local/", "https://wiki.corp.internal/",
    "http://nas.lan/", "http://box.home.arpa/",
  ]) {
    expect(isBlocked(url, [])).toBe(true);
  }
  for (const url of ["https://8.8.8.8/", "https://172.32.0.1/", "https://192.169.0.1/", "https://news.ycombinator.com/", "https://[2606:4700::1111]/"]) {
    expect(isBlocked(url, [])).toBe(false);
  }
});

test("drops pages that redirected to a blocked host before uploading them", async () => {
  const redirector = "https://www.google.com/url?q=https://mail.google.com/";
  const { pages, requests } = await runTools([redirector, "https://public.test/"], ["mail.google.com"], undefined, async ({ urls }) => ({
    pages: [
      { url: urls[0]!, finalUrl: "https://mail.google.com/mail/u/0/", title: "Inbox", html: "<p>secret</p>" },
      { url: urls[1]!, finalUrl: "https://public.test/", title: "Public", html: "<p>news</p>" },
    ],
    failed: [],
  }));
  const out = JSON.parse(pages);
  expect(out.pages.map((p: any) => p.url)).toEqual(["https://public.test/"]);
  expect(out.failed).toEqual([{ url: redirector, reason: "blocked by the user's settings" }]);
  // Nothing the blocked page held ever reached the model endpoint.
  expect(JSON.stringify(requests.map((r) => r.body))).not.toContain("secret");
  expect(JSON.stringify(out)).not.toContain("Inbox");
});

test("classifies the addresses webRequest reports", () => {
  for (const ip of ["127.0.0.1", "192.168.179.1", "10.0.0.5", "::1", "::ffff:127.0.0.1", "fe80::1", "fd12::1"]) {
    expect(isPrivateAddress(ip)).toBe(true);
  }
  for (const ip of ["160.79.104.10", "8.8.8.8", "2606:4700::1111", "not an address"]) {
    expect(isPrivateAddress(ip)).toBe(false);
  }
});

test("drops pages served from a private address under a public-looking name", async () => {
  const urls = ["http://fritz.box/", "https://public.test/", "https://unknown.test/"];
  const { pages, requests } = await runTools(urls, [], undefined, async ({ urls }) => ({
    pages: [
      { url: urls[0]!, finalUrl: urls[0], ip: "192.168.179.1", title: "FRITZ!Box", html: "<p>router</p>" },
      { url: urls[1]!, finalUrl: urls[1], ip: "160.79.104.10", title: "Public", html: "<p>news</p>" },
      { url: urls[2]!, finalUrl: urls[2], title: "No address", html: "<p>kept</p>" },
    ],
    failed: [],
  }));
  const out = JSON.parse(pages);
  expect(out.pages).toHaveLength(2);
  expect(out.pages.map((p: any) => p.url)).toEqual(["https://public.test/", "https://unknown.test/"]);
  expect(JSON.stringify(requests.map((r) => r.body))).not.toContain("router");
  expect(out.failed).toEqual([{ url: "http://fritz.box/", reason: "blocked by the user's settings" }]);
  expect(JSON.stringify(out)).not.toContain("FRITZ");
});
