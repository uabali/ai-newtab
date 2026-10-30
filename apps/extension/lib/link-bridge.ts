import { linkKey } from "@homepage/agent-core";

/**
 * The bridge between the generated homepage (running in Sandpack's cross-origin,
 * sandboxed iframe) and the new-tab page.
 *
 * Why: a plain <a href> inside that iframe navigates the iframe itself, which most
 * sites refuse to be framed in ("refused to connect"), and target=_blank popups
 * inherit the sandbox. So the iframe never navigates: a small script injected
 * ahead of the component catches link clicks (and window.open) and posts the URL
 * to the new-tab page, which opens it with chrome.tabs after checking it again.
 *
 * The same script reports whether the component rendered, so the page can fall
 * back to the last working homepage and ask for one repair.
 */

export const BRIDGE_MSG = {
  open: "ai-homepage:open-link",
  rendered: "ai-homepage:rendered",
  error: "ai-homepage:render-error",
} as const;

/** current: this tab (plain click). background: a new tab behind (Ctrl/⌘/middle click). foreground: window.open. */
export type OpenDisposition = "current" | "background" | "foreground";

/**
 * agent-core's `linkKey` (no base) as plain JS source, because it runs inside the
 * iframe: absolute http(s), no credentials, no fragment, no trailing slash on a
 * non-root path. A test keeps both copies in agreement. (No eval here: the
 * extension's CSP forbids it, so the new-tab page uses agent-core's copy.)
 */
export const KEY_SOURCE = `function key(raw) {
  if (typeof raw !== "string") return null;
  var s = raw.trim();
  if (!s || !/^https?:\\/\\//i.test(s)) return null;
  var u;
  try { u = new URL(s); } catch (e) { return null; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname || u.username || u.password) return null;
  u.hash = "";
  if (u.pathname.length > 1 && u.pathname.charAt(u.pathname.length - 1) === "/") u.pathname = u.pathname.slice(0, -1);
  return u.href;
}`;

/**
 * Source of /bridge.js, imported first by the Sandpack entry. `allow` is the
 * homepage's link allowlist; null (a homepage saved before link checks) allows
 * any absolute http(s) link.
 */
export function bridgeScript(allow: string[] | null): string {
  return `(function (win, doc) {
  var MSG = ${JSON.stringify(BRIDGE_MSG)};
  var ALLOW = ${allow ? `new Set(${JSON.stringify(allow)})` : "null"};
  ${KEY_SOURCE.replace(/\n/g, "\n  ")}
  function allowed(raw) {
    var k = key(raw);
    return k && (!ALLOW || ALLOW.has(k)) ? raw.trim() : null;
  }
  function post(msg) {
    try { win.parent.postMessage(msg, "*"); } catch (e) {}
  }
  function open(raw, disposition) {
    var url = allowed(raw);
    if (url) post({ type: MSG.open, url: url, disposition: disposition });
  }
  function anchor(e) {
    var t = e.target;
    if (t && t.nodeType !== 1) t = t.parentElement;
    return t && t.closest ? t.closest("a") : null;
  }
  // Never let the iframe navigate itself; hand allowed links to the new-tab page.
  doc.addEventListener("click", function (e) {
    var a = anchor(e);
    if (!a) return;
    e.preventDefault();
    if (e.button !== 0) return;
    open(a.getAttribute("href"), e.ctrlKey || e.metaKey || e.shiftKey ? "background" : "current");
  }, true);
  doc.addEventListener("auxclick", function (e) {
    var a = anchor(e);
    if (!a) return;
    e.preventDefault();
    if (e.button === 1) open(a.getAttribute("href"), "background");
  }, true);
  win.open = function (url) {
    open(typeof url === "string" ? url : url && url.href, "foreground");
    return null;
  };
  // Unlink anything outside the allowlist, including links built at runtime.
  function scrub(root) {
    if (!root || !root.querySelectorAll) return;
    var list = root.querySelectorAll("a[href]");
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!allowed(a.getAttribute("href"))) {
        a.removeAttribute("href");
        a.setAttribute("data-unlinked", "");
      }
    }
  }
  function watch() {
    scrub(doc);
    if (win.MutationObserver) {
      new win.MutationObserver(function () { scrub(doc); }).observe(doc.documentElement, {
        subtree: true, childList: true, attributes: true, attributeFilter: ["href"]
      });
    }
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", watch); else watch();
  // Render status, reported once.
  var reported = false;
  function report(ok, message) {
    if (reported) return;
    reported = true;
    post(ok ? { type: MSG.rendered } : { type: MSG.error, message: String(message || "Unknown error").slice(0, 1000) });
  }
  win.addEventListener("error", function (e) { report(false, (e && (e.message || (e.error && e.error.message))) || "Script error"); });
  win.addEventListener("unhandledrejection", function (e) { report(false, "Unhandled rejection: " + (e && e.reason && e.reason.message || e.reason)); });
  win.__aiHomepage = {
    rendered: function () {
      var root = doc.getElementById("root");
      var empty = !root || (!root.textContent.trim() && !root.querySelector("img,svg,canvas,video"));
      report(!empty, "The component rendered an empty page.");
    },
    failed: function (message) { report(false, message); },
    scrub: scrub,
  };
})(window, document);
`;
}

/** The Sandpack entry: bridge first, then the component inside an error boundary. */
export const BRIDGE_INDEX_JS = `import "./bridge.js";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

class Guard extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    window.__aiHomepage.failed((error && error.message) || String(error));
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function Ready({ children }) {
  React.useEffect(() => {
    const t = setTimeout(() => window.__aiHomepage.rendered(), 300);
    return () => clearTimeout(t);
  }, []);
  return children;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <Guard>
    <Ready>
      <App />
    </Ready>
  </Guard>
);`;

export interface BridgeEvent {
  data: unknown;
  source: unknown;
}

export interface BridgeDeps {
  /** The preview iframe's window; messages from anything else are ignored. */
  frame: unknown;
  /** The homepage's link allowlist; null allows any absolute http(s) link. */
  allow: ReadonlySet<string> | null;
  /** Whether the page has transient user activation (a click just happened). Defaults to true when unknown. */
  userActive?: () => boolean;
  openTab(url: string, disposition: OpenDisposition): void | Promise<void>;
  onRendered?(): void;
  onRenderError?(message: string): void;
}

export type BridgeOutcome = "ignored" | "opened" | "refused" | "rendered" | "render-error";

/**
 * Handle one message from the preview iframe. Pure apart from the callbacks, so
 * it is unit-tested. The iframe runs model-written code, so nothing it sends is
 * trusted: a link must be absolute http(s), on the allowlist, and follow a click.
 */
export function handleBridgeMessage(event: BridgeEvent, deps: BridgeDeps): BridgeOutcome {
  if (!deps.frame || event.source !== deps.frame) return "ignored";
  const data = event.data as { type?: unknown; url?: unknown; disposition?: unknown; message?: unknown } | null;
  if (!data || typeof data !== "object") return "ignored";
  switch (data.type) {
    case BRIDGE_MSG.open: {
      const k = linkKey(data.url);
      if (!k || (deps.allow && !deps.allow.has(k))) return "refused";
      if (deps.userActive && !deps.userActive()) return "refused";
      const disposition: OpenDisposition =
        data.disposition === "background" || data.disposition === "foreground" ? data.disposition : "current";
      void deps.openTab(new URL(String(data.url).trim()).href, disposition);
      return "opened";
    }
    case BRIDGE_MSG.rendered:
      deps.onRendered?.();
      return "rendered";
    case BRIDGE_MSG.error:
      deps.onRenderError?.(typeof data.message === "string" ? data.message.slice(0, 1000) : "Unknown render error");
      return "render-error";
    default:
      return "ignored";
  }
}

/** Open a link the way a new-tab page should: this tab, or a new one. */
export async function openWithTabs(
  tabs: {
    update(props: { url: string }): Promise<unknown>;
    create(props: { url: string; active: boolean }): Promise<unknown>;
  },
  url: string,
  disposition: OpenDisposition,
): Promise<void> {
  if (disposition === "current") await tabs.update({ url });
  else await tabs.create({ url, active: disposition === "foreground" });
}
