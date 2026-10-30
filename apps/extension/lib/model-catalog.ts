import { DEFAULT_BASE_URL, MODEL_SUGGESTIONS, normalizeBaseUrl } from "@homepage/agent-core";

/**
 * The model picker's option list: the curated presets, optionally extended with
 * every tool-calling model on OpenRouter's public catalog.
 *
 * Privacy: the catalog request is a plain anonymous GET. It carries no API key,
 * no cookies (`credentials: "omit"`), no referrer and no user data — no history,
 * no pages, no settings. It is only made when the configured endpoint is
 * OpenRouter itself, and only when the user opens the picker. If it fails for any
 * reason the presets are used on their own.
 */

export const MODEL_CATALOG_URL = `${DEFAULT_BASE_URL}/models?supported_parameters=tools`;

export interface ModelOption {
  id: string;
  label: string;
  /** True for the curated presets shown first. */
  preset: boolean;
  /** Ends in `:free` (or OpenRouter reports zero prompt and completion prices). */
  free: boolean;
  contextLength?: number;
}

export const PRESET_OPTIONS: ModelOption[] = MODEL_SUGGESTIONS.map((m) => ({
  id: m.id,
  label: m.label,
  preset: true,
  free: m.id.endsWith(":free"),
}));

interface CatalogEntry {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  supported_parameters?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
}

/** Whether the catalog may be fetched for this base URL setting (empty = OpenRouter). */
export function catalogAllowed(baseUrl: string): boolean {
  if (!baseUrl.trim()) return true;
  try {
    return normalizeBaseUrl(baseUrl) === DEFAULT_BASE_URL;
  } catch {
    return false;
  }
}

/** Keeps only well-formed entries that list `tools` in their supported parameters. */
export function parseCatalog(body: unknown): ModelOption[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("Unexpected model list format");
  const out: ModelOption[] = [];
  const seen = new Set<string>();
  for (const raw of data as CatalogEntry[]) {
    if (!raw || typeof raw.id !== "string" || !raw.id.trim() || seen.has(raw.id)) continue;
    const params = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
    if (!params.includes("tools")) continue;
    seen.add(raw.id);
    const zero = (v: unknown) => v !== undefined && Number(v) === 0;
    out.push({
      id: raw.id,
      label: typeof raw.name === "string" && raw.name.trim() ? raw.name : raw.id,
      preset: false,
      free: raw.id.endsWith(":free") || (zero(raw.pricing?.prompt) && zero(raw.pricing?.completion)),
      contextLength: typeof raw.context_length === "number" ? raw.context_length : undefined,
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** Presets first, in their curated order, then the rest of the catalog without duplicates. */
export function mergeModelOptions(catalog: ModelOption[]): ModelOption[] {
  const presetIds = new Set(PRESET_OPTIONS.map((p) => p.id));
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const presets = PRESET_OPTIONS.map((p) => ({ ...p, contextLength: byId.get(p.id)?.contextLength }));
  return [...presets, ...catalog.filter((m) => !presetIds.has(m.id))];
}

export interface CatalogResult {
  options: ModelOption[];
  /** "catalog" when OpenRouter's list was loaded, otherwise the reason presets are shown alone. */
  source: "catalog" | "presets-only" | "fetch-failed";
  error?: string;
}

/** Fetches the public catalog, falling back to the presets on any failure. Never throws. */
export async function loadModelOptions(opts: {
  baseUrl: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<CatalogResult> {
  if (!catalogAllowed(opts.baseUrl)) return { options: mergeModelOptions([]), source: "presets-only" };
  const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), opts.timeoutMs ?? 8000);
  const onAbort = () => timeout.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await doFetch(MODEL_CATALOG_URL, {
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "default",
      headers: { Accept: "application/json" },
      signal: timeout.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { options: mergeModelOptions(parseCatalog(await res.json())), source: "catalog" };
  } catch (err) {
    return {
      options: mergeModelOptions([]),
      source: "fetch-failed",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
