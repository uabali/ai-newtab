/**
 * Screenshots of the extension UI in headless Chrome, for review. Loads the built
 * extension into a throwaway profile, stores a DUMMY key (never a real one) and a
 * fixture homepage, and captures: the key screen, the first-build screen, each
 * Settings tab, the model picker, the toolbar over a rendered homepage, a MOCK
 * "Morning Tab" edition, the Settings "unsaved changes" bar, and the fallback
 * shown when a homepage fails to render.
 *
 * The Morning Tab shot goes through the real build pipeline (runHomepageBuild:
 * edition.json → template → link check) with a scripted MOCK model and a fixture
 * page, so it shows exactly what the template renders; the content is made up
 * and labelled MOCK on the page.
 *
 * No model calls are made. Opening the model picker makes the one anonymous GET
 * the extension itself makes (OpenRouter's public model list); the fixture
 * homepage is rendered by Sandpack's hosted bundler, as in normal use.
 *
 * Run: pnpm build && bun harness/screenshots.ts   (writes to harness/out/shots/)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDITION_PATH, runHomepageBuild, type BrowserBridge } from "@homepage/agent-core";
import { MemoryStore, call, mockClient } from "./mock-llm";
import { fixtureHistory } from "./node-bridge";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EXT = join(import.meta.dir, "../apps/extension/.output/chrome-mv3");
const OUT = process.env.SHOTS_DIR ?? join(import.meta.dir, "out/shots");
const PORT = 9334;
const DUMMY_KEY = "sk-or-v1-dummy-screenshot-key-not-real-0000";

const HOMEPAGE = `import React from 'react';
export default function PersonalizedHomepage() {
  const items = [
    ['Rust 2.0 released', 'https://news.ycombinator.com/item?id=1'],
    ['A tour of the new Chrome DevTools', 'https://developer.chrome.com/'],
    ['Lobsters: what are you working on this week?', 'https://lobste.rs/'],
  ];
  return (
    <main style={{ fontFamily: 'Georgia, serif', maxWidth: 720, margin: '80px auto', padding: 24, color: '#1a1a1a' }}>
      <h1 style={{ fontSize: 44, borderBottom: '3px double #1a1a1a', paddingBottom: 8 }}>The Morning Edition</h1>
      <p style={{ fontStyle: 'italic', color: '#555' }}>Fixture homepage for screenshots: no model wrote this.</p>
      <ol>{items.map(([t, u]) => <li key={u} style={{ fontSize: 22, margin: '14px 0' }}><a href={u}>{t}</a></li>)}</ol>
    </main>
  );
}`;

/** MOCK model output: the edition JSON a model would write. Every story is made up. */
const MOCK_EDITION = {
  tagline: "MOCK EDITION · sample render from a scripted mock model, not real news",
  lead: {
    kicker: "Technology",
    title: "Rust 2.0 lands with a faster borrow checker and friendlier errors",
    url: "https://news.ycombinator.com/item?id=1",
    summary:
      "The release you have been reading about all week is out. The headline features are compile-time wins on large workspaces and error messages that suggest the fix, plus a migration tool for the 2027 edition.",
    source: "Hacker News",
    meta: "512 points · 230 comments",
  },
  stories: [
    { kicker: "Web", title: "A tour of the new Chrome DevTools performance panel", url: "https://developer.chrome.com/blog/devtools-tips", summary: "Flame charts you can annotate and share, and a live INP readout.", source: "Chrome for Developers" },
    { kicker: "Open source", title: "What are you working on this week?", url: "https://lobste.rs/s/abc123", summary: "The weekly thread: a tiny Lisp, a self-hosted photo library and a keyboard firmware.", source: "Lobsters", meta: "48 comments" },
    { kicker: "Hardware", title: "Inside the new low-power laptop chips", url: "https://arstechnica.com/gadgets/laptop-chips", summary: "Battery life claims, tested over a week of ordinary use.", source: "Ars Technica" },
    { kicker: "Your repos", title: "Two pull requests are waiting for your review", url: "https://github.com/pulls", summary: "One touches the build config; the other is a docs fix.", source: "GitHub" },
    { kicker: "Science", title: "Why the night sky is getting brighter", url: "https://arstechnica.com/science/night-sky", summary: "Satellite constellations and LED street lights, measured.", source: "Ars Technica" },
    { kicker: "Programming", title: "Show HN: a terminal UI for your browser history", url: "https://news.ycombinator.com/item?id=2", summary: "Searchable, local-only, and fast.", source: "Hacker News", meta: "201 points" },
  ],
  briefs: [
    { title: "TypeScript 6.1 beta notes", url: "https://devblogs.microsoft.com/typescript/", source: "TypeScript blog" },
    { title: "A gentle intro to CRDTs", url: "https://lobste.rs/s/def456", source: "Lobsters" },
    { title: "The case for boring technology, revisited", url: "https://news.ycombinator.com/item?id=3", source: "Hacker News" },
    { title: "Made-up link (removed by the link check)", url: "https://news.ycombinator.com/item?id=999999", source: "Hacker News" },
  ],
  yourDay: [
    { when: "Today", what: "Review the build-config PR", url: "https://github.com/pulls" },
    { when: "Fri", what: "Rust 2.0 migration notes", url: "https://news.ycombinator.com/item?id=1" },
  ],
  almanac: [
    { label: "Most-read site", value: "news.ycombinator.com" },
    { label: "Sites this week", value: "14" },
  ],
};

/** Runs the real build with the MOCK model; the fixture page holds every link the edition uses, except the made-up one. */
async function buildMockMorningTab() {
  const page = `<html><body>${[
    "https://news.ycombinator.com/item?id=1",
    "https://news.ycombinator.com/item?id=2",
    "https://news.ycombinator.com/item?id=3",
    "https://developer.chrome.com/blog/devtools-tips",
    "https://lobste.rs/s/abc123",
    "https://lobste.rs/s/def456",
    "https://arstechnica.com/gadgets/laptop-chips",
    "https://arstechnica.com/science/night-sky",
    "https://github.com/pulls",
    "https://devblogs.microsoft.com/typescript/",
  ]
    .map((u) => `<a href="${u}">${u}</a>`)
    .join("")}</body></html>`;
  const bridge: BrowserBridge = {
    getHistory: async () => ({ sites: fixtureHistory(), totalSitesSeen: fixtureHistory().length }),
    getPageHtml: async ({ urls }) => ({ pages: urls.map((url) => ({ url, finalUrl: url, title: "fixture", html: page })), failed: [] }),
  };
  const { llm } = mockClient([
    { toolCalls: [call("getHistory", {})] },
    { toolCalls: [call("getPageHtml", { urls: ["https://news.ycombinator.com/"] })] },
    { toolCalls: [call("write", { path: EDITION_PATH, content: JSON.stringify(MOCK_EDITION, null, 2) })] },
    { content: "MOCK: wrote today's edition." },
  ]);
  return runHomepageBuild({ llm, store: new MemoryStore(), bridge, now: new Date(2026, 9, 30, 7, 30) });
}

if (!existsSync(join(EXT, "manifest.json"))) {
  console.error(`No build at ${EXT}. Run: pnpm build`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "hp-shots-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--enable-unsafe-extension-debugging",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const getJson = async (path: string) => (await fetch(`http://127.0.0.1:${PORT}${path}`)).json() as Promise<any>;

async function cdp(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const waiters = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id && waiters.has(msg.id)) {
      waiters.get(msg.id)!(msg);
      waiters.delete(msg.id);
    }
  };
  const send = (method: string, params: unknown = {}) =>
    new Promise<any>((res) => {
      const n = ++id;
      waiters.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    const ex = r.result?.exceptionDetails;
    if (ex) throw new Error(ex.exception?.description ?? JSON.stringify(ex));
    return r.result?.result?.value as T;
  };
  return { send, evaluate, close: () => ws.close() };
}

const shots: string[] = [];
try {
  let version: any;
  for (let i = 0; i < 80 && !version; i++) {
    try {
      version = await getJson("/json/version");
    } catch {
      await sleep(250);
    }
  }
  if (!version) throw new Error("Chrome devtools endpoint never came up");
  const browser = await cdp(version.webSocketDebuggerUrl);
  const loaded = await browser.send("Extensions.loadUnpacked", { path: EXT });
  const extId: string | undefined = loaded.result?.id;
  if (!extId) throw new Error(`loadUnpacked failed: ${JSON.stringify(loaded)}`);
  const newtab = `chrome-extension://${extId}/newtab.html`;

  const blank = ((await getJson("/json/list")) as any[]).find((t) => t.type === "page");
  const page = await cdp(blank.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });

  const open = async (waitMs = 2000) => {
    await page.send("Page.navigate", { url: newtab });
    await sleep(waitMs);
  };
  const shot = async (name: string) => {
    await sleep(400); // let animations settle
    const r = await page.send("Page.captureScreenshot", { format: "png" });
    const file = join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(r.result.data, "base64"));
    shots.push(file);
    console.log(`📸 ${file}`);
  };
  /** Real mouse click at the centre of the first visible element whose text matches. */
  const click = async (text: string, selector = "button,[role=tab],[role=combobox]") => {
    const rect = await page.evaluate<{ x: number; y: number } | null>(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((e) => e.offsetParent !== null && e.textContent.trim().includes(${JSON.stringify(text)}));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!rect) throw new Error(`no clickable element with text "${text}"`);
    for (const type of ["mousePressed", "mouseReleased"])
      await page.send("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await sleep(500);
  };
  const store = (items: Record<string, unknown>) =>
    page.evaluate(`chrome.storage.local.set(${JSON.stringify(items)})`);

  // 1. Fresh profile: the key screen.
  await open();
  await shot("01-api-key");

  // 2. Dummy key, no homepage yet: the first-build screen.
  await store({ openRouterApiKey: DUMMY_KEY });
  await open();
  await shot("02-build-first");

  // 3. Settings dialog, one shot per tab, plus the open model picker.
  await click("Settings");
  await shot("03-settings-content");
  await click("Privacy");
  await shot("04-settings-privacy");
  await click("Model");
  await shot("05-settings-model");
  await click("Presets");
  await sleep(3000); // OpenRouter's public list (anonymous GET), or the presets fallback
  await shot("06-settings-model-picker");
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(300);
  await click("Schedule");
  await shot("07-settings-schedule");

  // 4. A saved fixture homepage under the toolbar (rendered by Sandpack in its iframe).
  await store({ homepageData: { code: HOMEPAGE, timestamp: new Date().toISOString() } });
  await open(12000);
  const frame = await page.evaluate<string>(`document.querySelector("iframe")?.src ?? ""`);
  console.log(`   homepage iframe: ${frame ? new URL(frame).origin : "(none)"}`);
  await shot("08-newtab-homepage");
  await click("Settings");
  await click("Model");
  await shot("09-settings-over-homepage");

  // 5. The default look, "The Morning Tab", from a MOCK model's edition.json.
  const mock = await buildMockMorningTab();
  console.log(`   MOCK edition: ${mock.links.length} links kept, ${mock.removedLinks.length} removed (${mock.removedLinks.map((r) => r.url).join(", ")})`);
  const editionTs = new Date(Date.now() - 60_000).toISOString();
  await store({ homepageData: { code: mock.code, timestamp: editionTs, links: mock.links, repairAttempted: true, source: "edition" } });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 2, mobile: false });
  await open(15000);
  await shot("10-morning-tab-MOCK");

  // 6. Esc in Settings with unsaved instructions: the inline confirm bar, nothing lost.
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });
  await open(12000);
  await click("Settings");
  await click("", "textarea#instructions");
  await page.send("Input.insertText", { text: "Lead with Rust and Chrome news." });
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(500);
  await shot("11-settings-esc-unsaved");

  // 7. A homepage that fails to render: the last working one stays up, with a notice.
  const broken = "import React from 'react';\nexport default function PersonalizedHomepage() {\n  throw new Error('MOCK render failure for the screenshot');\n}";
  await store({ homepageData: { code: broken, timestamp: new Date().toISOString(), links: [], repairAttempted: true, source: "fixture" } });
  await open(20000);
  await shot("12-render-fallback");

  page.close();
  browser.close();
} catch (err) {
  console.error(`\n❌ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  chrome.kill("SIGKILL");
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
console.log(`\n${shots.length} screenshot(s) in ${OUT}`);
