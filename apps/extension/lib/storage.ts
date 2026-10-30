import {
  DEFAULT_BASE_URL,
  DEFAULT_BLOCKED_SITES,
  STORAGE_KEYS as AGENT_KEYS,
  normalizeModelId,
  type HomepageModel,
  type KVStore,
} from "@homepage/agent-core";

/**
 * Everything the extension persists, in one place. All of it lives in
 * chrome.storage.local — including the API key, which anyone with access to the
 * browser profile can read. Fine for a tool you run yourself; not for one you
 * distribute (see ARCHITECTURE.md → Privacy).
 */
export const KEYS = {
  ...AGENT_KEYS,
  homepage: "homepageData",
  systemPrompt: "systemPrompt",
  blockedSites: "blockedSites",
  /** Free-text OpenRouter model id. A new key: the old one held Anthropic model ids. */
  model: "openRouterModel",
  /** Optional OpenAI-compatible endpoint; empty means OpenRouter. */
  baseUrl: "openRouterBaseUrl",
  autoRebuild: "autoRebuild",
  /** ISO timestamp of the last auto-build *attempted* (success or not). */
  lastAutoBuildAttempt: "lastAutoBuildAttempt",
  /** Throttled mirror of the live build state, for tabs that open while the worker sleeps. */
  buildSnapshot: "buildSnapshot",
} as const;

export interface Homepage {
  /** The agent's raw TSX source. */
  code: string;
  /** ISO timestamp of when it was built. */
  timestamp: string;
}

export interface Settings {
  apiKey: string | null;
  systemPrompt: string;
  blockedSites: string[];
  model: HomepageModel;
  /** Empty string means the default, DEFAULT_BASE_URL. */
  baseUrl: string;
  /** Unset means on — auto-rebuild is opt-out. */
  autoRebuild: boolean;
}

/** The `KVStore` agent-core persists its agent/environment/session IDs through. */
export const extensionStore: KVStore = {
  async get<T>(key: string): Promise<T | undefined> {
    const result = await browser.storage.local.get(key);
    return result[key] as T | undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    await browser.storage.local.set({ [key]: value });
  },
  async remove(key: string): Promise<void> {
    await browser.storage.local.remove(key);
  },
};

export async function loadSettings(): Promise<Settings> {
  const s = await browser.storage.local.get([
    KEYS.apiKey,
    KEYS.systemPrompt,
    KEYS.blockedSites,
    KEYS.model,
    KEYS.baseUrl,
    KEYS.autoRebuild,
  ]);
  return {
    apiKey: (s[KEYS.apiKey] as string | undefined) ?? null,
    systemPrompt: (s[KEYS.systemPrompt] as string | undefined) ?? "",
    blockedSites: (s[KEYS.blockedSites] as string[] | undefined) ?? [...DEFAULT_BLOCKED_SITES],
    model: normalizeModelId(s[KEYS.model] as string | undefined),
    baseUrl: ((s[KEYS.baseUrl] as string | undefined) ?? "").trim(),
    autoRebuild: s[KEYS.autoRebuild] !== false,
  };
}

/** The endpoint a build will talk to. */
export function effectiveBaseUrl(settings: Pick<Settings, "baseUrl">): string {
  return settings.baseUrl || DEFAULT_BASE_URL;
}

export async function saveSetting<K extends "apiKey" | "systemPrompt" | "blockedSites" | "model" | "baseUrl" | "autoRebuild">(
  key: K,
  value: Settings[K],
): Promise<void> {
  await browser.storage.local.set({ [KEYS[key]]: value });
}

export async function loadHomepage(): Promise<Homepage | undefined> {
  return extensionStore.get<Homepage>(KEYS.homepage);
}

export async function saveHomepage(code: string): Promise<void> {
  const homepage: Homepage = { code, timestamp: new Date().toISOString() };
  await extensionStore.set(KEYS.homepage, homepage);
}
