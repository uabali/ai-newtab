/**
 * Model configuration and storage keys. The original version provisioned a
 * hosted agent and environment here; with a local loop there is nothing to
 * provision — just a model id and an OpenAI-compatible endpoint.
 */
/**
 * Presets shown in the Settings model picker. The model field is free text: any
 * OpenRouter model id that supports tool calling works. Every id below was listed
 * with `tools` in its supported parameters on openrouter.ai/api/v1/models
 * (checked 2026-10-30). The first is the default. A model the user already saved
 * is kept as-is, even if it is not (or no longer) in this list.
 *
 * `contextLength` is the known context window in tokens (used to scale the
 * conversation budget before OpenRouter's catalog is fetched).
 */
export const MODEL_SUGGESTIONS = [
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash — cheap, 1M context", contextLength: 1_000_000 },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "NVIDIA Nemotron 3 Ultra — free, rate-limited", contextLength: 262_144 },
  { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", contextLength: 200_000 },
  { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", contextLength: 1_048_576 },
  { id: "qwen/qwen3.8-flash", label: "Qwen3.8 Flash", contextLength: 1_000_000 },
  { id: "deepseek/deepseek-v4-pro-0813", label: "DeepSeek V4 Pro 0813", contextLength: 1_000_000 },
  { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash", contextLength: 1_000_000 },
  { id: "openai/gpt-6.1-terra", label: "GPT-6.1 Terra", contextLength: 200_000 },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", contextLength: 200_000 },
  { id: "google/gemini-4-argon", label: "Gemini 4 Argon", contextLength: 1_000_000 },
] as const;

export type HomepageModel = string;

export const DEFAULT_MODEL: HomepageModel = MODEL_SUGGESTIONS[0].id;

/** Free text in, a usable id out: trimmed, never empty. */
export function normalizeModelId(raw?: string | null): HomepageModel {
  const value = (raw ?? "").trim();
  return value || DEFAULT_MODEL;
}

/** Known context window for a curated preset, or undefined for a custom id. */
export function contextLengthForModel(model: string): number | undefined {
  const id = normalizeModelId(model);
  return MODEL_SUGGESTIONS.find((m) => m.id === id)?.contextLength;
}

/**
 * Conversation char budget for compactMessages, scaled to the model's context
 * window. Leaves ~half the window for system prompt, tool schemas, and
 * max_tokens. Clamped for MV3 service-worker memory safety.
 */
export function contextBudgetCharsFor(contextLengthTokens?: number): number {
  if (contextLengthTokens == null || !Number.isFinite(contextLengthTokens) || contextLengthTokens <= 0) {
    return 120_000;
  }
  const usableTokens = Math.floor(contextLengthTokens * 0.5);
  const chars = usableTokens * 4;
  return Math.min(480_000, Math.max(80_000, chars));
}

/** Budget for a model id: preset contextLength when known, else the 32k default. */
export function contextBudgetCharsForModel(model: string): number {
  return contextBudgetCharsFor(contextLengthForModel(model));
}

export const STORAGE_KEYS = {
  /** The OpenRouter (or compatible) key. A new key name, so an old Anthropic key is never sent to OpenRouter. */
  apiKey: "openRouterApiKey",
  /** Id of a build in flight. Present after a worker kill, which is what offers "Resume". */
  activeSessionId: "activeSessionId",
  /** The conversation and workspace of the build in flight, so a resume continues where it stopped. */
  runCheckpoint: "activeRunCheckpoint",
} as const;
