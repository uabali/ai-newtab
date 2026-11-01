import { expect, test } from "bun:test";
import {
  EDITION_PATH,
  OUTPUT_PATH,
  checkComponent,
  runHomepageBuild,
  runHomepageRepair,
  type BrowserBridge,
} from "@homepage/agent-core";
import { decideOnRenderFailure, shouldRepair } from "../apps/extension/lib/render-fallback";
import { COMPONENT, COMPONENT_UNLINKED, MemoryStore, call, mockClient } from "./mock-llm";
import { fixtureHistory } from "./node-bridge";

const PAGE = `<html><body><h2><a href="https://news.ycombinator.com/item?id=1">Rust 2.0 released</a></h2><h2><a href="/item?id=2">Second story</a></h2></body></html>`;
const bridge: BrowserBridge = {
  getHistory: async () => ({ sites: fixtureHistory(), totalSitesSeen: fixtureHistory().length }),
  getPageHtml: async ({ urls }) => ({ pages: urls.map((url) => ({ url, finalUrl: url, title: "HN", html: PAGE })), failed: [] }),
};
const BROKEN = "import React from 'react';\nexport default function PersonalizedHomepage() {\n  return <div><p>unclosed</div>;\n}";

test("the default edition flow renders The Morning Tab and keeps only links the model saw", async () => {
  const edition = {
    lead: { title: "Rust 2.0 released", url: "https://news.ycombinator.com/item?id=1", source: "Hacker News" },
    stories: [
      { title: "Second story", url: "https://news.ycombinator.com/item?id=2", source: "Hacker News" },
      { title: "Invented", url: "https://news.ycombinator.com/item?id=31337", source: "Hacker News" },
      { title: "Relative", url: "/item?id=2" },
    ],
    briefs: [{ title: "A domain from history", url: "https://github.com/", source: "GitHub" }],
  };
  const { llm, remaining } = mockClient([
    { toolCalls: [call("getHistory", {})] },
    { toolCalls: [call("getPageHtml", { urls: ["https://news.ycombinator.com/"] })] },
    { toolCalls: [call("write", { path: EDITION_PATH, content: JSON.stringify(edition) })] },
    { content: "done" },
  ]);
  const result = await runHomepageBuild({ llm, store: new MemoryStore(), bridge, now: new Date(2026, 9, 30, 8) });
  expect(remaining()).toBe(0);
  expect(result.source).toBe("edition");
  expect(result.repaired).toBe(false);
  expect(checkComponent(result.code)).toBeNull();
  expect(result.code).toContain("The Morning Tab");
  expect(result.links.sort()).toEqual(
    ["https://github.com/", "https://news.ycombinator.com/item?id=1", "https://news.ycombinator.com/item?id=2"].sort(),
  );
  expect(result.removedLinks).toEqual([
    { url: "https://news.ycombinator.com/item?id=31337", reason: "not-seen" },
    { url: "/item?id=2", reason: "not-http" },
  ]);
  expect(result.code).not.toContain("31337");
});

test("a component that fails its check goes back to the model exactly once", async () => {
  const { llm, requests, remaining } = mockClient([
    { toolCalls: [call("write", { path: OUTPUT_PATH, content: BROKEN })] },
    { content: "done" },
    { toolCalls: [call("write", { path: OUTPUT_PATH, content: COMPONENT })] },
    { content: "fixed" },
  ]);
  const result = await runHomepageBuild({ llm, store: new MemoryStore(), bridge });
  expect(remaining()).toBe(0);
  expect(result.repaired).toBe(true);
  expect(result.code).toBe(COMPONENT_UNLINKED);
  const ask = requests[2]!.body.messages.at(-1);
  expect(ask.role).toBe("user");
  expect(ask.content).toContain("failed to build");
  expect(ask.content).toContain("only retry");
});

test("a bad edition gets the parse error back, once", async () => {
  const { llm, requests } = mockClient([
    { toolCalls: [call("write", { path: EDITION_PATH, content: "{ \"lead\": " })] },
    { content: "done" },
    { toolCalls: [call("write", { path: EDITION_PATH, content: JSON.stringify({ stories: [{ title: "Fixed" }] }) })] },
    { content: "done" },
  ]);
  const result = await runHomepageBuild({ llm, store: new MemoryStore(), bridge });
  expect(requests[2]!.body.messages.at(-1).content).toContain("not valid JSON");
  expect(result.source).toBe("edition");
  expect(result.repaired).toBe(true);
});

test("still broken after the one repair: the build fails instead of saving it", async () => {
  const { llm, remaining } = mockClient([
    { toolCalls: [call("write", { path: OUTPUT_PATH, content: BROKEN })] },
    { content: "done" },
    { toolCalls: [call("write", { path: OUTPUT_PATH, content: BROKEN })] },
    { content: "done" },
  ]);
  await expect(runHomepageBuild({ llm, store: new MemoryStore(), bridge })).rejects.toThrow();
  expect(remaining()).toBe(0);
});

test("runHomepageRepair sends only the component and the error, offers only write, and keeps the allowlist", async () => {
  const fixed = `import React from 'react';
export default function PersonalizedHomepage() {
  return <div><a href="https://news.ycombinator.com/item?id=1">kept</a><a href="https://evil.example/">added</a></div>;
}`;
  const { llm, requests } = mockClient([{ toolCalls: [call("write", { path: "/outputs/anything.tsx", content: fixed })] }, { content: "ok" }]);
  const result = await runHomepageRepair({
    llm,
    code: COMPONENT,
    error: "TypeError: x is undefined",
    allowedLinks: ["https://news.ycombinator.com/item?id=1"],
  });
  expect(result.source).toBe("repair");
  expect(result.repaired).toBe(true);
  expect(result.links).toEqual(["https://news.ycombinator.com/item?id=1"]);
  expect(result.removedLinks).toEqual([{ url: "https://evil.example/", reason: "not-seen" }]);
  expect(result.code).toContain("<a>added</a>");
  const body = requests[0]!.body;
  expect(body.tools.map((t: any) => t.function.name)).toEqual(["write"]);
  expect(body.messages).toHaveLength(2);
  expect(body.messages[1].content).toContain("TypeError: x is undefined");
  expect(body.messages[1].content).toContain("PersonalizedHomepage");
  expect(JSON.stringify(body)).not.toContain("getHistory");
});

test("runHomepageRepair throws when the repair still fails", async () => {
  const { llm } = mockClient([{ toolCalls: [call("write", { path: OUTPUT_PATH, content: BROKEN })] }, { content: "ok" }]);
  await expect(runHomepageRepair({ llm, code: BROKEN, error: "boom" })).rejects.toThrow(/still fails/);
  const silent = mockClient([{ content: "I can't." }]);
  await expect(runHomepageRepair({ llm: silent.llm, code: BROKEN, error: "boom" })).rejects.toThrow(/no component/);
});

const v = (timestamp: string, repairAttempted = false) => ({ timestamp, repairAttempted, code: "" });

test("a failed render falls back to the last working homepage and asks for one repair", () => {
  const current = v("t2");
  expect(decideOnRenderFailure({ current, failed: current, lastGood: v("t1"), canRepair: true })).toEqual({ show: v("t1"), repair: true });
  // No key: fall back, but no repair.
  expect(decideOnRenderFailure({ current, failed: current, lastGood: v("t1"), canRepair: false }).repair).toBe(false);
  // Already repaired once: fall back only.
  const repaired = v("t3", true);
  expect(decideOnRenderFailure({ current: repaired, failed: repaired, lastGood: v("t1"), canRepair: true })).toEqual({ show: v("t1"), repair: false });
});

test("with no working version, or when the fallback fails too, nothing is shown (the page shows an error card)", () => {
  const current = v("t2");
  expect(decideOnRenderFailure({ current, failed: current, lastGood: undefined, canRepair: true })).toEqual({ show: null, repair: true });
  // lastGood is the same version that just failed: don't "fall back" to it.
  expect(decideOnRenderFailure({ current, failed: current, lastGood: current, canRepair: true }).show).toBeNull();
  expect(decideOnRenderFailure({ current, failed: v("t1"), lastGood: v("t1"), canRepair: true })).toEqual({ show: null, repair: false });
});

test("the worker repairs only the homepage the tab saw fail, and only once", () => {
  expect(shouldRepair(v("t2"), { timestamp: "t2" })).toBe(true);
  expect(shouldRepair(v("t2", true), { timestamp: "t2" })).toBe(false);
  expect(shouldRepair(v("t3"), { timestamp: "t2" })).toBe(false);
  expect(shouldRepair(undefined, { timestamp: "t2" })).toBe(false);
});
