import { useEffect, useMemo, useRef } from "react";
import { SandpackLayout, SandpackPreview, SandpackProvider, useSandpack } from "@codesandbox/sandpack-react";
import { BRIDGE_INDEX_JS, bridgeScript, handleBridgeMessage, openWithTabs } from "@/lib/link-bridge";

const INDEX_HTML = `<!DOCTYPE html>
<html><head><title>My Personalized Homepage</title></head>
<body><div id="root"></div></body></html>`;

/** Compile errors never reach the bridge script (nothing runs), so ask Sandpack. */
function CompileErrorWatcher({ onError }: { onError?: (message: string) => void }) {
  const { listen } = useSandpack();
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(
    () =>
      listen((msg) => {
        const m = msg as { type?: string; action?: string; title?: string; message?: string; compilatonError?: boolean };
        if (m.type === "action" && m.action === "show-error") onErrorRef.current?.(`${m.title ?? "Error"}: ${m.message ?? ""}`.trim());
        else if (m.type === "done" && m.compilatonError) onErrorRef.current?.("The component failed to compile.");
      }),
    [listen],
  );
  return null;
}

/**
 * Renders the agent's component in a Sandpack iframe. The code is
 * model-generated, so it runs sandboxed rather than in the extension's own page.
 * A bridge script injected ahead of it hands link clicks to this page (opened
 * with chrome.tabs after an allowlist check) and reports whether it rendered.
 */
export function HomepagePreview({
  code,
  version,
  links,
  onRendered,
  onRenderError,
}: {
  code: string;
  /** Identifies the homepage version; a new one gets a fresh iframe. */
  version: string;
  /** The homepage's link allowlist; undefined (older homepages) allows any absolute http(s) link. */
  links?: string[];
  onRendered?: () => void;
  onRenderError?: (message: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const files = useMemo(
    () => ({
      "/App.js": { code },
      "/index.js": { code: BRIDGE_INDEX_JS },
      "/bridge.js": { code: bridgeScript(links ?? null) },
      "/index.html": { code: INDEX_HTML },
    }),
    [code, links],
  );

  useEffect(() => {
    const allow = links ? new Set(links) : null;
    const onMessage = (event: MessageEvent) => {
      handleBridgeMessage(event, {
        frame: container.current?.querySelector("iframe")?.contentWindow ?? null,
        allow,
        // A click in the iframe activates this page too; a message without one is not a click.
        userActive: () => navigator.userActivation?.isActive ?? true,
        openTab: (url, disposition) => openWithTabs(browser.tabs, url, disposition),
        onRendered,
        onRenderError,
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [links, onRendered, onRenderError]);

  return (
    <div ref={container} style={{ height: "100vh", width: "100vw" }}>
      <SandpackProvider key={version} files={files} template="react" options={{ autorun: true }}>
        <SandpackLayout style={{ height: "100vh", width: "100vw" }}>
          <SandpackPreview style={{ height: "100%" }} />
        </SandpackLayout>
        <CompileErrorWatcher onError={onRenderError} />
      </SandpackProvider>
    </div>
  );
}
