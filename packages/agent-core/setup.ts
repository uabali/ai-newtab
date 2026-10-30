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
 */
export const MODEL_SUGGESTIONS = [
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "NVIDIA Nemotron 3 Ultra — free, rate-limited" },
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash — cheap, 1M context" },
  { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5" },
  { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash" },
  { id: "qwen/qwen3.8-flash", label: "Qwen3.8 Flash" },
  { id: "deepseek/deepseek-v4-pro-0813", label: "DeepSeek V4 Pro 0813" },
  { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "openai/gpt-6.1-terra", label: "GPT-6.1 Terra" },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5" },
  { id: "google/gemini-4-argon", label: "Gemini 4 Argon" },
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
