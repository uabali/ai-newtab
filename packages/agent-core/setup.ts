/**
 * Model configuration and storage keys. The original version provisioned a
 * hosted agent and environment here; with a local loop there is nothing to
 * provision — just a model id and an OpenAI-compatible endpoint.
 */
/**
 * Suggestions shown in Settings. The model field is free text: any OpenRouter
 * model id that supports tool calling works. Every id below was listed with
 * `tools` in its supported parameters on openrouter.ai/api/v1/models
 * (checked 2026-10-30). The first is the default.
 */
export const MODEL_SUGGESTIONS = [
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash — default: cheap, 1M context" },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash — fast, strong at layout" },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5 — best editor, priciest" },
  { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B (free, rate-limited)" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra (free, rate-limited)" },
] as const;

export type HomepageModel = string;

export const DEFAULT_MODEL: HomepageModel = MODEL_SUGGESTIONS[0].id;

/** Free text in, a usable id out: trimmed, never empty. */
export function normalizeModelId(raw?: string | null): HomepageModel {
  const value = (raw ?? "").trim();
  return value || DEFAULT_MODEL;
}

export const STORAGE_KEYS = {
  /** The OpenRouter (or compatible) key. A new key name, so an old Anthropic key is never sent to OpenRouter. */
  apiKey: "openRouterApiKey",
  /** Id of a build in flight. Present after a worker kill, which is what offers "Resume". */
  activeSessionId: "activeSessionId",
  /** The conversation and workspace of the build in flight, so a resume continues where it stopped. */
  runCheckpoint: "activeRunCheckpoint",
} as const;
