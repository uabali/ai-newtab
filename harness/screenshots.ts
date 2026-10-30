/**
 * Screenshots of the extension UI in headless Chrome, for review. Loads the built
 * extension into a throwaway profile, stores a DUMMY key (never a real one) and a
 * fixture homepage, and captures: the key screen, the first-build screen, each
 * Settings tab, the model picker, and the toolbar over a rendered homepage.
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
