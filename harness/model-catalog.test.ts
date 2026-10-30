import { expect, test } from "bun:test";
import { DEFAULT_MODEL, MODEL_SUGGESTIONS, normalizeModelId } from "@homepage/agent-core";
import {
  MODEL_CATALOG_URL,
  PRESET_OPTIONS,
  catalogAllowed,
  loadModelOptions,
  mergeModelOptions,
  parseCatalog,
} from "../apps/extension/lib/model-catalog";

const PRESET_IDS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "deepseek/deepseek-v4.1-flash",
  "anthropic/claude-haiku-5.5",
  "z-ai/glm-5.3-flash",
  "qwen/qwen3.8-flash",
  "deepseek/deepseek-v4-pro-0813",
  "google/gemini-3.8-flash",
  "openai/gpt-6.1-terra",
  "anthropic/claude-sonnet-5.5",
  "google/gemini-4-argon",
];

const CATALOG = {
  data: [
    { id: "z-ai/glm-5.3-flash", name: "Z.ai: GLM 5.3 Flash", context_length: 1048576, supported_parameters: ["tools", "temperature"] },
    { id: "acme/no-tools", name: "Acme No Tools", supported_parameters: ["temperature"] },
    { id: "acme/zero-price", name: "Acme Zero", supported_parameters: ["tools"], pricing: { prompt: "0", completion: "0" } },
    { id: "beta/tooly", name: "Beta Tooly", supported_parameters: ["tools", "tool_choice"], pricing: { prompt: "0.000001", completion: "0.000002" } },
    { id: "beta/tooly", name: "Duplicate", supported_parameters: ["tools"] },
    { name: "no id", supported_parameters: ["tools"] },
    null,
  ],
};

function recordingFetch(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

test("presets are the curated list, in order, with the free Nemotron model as the default", () => {
  expect(MODEL_SUGGESTIONS.map((m): string => m.id)).toEqual(PRESET_IDS);
  expect(PRESET_OPTIONS.map((m) => m.id)).toEqual(PRESET_IDS);
  expect(DEFAULT_MODEL).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
  expect(PRESET_OPTIONS[0]!.free).toBe(true);
});

test("a model the user already saved is kept, even when it is no longer a preset", () => {
  expect(normalizeModelId("deepseek/deepseek-v4-flash")).toBe("deepseek/deepseek-v4-flash");
  expect(normalizeModelId("  my/custom-model  ")).toBe("my/custom-model");
  expect(normalizeModelId("")).toBe(DEFAULT_MODEL);
  expect(normalizeModelId(undefined)).toBe(DEFAULT_MODEL);
});

test("parseCatalog keeps only well-formed, tool-calling models, without duplicates", () => {
  const parsed = parseCatalog(CATALOG);
  expect(parsed.map((m) => m.id)).toEqual(["acme/zero-price", "beta/tooly", "z-ai/glm-5.3-flash"]);
  expect(parsed.find((m) => m.id === "acme/zero-price")!.free).toBe(true);
  expect(parsed.find((m) => m.id === "beta/tooly")!.free).toBe(false);
  expect(() => parseCatalog({ nope: true })).toThrow();
});

test("merge puts presets first and doesn't repeat them", () => {
  const merged = mergeModelOptions(parseCatalog(CATALOG));
  expect(merged.slice(0, PRESET_IDS.length).map((m) => m.id)).toEqual(PRESET_IDS);
  expect(merged.filter((m) => m.id === "z-ai/glm-5.3-flash")).toHaveLength(1);
  expect(merged.find((m) => m.id === "z-ai/glm-5.3-flash")!.contextLength).toBe(1048576);
  expect(merged.slice(PRESET_IDS.length).map((m) => m.id)).toEqual(["acme/zero-price", "beta/tooly"]);
});

test("the catalog request is anonymous: no key, no cookies, no referrer, no body", async () => {
  const { fetch, calls } = recordingFetch(() => Response.json(CATALOG));
  const r = await loadModelOptions({ baseUrl: "", fetch });
  expect(r.source).toBe("catalog");
  expect(calls).toHaveLength(1);
  const { url, init } = calls[0]!;
  expect(url).toBe(MODEL_CATALOG_URL);
  expect(url).toBe("https://openrouter.ai/api/v1/models?supported_parameters=tools");
  expect(init?.method).toBe("GET");
  expect(init?.credentials).toBe("omit");
  expect(init?.referrerPolicy).toBe("no-referrer");
  expect(init?.body).toBeUndefined();
  const headers = new Headers(init?.headers);
  expect(headers.has("authorization")).toBe(false);
  expect([...Object.keys(Object.fromEntries(Object.entries(init?.headers ?? {})))]).toEqual(["Accept"]);
});

test("falls back to the presets when the fetch fails or returns junk", async () => {
  for (const respond of [
    () => new Response("nope", { status: 503 }),
    () => Response.json({ unexpected: 1 }),
    () => {
      throw new TypeError("Failed to fetch");
    },
  ]) {
    const r = await loadModelOptions({ baseUrl: "", fetch: recordingFetch(respond).fetch });
    expect(r.source).toBe("fetch-failed");
    expect(r.error).toBeTruthy();
    expect(r.options.map((m) => m.id)).toEqual(PRESET_IDS);
  }
});

test("times out instead of hanging", async () => {
  const fetch = ((_: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof globalThis.fetch;
  const r = await loadModelOptions({ baseUrl: "", fetch, timeoutMs: 20 });
  expect(r.source).toBe("fetch-failed");
  expect(r.options.map((m) => m.id)).toEqual(PRESET_IDS);
});

test("never contacts OpenRouter's catalog when a custom endpoint is configured", async () => {
  expect(catalogAllowed("")).toBe(true);
  expect(catalogAllowed("https://openrouter.ai/api/v1/")).toBe(true);
  expect(catalogAllowed("https://openrouter.ai/api/v1/chat/completions")).toBe(true);
  expect(catalogAllowed("https://llm.example.com/v1")).toBe(false);
  expect(catalogAllowed("http://openrouter.ai/api/v1")).toBe(false);
  const { fetch, calls } = recordingFetch(() => Response.json(CATALOG));
  const r = await loadModelOptions({ baseUrl: "https://llm.example.com/v1", fetch });
  expect(r.source).toBe("presets-only");
  expect(calls).toHaveLength(0);
  expect(r.options.map((m) => m.id)).toEqual(PRESET_IDS);
});
