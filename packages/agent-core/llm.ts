/**
 * A minimal client for OpenAI-compatible `/chat/completions` endpoints with tool
 * calling — OpenRouter by default. No SDK: a plain `fetch`, injectable so tests
 * (and the Bun harness) can run the whole agent loop against a mock.
 *
 * The only network destination is `baseUrl`. Nothing else in agent-core talks
 * to the network.
 */
import type { ToolInputSchema } from "./schemas";

export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: ToolInputSchema };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ChatTool[];
  /** Omitted unless set: some providers reject a value above the model's own cap. */
  maxTokens?: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface ChatClient {
  complete(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
}

export interface ChatClientOptions {
  apiKey: string;
  /** e.g. https://openrouter.ai/api/v1. `/chat/completions` is appended. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Retries for 408/429/5xx and dropped connections. Default 3. */
  maxRetries?: number;
  /** First backoff step; doubles per attempt. Default 1000ms. */
  retryDelayMs?: number;
}

/**
 * Trim, default, drop trailing slashes and a pasted `/chat/completions`, and
 * insist on https so the key and page content never travel in the clear.
 */
export function normalizeBaseUrl(raw?: string | null): string {
  let value = (raw ?? "").trim();
  if (!value) return DEFAULT_BASE_URL;
  value = value.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid base URL: ${value}`);
  }
  if (url.protocol !== "https:") throw new Error(`Base URL must use https: ${value}`);
  if (url.username || url.password) throw new Error("Base URL must not contain credentials");
  return value;
}

function providerName(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "openrouter.ai" ? "OpenRouter" : host;
  } catch {
    return "Model API";
  }
}

function abortError(): Error {
  return new Error("aborted");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);

class HttpError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfterMs?: number) {
    super(message);
  }
}

function errorText(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  }
  return "";
}

/** Some providers return arguments as an object, or calls without an id. Normalize both. */
function normalizeToolCalls(raw: unknown): ChatToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((call, i): ChatToolCall[] => {
    const fn = call?.function;
    if (!fn?.name) return [];
    const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    return [{ id: String(call.id || `call_${Date.now().toString(36)}_${i}`), type: "function", function: { name: String(fn.name), arguments: args || "{}" } }];
  });
}

export function createChatClient(opts: ChatClientOptions): ChatClient {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const endpoint = `${baseUrl}/chat/completions`;
  const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const maxRetries = opts.maxRetries ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  const provider = providerName(baseUrl);

  async function once(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      tool_choice: "auto",
    };
    if (request.maxTokens) body.max_tokens = request.maxTokens;

    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
          // OpenRouter's optional app attribution headers. No user data.
          "HTTP-Referer": "https://github.com/uabali/ai-newtab",
          "X-Title": "AI Homepage",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw abortError();
      throw new HttpError(`${provider} request failed: ${String(err)}`, true);
    }

    const raw = await response.text();
    let json: any = undefined;
    try {
      json = raw ? JSON.parse(raw) : undefined;
    } catch {
      // Non-JSON (an HTML error page from a proxy, say): reported below.
    }

    if (!response.ok) {
      const detail = errorText(json) || raw.slice(0, 300);
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new HttpError(
        `${provider} request failed (${response.status}): ${detail}`,
        RETRYABLE_STATUS.has(response.status),
        Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : undefined,
      );
    }
    if (json === undefined) throw new HttpError(`${provider} returned a non-JSON response: ${raw.slice(0, 200)}`, true);
    // OpenRouter can answer 200 with an error body when an upstream provider fails.
    const inlineError = errorText(json);
    if (inlineError) throw new HttpError(`${provider} error: ${inlineError}`, true);

    const choice = json?.choices?.[0];
    if (!choice?.message) throw new HttpError(`${provider} returned no choices`, true);
    if (choice.error) throw new HttpError(`${provider} error: ${errorText(choice) || JSON.stringify(choice.error)}`, true);

    const content = typeof choice.message.content === "string" ? choice.message.content : null;
    return {
      content,
      toolCalls: normalizeToolCalls(choice.message.tool_calls),
      finishReason: choice.finish_reason ?? null,
      usage: json.usage
        ? { promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens }
        : undefined,
    };
  }

  return {
    async complete(request, signal) {
      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) throw abortError();
        try {
          return await once(request, signal);
        } catch (err) {
          if (signal?.aborted) throw abortError();
          if (!(err instanceof HttpError) || !err.retryable || attempt >= maxRetries) throw err;
          await sleep(err.retryAfterMs ?? retryDelayMs * 2 ** attempt, signal);
        }
      }
    },
  };
}
