/**
 * Loads the built extension into a real (headless) Chrome and verifies the half
 * of the system the Bun harness can't reach:
 *
 *   1. the MV3 service worker registers,
 *   2. the new-tab override renders (the API-key screen on a fresh profile),
 *   3. the worker answers `subscribe` on the build port with a snapshot,
 *   4. `startBuild` with no API key fails cleanly with an error message,
 *   5. `chrome.history` is readable, so the `history` permission is real,
 *   6. a generated homepage reports that it rendered, and its links open through
 *      the bridge: an allowlisted link opens with chrome.tabs (⌘-click: new tab;
 *      click: this tab), a link outside the allowlist does nothing,
 *   7. a homepage that throws falls back to the last working one, and with none
 *      shows an error card instead of a blank page.
 *
 * No model calls are made (a DUMMY key is stored only so the homepage view shows;
 * the fixtures are marked as already repaired, so no repair is requested). Steps
 * 6–7 need the network: Sandpack's hosted bundler, and example.com as the link. Chrome 136+ ignores `--load-extension`, so the
 * extension is loaded over CDP's Extensions domain instead.
 *
 * Run: pnpm build && pnpm extension:test
 * Set CHROME_PATH if Chrome isn't at the default macOS location.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EXT = join(import.meta.dir, "../apps/extension/.output/chrome-mv3");
const PORT = 9333;

if (!existsSync(join(EXT, "manifest.json"))) {
  console.error(`No build at ${EXT}. Run: pnpm build`);
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "hp-ext-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label: string, pass: boolean, extra?: string) => {
  console.log(`${pass ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!pass) failures++;
};

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--enable-unsafe-extension-debugging", // required for the CDP Extensions domain
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function getJson(path: string) {
  return (await fetch(`http://127.0.0.1:${PORT}${path}`)).json() as Promise<any>;
}

/** Minimal CDP client over a target's websocket. */
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
  return {
    send,
    close: () => ws.close(),
    async evaluate<T>(expression: string): Promise<T> {
      const r = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      const ex = r.result?.exceptionDetails;
      if (ex) throw new Error(ex.exception?.description ?? JSON.stringify(ex));
      return r.result?.result?.value as T;
    },
  };
}

try {
  let version: any;
  for (let i = 0; i < 80; i++) {
    try {
      version = await getJson("/json/version");
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!version) throw new Error("Chrome devtools endpoint never came up");
  console.log(`   ${version.Browser}\n`);

  // ---- load the unpacked extension ----------------------------------------
  const browser = await cdp(version.webSocketDebuggerUrl);
  const loaded = await browser.send("Extensions.loadUnpacked", { path: EXT });
  const extId: string | undefined = loaded.result?.id;
  if (!extId) throw new Error(`loadUnpacked failed: ${JSON.stringify(loaded)}`);
  console.log(`   extension id: ${extId}\n`);

  // ---- 1. service worker ---------------------------------------------------
  let sw: any;
  for (let i = 0; i < 40 && !sw; i++) {
    const targets: any[] = await getJson("/json/list");
    sw = targets.find((t) => t.type === "service_worker" && t.url.includes(extId));
    if (!sw) await sleep(250);
  }
  check("MV3 service worker registered", Boolean(sw), sw?.url.split("/").pop());

  // ---- 2. new-tab override renders ----------------------------------------
  const targets: any[] = await getJson("/json/list");
  const blank = targets.find((t) => t.type === "page");
  if (!blank) throw new Error("no page target to navigate");

  const page = await cdp(blank.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  const nav = await page.send("Page.navigate", { url: `chrome-extension://${extId}/newtab.html` });
  if (nav.result?.errorText) throw new Error(`navigate failed: ${nav.result.errorText}`);

  let href = "";
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      href = await page.evaluate<string>("location.href");
      const ready = await page.evaluate<string>("document.readyState");
      if (href.startsWith("chrome-extension://") && ready === "complete") break;
    } catch {
      /* navigation in flight */
    }
  }
  check("new-tab override loads", href.startsWith("chrome-extension://"), href);

  await sleep(2500); // let React mount
  const bodyText = await page.evaluate<string>("document.body.innerText");
  check(
    "renders the API-key setup screen",
    /Connect your OpenRouter API key/i.test(bodyText),
    bodyText.split("\n").filter(Boolean)[0]?.slice(0, 50),
  );

  // Open a build port, send one message, and collect replies for a moment.
  const talk = (msg: object, waitMs: number) =>
    page.evaluate<string>(`
      new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: "homepage-agent" });
        const replies = [];
        port.onMessage.addListener((m) => replies.push(m));
        port.postMessage(${JSON.stringify(msg)});
        setTimeout(() => { port.disconnect(); resolve(JSON.stringify(replies)); }, ${waitMs});
      })
    `).then((raw) => JSON.parse(raw) as any[]);

  // ---- 3. subscribe → snapshot ---------------------------------------------
  const subscribed = await talk({ kind: "subscribe" }, 1500);
  const snapshot = subscribed.find((m) => m.kind === "snapshot");
  check(
    "worker answers subscribe with a build snapshot",
    Boolean(snapshot) && snapshot.state.running === false,
    JSON.stringify(subscribed[0])?.slice(0, 80),
  );

  // ---- 4. startBuild without a key fails cleanly ----------------------------
  const started = await talk({ kind: "startBuild" }, 3000);
  const error = started.find((m) => m.kind === "error");
  check("startBuild with no API key reports an error", /API key/i.test(error?.message ?? ""), error?.message);

  // ---- 5. chrome.history is readable ---------------------------------------
  const domains = await page.evaluate<string[]>(`
    (async () => {
      const seed = [
        "https://news.ycombinator.com/",
        "https://news.ycombinator.com/item?id=1",
        "https://lobste.rs/",
        "https://arstechnica.com/",
      ];
      for (const url of seed) await chrome.history.addUrl({ url });
      await new Promise((r) => setTimeout(r, 500));
      const items = await chrome.history.search({ text: "", startTime: 0, maxResults: 100 });
      return [...new Set(items.map((i) => new URL(i.url).hostname))];
    })()
  `);
  check(
    "chrome.history is readable (seeded domains returned)",
    domains.includes("news.ycombinator.com"),
    domains.join(", "),
  );

  // ---- 6. generated homepage: render report and links ------------------------
  const DUMMY_KEY = "sk-or-v1-dummy-test-key-not-real-0000";
  const LINKS_HOMEPAGE = `import React from 'react';
export default function PersonalizedHomepage() {
  const s = { position: 'fixed', left: 40, width: 640, height: 90, display: 'block', fontSize: 40, background: '#eee' };
  return (
    <div>
      <a href="https://example.com/" style={{ ...s, top: 140 }}>Allowed link</a>
      <a href="https://made.up.invalid/" style={{ ...s, top: 300 }}>Not on the allowlist</a>
    </div>
  );
}`;
  const t1 = new Date(Date.now() - 60_000).toISOString();
  const setStore = (items: Record<string, unknown>) => page.evaluate(`chrome.storage.local.set(${JSON.stringify(items)})`);
  const getStore = <T>(key: string) => page.evaluate<T>(`chrome.storage.local.get(${JSON.stringify(key)}).then((r) => r[${JSON.stringify(key)}] ?? null)`);
  const waitFor = async (what: () => Promise<boolean>, ms: number) => {
    for (let t = 0; t < ms; t += 500) {
      try {
        if (await what()) return true;
      } catch {
        /* page navigating */
      }
      await sleep(500);
    }
    return false;
  };
  const openNewtab = async () => {
    await page.send("Page.navigate", { url: `chrome-extension://${extId}/newtab.html` });
    await sleep(1500);
  };
  const tabUrl = async () => ((await getJson("/json/list")) as any[]).find((t) => t.id === blank.id)?.url ?? "";
  const pageTargets = async () => ((await getJson("/json/list")) as any[]).filter((t) => t.type === "page").map((t) => t.url as string);
  const mouse = async (x: number, y: number, modifiers = 0) => {
    for (const type of ["mousePressed", "mouseReleased"])
      await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, modifiers });
  };

  await setStore({
    openRouterApiKey: DUMMY_KEY,
    homepageData: { code: LINKS_HOMEPAGE, timestamp: t1, links: ["https://example.com/"], repairAttempted: true, source: "fixture" },
  });
  await openNewtab();
  const rendered = await waitFor(async () => (await getStore<any>("lastGoodHomepage"))?.timestamp === t1, 45_000);
  check("generated homepage renders and reports it (saved as last working version)", rendered);

  const frame = await page.evaluate<{ x: number; y: number } | null>(
    `(() => { const r = document.querySelector("iframe")?.getBoundingClientRect(); return r ? { x: r.x, y: r.y } : null; })()`,
  );
  if (!frame) throw new Error("no homepage iframe");
  await sleep(1000);

  await mouse(frame.x + 300, frame.y + 345);
  await sleep(1500);
  const afterBad = await pageTargets();
  check(
    "a link outside the allowlist opens nothing",
    (await tabUrl()).startsWith("chrome-extension://") && !afterBad.some((u) => u.includes("made.up.invalid")),
  );

  await mouse(frame.x + 300, frame.y + 185, 4 /* Meta */);
  const opened = await waitFor(async () => (await pageTargets()).some((u) => u.startsWith("https://example.com")), 8000);
  check("⌘-click on an allowed link opens it in a new tab (chrome.tabs.create)", opened && (await tabUrl()).startsWith("chrome-extension://"));

  await mouse(frame.x + 300, frame.y + 185);
  const navigated = await waitFor(async () => (await tabUrl()).startsWith("https://example.com"), 8000);
  check("click on an allowed link opens it in this tab (chrome.tabs.update)", navigated, await tabUrl());

  // ---- 7. render failure: fallback, then error card ---------------------------
  const BROKEN = `import React from 'react';
export default function PersonalizedHomepage() {
  throw new Error("fixture render failure");
}`;
  await openNewtab();
  await setStore({
    homepageData: { code: BROKEN, timestamp: new Date().toISOString(), links: [], repairAttempted: true, source: "fixture" },
  });
  await openNewtab();
  const fellBack = await waitFor(
    async () => /Showing your last working homepage/.test(await page.evaluate<string>("document.body.innerText")),
    45_000,
  );
  check("a homepage that throws falls back to the last working one", fellBack);

  await page.evaluate(`chrome.storage.local.remove("lastGoodHomepage")`);
  await openNewtab();
  const card = await waitFor(
    async () => /failed to render/i.test(await page.evaluate<string>("document.body.innerText")),
    45_000,
  );
  check("with no working version it shows an error card, not a blank page", card);

  page.close();
  browser.close();
} catch (err) {
  console.error(`\n❌ ${err instanceof Error ? err.message : err}`);
  failures++;
} finally {
  chrome.kill("SIGKILL");
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}

console.log(
  `\n${failures === 0 ? "\x1b[32mEXTENSION VERIFIED\x1b[0m" : `\x1b[31m${failures} check(s) failed\x1b[0m`}`,
);
process.exit(failures === 0 ? 0 : 1);
