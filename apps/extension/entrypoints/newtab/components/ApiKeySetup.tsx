import { useState } from "react";
import { btn } from "./ui";

export function ApiKeySetup({ onSave }: { onSave: (key: string) => void }) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  const valid = trimmed.length >= 20 && !/\s/.test(trimmed);
  const looksLikeOpenRouter = trimmed.startsWith("sk-or-");

  return (
    <div style={{ maxWidth: 520, margin: "12vh auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24 }}>Connect your OpenRouter API key</h1>
      <p style={{ color: "#555", lineHeight: 1.6 }}>
        The agent runs inside this extension and talks to{" "}
        <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
          OpenRouter
        </a>{" "}
        directly (or the compatible endpoint you set in Settings). Your key is stored in{" "}
        <code>chrome.storage.local</code> on this machine and is only ever sent to that endpoint.
      </p>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="sk-or-v1-..."
        autoComplete="off"
        style={{
          width: "100%",
          padding: 12,
          fontSize: 14,
          borderRadius: 4,
          border: "1px solid #ddd",
          fontFamily: "ui-monospace, monospace",
        }}
      />
      {valid && !looksLikeOpenRouter && (
        <p style={{ color: "#a60", fontSize: 12, margin: "6px 0 0" }}>
          This doesn&apos;t look like an OpenRouter key (they start with sk-or-). That&apos;s fine if you
          point the base URL in Settings at another OpenAI-compatible endpoint.
        </p>
      )}
      <button
        style={{ ...btn, marginTop: 16, opacity: valid ? 1 : 0.5 }}
        disabled={!valid}
        onClick={() => onSave(trimmed)}
      >
        Save key
      </button>
    </div>
  );
}
