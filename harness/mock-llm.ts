/**
 * A scripted stand-in for an OpenAI-compatible /chat/completions endpoint.
 * Tests hand `createChatClient` this `fetch`, so the real client code (request
 * shape, headers, parsing, retries) runs — only the network is fake.
 */
import { createChatClient, type ChatClient, type KVStore } from "@homepage/agent-core";

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** One scripted reply: assistant content and/or tool calls, or a raw Response. */
export type Turn =
  | { content?: string | null; toolCalls?: Array<{ name: string; args: unknown; id?: string }>; finishReason?: string }
  | ((req: RecordedRequest) => Response | Promise<Response>);

export function call(name: string, args: unknown, id?: string) {
  return { name, args, id };
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function mockFetch(turns: Turn[]) {
  const requests: RecordedRequest[] = [];
  let i = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: RecordedRequest = {
      url: String(input),
      headers: headersToObject(new Headers(init?.headers)),
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    requests.push(req);
    const turn = turns[i++];
    if (!turn) throw new Error(`mock fetch: no scripted turn #${i}`);
    if (typeof turn === "function") return turn(req);
    const tool_calls = turn.toolCalls?.map((c, n) => ({
      id: c.id ?? `call_${i}_${n}`,
      type: "function",
      function: { name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args) },
    }));
    return new Response(
      JSON.stringify({
        id: `gen-${i}`,
        choices: [
          {
            index: 0,
            finish_reason: turn.finishReason ?? (tool_calls?.length ? "tool_calls" : "stop"),
            message: { role: "assistant", content: turn.content ?? null, ...(tool_calls?.length ? { tool_calls } : {}) },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return { fetch, requests, remaining: () => turns.length - i };
}

export function mockClient(turns: Turn[], opts: { baseUrl?: string } = {}): { llm: ChatClient; requests: RecordedRequest[]; remaining: () => number } {
  const { fetch, requests, remaining } = mockFetch(turns);
  return { llm: createChatClient({ apiKey: "test-key-not-real", baseUrl: opts.baseUrl, fetch, retryDelayMs: 1 }), requests, remaining };
}

export class MemoryStore implements KVStore {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string) {
    const v = this.data.get(key);
    return (v === undefined ? undefined : structuredClone(v)) as T | undefined;
  }
  async set(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async remove(key: string) {
    this.data.delete(key);
  }
}

export const COMPONENT = `import React from 'react';
export default function PersonalizedHomepage() {
  return <a href="https://news.ycombinator.com/item?id=1">Story</a>;
}`;

/** Every tool message the model was sent, by tool_call_id, from the last request. */
export function toolResults(req: RecordedRequest): Record<string, string> {
  return Object.fromEntries(
    (req.body.messages as any[]).filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m.content]),
  );
}
