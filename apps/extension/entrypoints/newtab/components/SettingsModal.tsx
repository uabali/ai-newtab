import { useState } from "react";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  MODEL_SUGGESTIONS,
  normalizeBaseUrl,
  normalizeBlockList,
  normalizeModelId,
  type HomepageModel,
} from "@homepage/agent-core";
import { btn } from "./ui";

export function SettingsModal({
  initialPrompt,
  blockedSites,
  model,
  onChangeModel,
  baseUrl,
  onChangeBaseUrl,
  onChangeApiKey,
  autoRebuild,
  onToggleAutoRebuild,
  onClose,
  onSave,
}: {
  initialPrompt: string;
  blockedSites: string[];
  model: HomepageModel;
  onChangeModel: (next: HomepageModel) => void | Promise<void>;
  baseUrl: string;
  onChangeBaseUrl: (next: string) => void | Promise<void>;
  onChangeApiKey: (next: string) => void | Promise<void>;
  autoRebuild: boolean;
  onToggleAutoRebuild: (next: boolean) => void;
  onClose: () => void;
  onSave: (prompt: string, blockedSites: string[]) => void;
}) {
  const [draft, setDraft] = useState(initialPrompt);
  const [blockedDraft, setBlockedDraft] = useState(blockedSites.join("\n"));
  const [modelDraft, setModelDraft] = useState(model);
  const [baseUrlDraft, setBaseUrlDraft] = useState(baseUrl);
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");

  const commitModel = async () => {
    const next = normalizeModelId(modelDraft);
    setModelDraft(next);
    if (next !== model) await onChangeModel(next);
  };
  /** False when the draft is not a usable endpoint; nothing is saved then. */
  const commitBaseUrl = async (): Promise<boolean> => {
    const raw = baseUrlDraft.trim();
    if (!raw) {
      setBaseUrlError(null);
      if (baseUrl) await onChangeBaseUrl("");
      return true;
    }
    try {
      const next = normalizeBaseUrl(raw);
      setBaseUrlDraft(next);
      setBaseUrlError(null);
      if (next !== baseUrl) await onChangeBaseUrl(next);
      return true;
    } catch (err) {
      setBaseUrlError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };
  const field = { padding: "6px 8px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd", flex: 1, minWidth: 0 } as const;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{ backgroundColor: "white", borderRadius: 8, padding: 24, width: "90%", maxWidth: 600, maxHeight: "90vh", overflowY: "auto" }}>
        <h2 style={{ marginTop: 0, color: "#333" }}>Customize your homepage</h2>
        <p style={{ color: "#666" }}>Standing instructions applied to every build.</p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. 'Focus on tech news and Rust releases', 'Always surface unread GitHub PRs first'"
          style={{
            width: "100%",
            minHeight: 200,
            padding: 12,
            fontSize: 14,
            borderRadius: 4,
            border: "1px solid #ddd",
            fontFamily: "inherit",
          }}
        />
        <label style={{ display: "block", marginTop: 16, color: "#333", fontSize: 14 }}>
          Sites the agent never reads
          <textarea
            value={blockedDraft}
            onChange={(e) => setBlockedDraft(e.target.value)}
            aria-describedby="blocked-sites-help"
            style={{ width: "100%", boxSizing: "border-box", minHeight: 120, marginTop: 8, padding: 12, fontSize: 14, borderRadius: 4, border: "1px solid #ddd", fontFamily: "inherit" }}
          />
        </label>
        <p id="blocked-sites-help" style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          One per line. Subdomains are included. Use *.example.com for wildcards.
        </p>
        <label
          style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, color: "#333", fontSize: 14 }}
        >
          Model
          <input
            list="model-suggestions"
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            onBlur={() => void commitModel()}
            placeholder={DEFAULT_MODEL}
            spellCheck={false}
            style={{ ...field, fontFamily: "ui-monospace, monospace" }}
          />
          <datalist id="model-suggestions">
            {MODEL_SUGGESTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </datalist>
        </label>
        <p style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          Any OpenRouter model id that supports tool calling. Suggestions:{" "}
          {MODEL_SUGGESTIONS.map((m) => m.id).join(", ")}. Models ending in <code>:free</code> cost
          nothing but are rate-limited. Takes effect from the next build.
        </p>
        <label
          style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, color: "#333", fontSize: 14 }}
        >
          Base URL
          <input
            value={baseUrlDraft}
            onChange={(e) => setBaseUrlDraft(e.target.value)}
            onBlur={() => void commitBaseUrl()}
            placeholder={DEFAULT_BASE_URL}
            spellCheck={false}
            style={{ ...field, fontFamily: "ui-monospace, monospace" }}
          />
        </label>
        <p style={{ color: baseUrlError ? "#a02620" : "#888", fontSize: 12, margin: "6px 0 0" }}>
          {baseUrlError ??
            "Optional. Leave empty for OpenRouter. Any https OpenAI-compatible endpoint works; your history and pages are sent only there."}
        </p>
        <label
          style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, color: "#333", fontSize: 14 }}
        >
          API key
          <input
            type="password"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder="Paste a new key to replace the saved one"
            autoComplete="off"
            style={{ ...field, fontFamily: "ui-monospace, monospace" }}
          />
          <button
            style={{ ...btn, padding: "6px 12px", opacity: keyDraft.trim().length >= 20 ? 1 : 0.5 }}
            disabled={keyDraft.trim().length < 20}
            onClick={() => {
              void onChangeApiKey(keyDraft.trim());
              setKeyDraft("");
            }}
          >
            Replace
          </button>
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
            color: "#333",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={autoRebuild}
            onChange={(e) => onToggleAutoRebuild(e.target.checked)}
          />
          Rebuild automatically each morning
        </label>
        <p style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          When on, the extension builds one morning edition a day in the background (first time
          Chrome is open between 5am and noon), so your next tab shows a fresh one (uses your OpenRouter key; pick a :free model to keep it at no cost).
        </p>
        <div style={{ display: "flex", gap: 12, marginTop: 20, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{ ...btn, backgroundColor: "white", color: "#333", border: "1px solid #ddd" }}
          >
            Cancel
          </button>
          <button
            onClick={async () => {
              // Persist model and endpoint before the rebuild reads settings.
              if (!(await commitBaseUrl())) return;
              await commitModel();
              onSave(draft, normalizeBlockList(blockedDraft.split("\n")));
            }}
            style={btn}
          >
            Save &amp; rebuild
          </button>
        </div>
      </div>
    </div>
  );
}
