import { describe, expect, test } from "bun:test";
import { linkKey } from "@homepage/agent-core";
import {
  BRIDGE_INDEX_JS,
  BRIDGE_MSG,
  KEY_SOURCE,
  bridgeScript,
  handleBridgeMessage,
  openWithTabs,
  type OpenDisposition,
} from "../apps/extension/lib/link-bridge";

const SAMPLES = [
  "https://news.ycombinator.com/item?id=1",
  "https://news.ycombinator.com/item?id=1#comments",
  "https://github.com/a/b/",
  "http://example.com",
  " https://example.com/x ",
  "HTTPS://EXAMPLE.COM/Path",
  "/relative",
  "item?id=2",
  "//example.com/x",
  "javascript:alert(1)",
  "data:text/html,hi",
  "mailto:a@b.c",
  "https://user:pw@example.com/",
  "",
];

test("the iframe's link key matches agent-core's", () => {
  const key = new Function(`${KEY_SOURCE}; return key;`)() as (s: string) => string | null;
  for (const s of SAMPLES) expect(key(s)).toBe(linkKey(s));
});

/** Just enough DOM for the bridge script. */
function fakeFrame(hrefs: string[]) {
  const posted: any[] = [];
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const winListeners: Record<string, Array<(e: any) => void>> = {};
  const anchors = hrefs.map((href) => {
    const attrs = new Map<string, string>([["href", href]]);
    const a: any = {
      nodeType: 1,
      getAttribute: (n: string) => attrs.get(n) ?? null,
      setAttribute: (n: string, val: string) => attrs.set(n, val),
      removeAttribute: (n: string) => attrs.delete(n),
      hasAttribute: (n: string) => attrs.has(n),
      closest: (sel: string) => (sel === "a" ? a : null),
    };
    return a;
  });
  const doc: any = {
    readyState: "complete",
    documentElement: {},
    addEventListener: (t: string, f: any) => (listeners[t] ??= []).push(f),
    querySelectorAll: () => anchors.filter((a) => a.hasAttribute("href")),
    getElementById: () => ({ textContent: "Hello", querySelector: () => null }),
  };
  const win: any = {
    parent: { postMessage: (m: unknown) => posted.push(m) },
    addEventListener: (t: string, f: any) => (winListeners[t] ??= []).push(f),
  };
  const fire = (type: string, a: any, init: Partial<{ button: number; ctrlKey: boolean; metaKey: boolean }> = {}) => {
    const e = { target: a, button: 0, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const f of listeners[type] ?? []) f(e);
    return e;
  };
  return { win, doc, anchors, posted, fire, winListeners };
}

function load(allow: string[] | null, hrefs: string[]) {
  const f = fakeFrame(hrefs);
  new Function("window", "document", bridgeScript(allow))(f.win, f.doc);
  return f;
}

describe("bridge script (inside the iframe)", () => {
  const ALLOW = ["https://news.ycombinator.com/item?id=1"];

  test("a click never navigates the iframe; an allowed link is posted to the new-tab page", () => {
    const f = load(ALLOW, ["https://news.ycombinator.com/item?id=1#c"]);
    const e = f.fire("click", f.anchors[0]);
    expect(e.defaultPrevented).toBe(true);
    expect(f.posted).toEqual([{ type: BRIDGE_MSG.open, url: "https://news.ycombinator.com/item?id=1#c", disposition: "current" }]);
  });

  test("Ctrl/⌘-click and middle-click open in a background tab", () => {
    const f = load(ALLOW, ["https://news.ycombinator.com/item?id=1"]);
    f.fire("click", f.anchors[0], { metaKey: true });
    f.fire("auxclick", f.anchors[0], { button: 1 });
    expect(f.posted.map((m) => m.disposition)).toEqual(["background", "background"]);
  });

  test("links outside the allowlist are unlinked on load and do nothing when clicked", () => {
    const f = load(ALLOW, ["https://news.ycombinator.com/item?id=1", "https://made.up/x", "/relative"]);
    expect(f.anchors.map((a) => a.getAttribute("href"))).toEqual(["https://news.ycombinator.com/item?id=1", null, null]);
    expect(f.anchors[1].hasAttribute("data-unlinked")).toBe(true);
    const e = f.fire("click", f.anchors[1]);
    expect(e.defaultPrevented).toBe(true);
    expect(f.posted).toEqual([]);
  });

  test("window.open is routed through the bridge too", () => {
    const f = load(ALLOW, []);
    expect(f.win.open("https://news.ycombinator.com/item?id=1")).toBeNull();
    f.win.open("https://made.up/");
    expect(f.posted).toEqual([{ type: BRIDGE_MSG.open, url: "https://news.ycombinator.com/item?id=1", disposition: "foreground" }]);
  });

  test("without an allowlist (older homepages) any absolute http(s) link works, nothing else", () => {
    const f = load(null, ["https://anything.example/", "javascript:alert(1)"]);
    f.fire("click", f.anchors[0]);
    expect(f.posted).toHaveLength(1);
    expect(f.anchors[1].getAttribute("href")).toBeNull();
  });

  test("reports render success once, or the error", () => {
    const ok = load(ALLOW, []);
    ok.win.__aiHomepage.rendered();
    ok.win.__aiHomepage.failed("late");
    expect(ok.posted).toEqual([{ type: BRIDGE_MSG.rendered }]);
    const bad = load(ALLOW, []);
    for (const f of bad.winListeners.error ?? []) f({ message: "ReferenceError: x is not defined" });
    expect(bad.posted).toEqual([{ type: BRIDGE_MSG.error, message: "ReferenceError: x is not defined" }]);
  });

  test("the entry imports the bridge before the component and wraps it in an error boundary", () => {
    expect(BRIDGE_INDEX_JS.indexOf('import "./bridge.js"')).toBe(0);
    expect(BRIDGE_INDEX_JS).toContain("getDerivedStateFromError");
    expect(BRIDGE_INDEX_JS).toContain("__aiHomepage.rendered");
  });
});

describe("handleBridgeMessage (new-tab page)", () => {
  const frame = { id: "iframe-window" };
  const allow = new Set(["https://news.ycombinator.com/item?id=1"]);
  function run(data: unknown, opts: { source?: unknown; active?: boolean; allow?: Set<string> | null } = {}) {
    const opened: Array<[string, OpenDisposition]> = [];
    const events: string[] = [];
    const outcome = handleBridgeMessage(
      { data, source: "source" in opts ? opts.source : frame },
      {
        frame,
        allow: opts.allow === undefined ? allow : opts.allow,
        userActive: () => opts.active ?? true,
        openTab: (url, d) => void opened.push([url, d]),
        onRendered: () => events.push("rendered"),
        onRenderError: (m) => events.push(`error:${m}`),
      },
    );
    return { outcome, opened, events };
  }
  const open = (url: unknown, disposition?: string) => ({ type: BRIDGE_MSG.open, url, disposition });

  test("opens an allowed link with the requested disposition", () => {
    expect(run(open("https://news.ycombinator.com/item?id=1#c")).opened).toEqual([["https://news.ycombinator.com/item?id=1#c", "current"]]);
    expect(run(open("https://news.ycombinator.com/item?id=1", "background")).opened[0]![1]).toBe("background");
    expect(run(open("https://news.ycombinator.com/item?id=1", "weird")).opened[0]![1]).toBe("current");
  });

  test("ignores messages from anything but the preview iframe", () => {
    expect(run(open("https://news.ycombinator.com/item?id=1"), { source: {} }).outcome).toBe("ignored");
    expect(run(open("https://news.ycombinator.com/item?id=1"), { source: null }).outcome).toBe("ignored");
    expect(run("not an object").outcome).toBe("ignored");
  });

  test("refuses non-http(s), relative and unlisted links, and opens without a click", () => {
    for (const url of ["javascript:alert(1)", "chrome://settings", "file:///etc/passwd", "/relative", "https://made.up/", 7]) {
      const r = run(open(url));
      expect(r.outcome).toBe("refused");
      expect(r.opened).toEqual([]);
    }
    expect(run(open("https://news.ycombinator.com/item?id=1"), { active: false }).outcome).toBe("refused");
    expect(run(open("https://anything.example/"), { allow: null }).outcome).toBe("opened");
    expect(run(open("javascript:alert(1)"), { allow: null }).outcome).toBe("refused");
  });

  test("passes render status through", () => {
    expect(run({ type: BRIDGE_MSG.rendered }).events).toEqual(["rendered"]);
    expect(run({ type: BRIDGE_MSG.error, message: "boom" }).events).toEqual(["error:boom"]);
  });

  test("openWithTabs: this tab for a click, a new tab otherwise", async () => {
    const calls: string[] = [];
    const tabs = {
      update: async (p: { url: string }) => void calls.push(`update ${p.url}`),
      create: async (p: { url: string; active: boolean }) => void calls.push(`create ${p.url} ${p.active}`),
    };
    await openWithTabs(tabs, "https://a.com/", "current");
    await openWithTabs(tabs, "https://a.com/", "background");
    await openWithTabs(tabs, "https://a.com/", "foreground");
    expect(calls).toEqual(["update https://a.com/", "create https://a.com/ false", "create https://a.com/ true"]);
  });
});
