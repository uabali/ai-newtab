/**
 * The agent loop, run locally by whichever host imports it (the extension's
 * service worker, or the Bun harness). It talks to one OpenAI-compatible
 * `/chat/completions` endpoint (OpenRouter by default) and executes every tool
 * itself:
 *
 *   getHistory, getPageHtml  → the host's BrowserBridge (chrome.history / tabs)
 *   read, grep, glob, write  → an in-memory Workspace holding the scraped pages
 *
 * The output contract is unchanged from the hosted version: a
 * HomepageBuildResult whose `code` is the TSX the model wrote to OUTPUT_PATH.
 */
import { buildHistoryDigest, slugifyUrl } from "./history-digest";
import type { ChatClient, ChatMessage, ChatTool, ChatToolCall } from "./llm";
import { checkComponent } from "./check-component";
import { SeenUrls, linkKey, literalLinks, validateHomepageLinks, type RemovedLink } from "./links";
import { EDITION_PATH, parseEdition, renderMorningTab } from "./morning-tab";
import {
  HOMEPAGE_SYSTEM_PROMPT,
  OUTPUT_PATH,
  REPAIR_SYSTEM_PROMPT,
  buildKickoffMessage,
  buildRepairMessage,
} from "./prompt";
import { DEFAULT_BLOCKED_SITES, isAllowedUrl, isBlocked, isPrivateAddress, normalizeBlockList } from "./site-filter";
import {
  DEFAULTS,
  GET_HISTORY_SCHEMA,
  GET_PAGE_HTML_SCHEMA,
  GLOB_SCHEMA,
  GREP_SCHEMA,
  READ_SCHEMA,
  WRITE_SCHEMA,
} from "./schemas";
import { DEFAULT_MODEL, STORAGE_KEYS, normalizeModelId, type HomepageModel } from "./setup";
import type {
  BrowserBridge,
  GetHistoryResult,
  GetPageHtmlResult,
  HomepageBuildResult,
  KVStore,
  PageRef,
  RunCallbacks,
  RunPhase,
} from "./types";
import { OUTPUTS_DIR, Workspace } from "./workspace";

/** Callbacks with the optionality resolved, so call sites don't repeat `?.`. */
interface Emit {
  phase(phase: RunPhase, detail?: string): void;
  text(chunk: string): void;
  log(line: string): void;
}

/** Defaults sized so a 32k-token model still fits a whole build. */
export const LOOP_DEFAULTS = {
  /** Model turns before the build gives up. */
  maxSteps: 40,
  /** Each tool result is cut to this many characters (~3k tokens). */
  maxToolResultChars: 12_000,
  /** When the conversation grows past this, the oldest tool results are elided (~30k tokens). */
  contextBudgetChars: 120_000,
  /** Times the model is reminded to call write when it stops without a deliverable. */
  maxNudges: 2,
  /** Extra model turns for the one repair attempt after a deliverable fails its check. */
  repairSteps: 6,
} as const;

export interface RunOptions {
  /** The OpenAI-compatible endpoint. See `createChatClient`. */
  llm: ChatClient;
  bridge: BrowserBridge;
  store: KVStore;
  userSystemPrompt?: string;
  /**
   * Hosts the tools must never read. A getter is re-read before every tool call,
   * so a list saved mid-build applies to the rest of that build.
   */
  blockedSites?: string[] | (() => Promise<string[]>);
  /** Any tool-calling model id the endpoint knows. Ignored when resuming: a build keeps its model. */
  model?: HomepageModel;
  callbacks?: RunCallbacks;
  signal?: AbortSignal;
  /** Continue a build left mid-flight (e.g. after the worker was killed) from its checkpoint. */
  resumeSessionId?: string;
  now?: Date;
  maxSteps?: number;
  maxToolResultChars?: number;
  contextBudgetChars?: number;
  /** Sent as `max_tokens` when set. */
  maxTokens?: number;
}

/** Everything needed to pick a build back up. Lives in the host's KVStore, never on a server. */
export interface RunCheckpoint {
  id: string;
  model: HomepageModel;
  messages: ChatMessage[];
  files: Record<string, string>;
  steps: number;
  nudges: number;
  finalMessage: string;
  /** Link keys the build has seen (scraped pages, their hrefs, history domains). Absent in older checkpoints. */
  seenUrls?: string[];
  /** Whether the one repair attempt has been used. */
  repaired?: boolean;
}

function tool(name: string, description: string, parameters: ChatTool["function"]["parameters"]): ChatTool {
  return { type: "function", function: { name, description, parameters } };
}

export const HOMEPAGE_TOOLS: ChatTool[] = [
  tool(
    "getHistory",
    "Returns a ranked digest of the user's most-visited domains over a recent window: visit counts, " +
      "unique page counts, last-visit timestamps, relevance scores, and a few sample page titles per domain. " +
      "Call this first, once.",
    GET_HISTORY_SCHEMA,
  ),
  tool(
    "getPageHtml",
    "Loads URLs in the user's real, logged-in browser, sanitizes the HTML, and saves each page as a file in " +
      "your workspace. Returns a mountPath and size per page plus a list of failures. Use grep/read on the " +
      "returned mountPath. It sees authenticated, JavaScript-rendered pages that an anonymous fetch cannot.",
    GET_PAGE_HTML_SCHEMA,
  ),
  tool("read", "Read a line range of a workspace file. Output is numbered and truncated.", READ_SCHEMA),
  tool("grep", "Search workspace files line by line with a regular expression. Returns path:line: text.", GREP_SCHEMA),
  tool("glob", "List workspace files matching a glob, with their sizes.", GLOB_SCHEMA),
  tool(
    "write",
    `Write the deliverable: ${EDITION_PATH} (JSON for the default Morning Tab look) or ${OUTPUT_PATH} ` +
      "(a React component, only when the user asked for a different look). Supports append for long files.",
    WRITE_SCHEMA,
  ),
];

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}

const ELIDED = "[Earlier tool result removed to save context. Call the tool again if you still need it.]";

function messageChars(m: ChatMessage): number {
  let n = typeof m.content === "string" ? m.content.length : 0;
  if (m.role === "assistant") for (const c of m.tool_calls ?? []) n += c.function.arguments.length;
  return n;
}

/**
 * Keep the conversation under budget for small-context models: elide the
 * oldest tool results first, then the bodies of earlier write calls (the file
 * itself stays in the workspace). The last few messages are never touched.
 */
export function compactMessages(messages: ChatMessage[], budget: number): number {
  let total = messages.reduce((n, m) => n + messageChars(m), 0);
  let elided = 0;
  const protectedFrom = Math.max(2, messages.length - 4);
  for (let i = 2; i < protectedFrom && total > budget; i++) {
    const m = messages[i]!;
    if (m.role === "tool" && m.content !== ELIDED && m.content.length > ELIDED.length) {
      total -= m.content.length - ELIDED.length;
      m.content = ELIDED;
      elided++;
    } else if (m.role === "assistant" && m.tool_calls) {
      for (const call of m.tool_calls) {
        if (call.function.name !== "write" || call.function.arguments.length < 500) continue;
        let path = OUTPUT_PATH;
        try {
          path = JSON.parse(call.function.arguments).path ?? path;
        } catch {
          // keep the default
        }
        const stub = JSON.stringify({ path, content: "[omitted to save context; the file is saved in the workspace]" });
        total -= call.function.arguments.length - stub.length;
        call.function.arguments = stub;
        elided++;
      }
    }
  }
  return elided;
}

function newRunId(now: Date): string {
  return `run-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function runHomepageBuild(opts: RunOptions): Promise<HomepageBuildResult> {
  const { llm, bridge, store, callbacks, signal } = opts;
  const emit: Emit = {
    phase: (p, d) => callbacks?.onPhase?.(p, d),
    text: (t) => callbacks?.onText?.(t),
    log: (l) => callbacks?.onLog?.(l),
  };
  const maxSteps = opts.maxSteps ?? LOOP_DEFAULTS.maxSteps;
  const maxToolResultChars = opts.maxToolResultChars ?? LOOP_DEFAULTS.maxToolResultChars;
  const contextBudgetChars = opts.contextBudgetChars ?? LOOP_DEFAULTS.contextBudgetChars;
  const now = opts.now ?? new Date();

  emit.phase("setup");

  let run: RunCheckpoint | undefined;
  if (opts.resumeSessionId) {
    const saved = await store.get<RunCheckpoint>(STORAGE_KEYS.runCheckpoint);
    if (saved?.id === opts.resumeSessionId && Array.isArray(saved.messages)) {
      run = saved;
      emit.log(`resuming ${run.id} after ${run.steps} model turn(s)`);
    } else {
      emit.log(`no checkpoint for ${opts.resumeSessionId}; starting a fresh build`);
    }
  }
  if (!run) {
    emit.phase("session-create");
    run = {
      id: newRunId(now),
      model: normalizeModelId(opts.model ?? DEFAULT_MODEL),
      messages: [
        { role: "system", content: HOMEPAGE_SYSTEM_PROMPT },
        { role: "user", content: buildKickoffMessage({ now, userSystemPrompt: opts.userSystemPrompt }) },
      ],
      files: {},
      steps: 0,
      nudges: 0,
      finalMessage: "",
    };
  }
  const state = run;
  const workspace = new Workspace(state.files);
  const seen = new SeenUrls(state.seenUrls ?? []);
  emit.log(`run=${state.id} model=${state.model}`);

  const checkpoint = async () => {
    state.files = workspace.snapshot();
    state.seenUrls = seen.toJSON();
    try {
      await store.set(STORAGE_KEYS.runCheckpoint, state);
    } catch (err) {
      // Storage quota, most likely. The build goes on; only resume is lost.
      emit.log(`checkpoint not saved: ${String(err)}`);
    }
  };

  await store.set(STORAGE_KEYS.activeSessionId, state.id);
  await checkpoint();

  const runTool = async (call: ChatToolCall): Promise<string> => {
    let input: Record<string, unknown>;
    try {
      input = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("arguments must be a JSON object");
    } catch (err) {
      return `Error: could not parse the arguments for ${call.function.name} (${String(err)}). ` +
        `If the output was cut off, write a shorter file or use append: true to write it in parts.`;
    }
    try {
      const blockedSites = normalizeBlockList(
        (typeof opts.blockedSites === "function" ? await opts.blockedSites() : opts.blockedSites) ?? DEFAULT_BLOCKED_SITES,
      );
      switch (call.function.name) {
        case "getHistory":
          return fitJson(await runGetHistory(input, bridge, emit, blockedSites, seen), maxToolResultChars);
        case "getPageHtml":
          return truncate(JSON.stringify(await runGetPageHtml(input, { bridge, workspace, emit, blockedSites, seen })), maxToolResultChars);
        case "read":
          emit.phase("analyzing", "read");
          return workspace.read(input as { path: string }, maxToolResultChars);
        case "grep":
          emit.phase("analyzing", "grep");
          return workspace.grep(input as { pattern: string }, maxToolResultChars);
        case "glob":
          emit.phase("analyzing", "glob");
          return truncate(workspace.glob(input), maxToolResultChars);
        case "write":
          emit.phase("writing");
          return workspace.write(input as { path: string; content: string });
        default:
          throw new Error(`Unknown tool: ${call.function.name}`);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      emit.log(`tool ${call.function.name} failed: ${String(err)}`);
      return truncate(`Error: ${err instanceof Error ? err.message : String(err)}`, maxToolResultChars);
    }
  };

  try {
    let stepLimit = state.repaired ? Math.max(maxSteps, state.steps + LOOP_DEFAULTS.repairSteps) : maxSteps;
    /**
     * The one repair attempt: a deliverable that doesn't compile (or an edition that
     * doesn't parse) goes back to the model once, with the error.
     */
    const askRepair = async (): Promise<boolean> => {
      if (state.repaired || !findDeliverable(workspace)) return false;
      const problem = deliverableProblem(workspace, state.finalMessage, now);
      if (!problem) return false;
      state.repaired = true;
      stepLimit = state.steps + LOOP_DEFAULTS.repairSteps;
      emit.log(`deliverable failed its check, asking for one repair: ${problem}`);
      state.messages.push({
        role: "user",
        content:
          `Your homepage failed to build: ${problem}\n` +
          `Fix it and write the complete file again with the write tool (same path). This is the only retry.`,
      });
      await checkpoint();
      return true;
    };
    while (true) {
      if (signal?.aborted) throw new Error("aborted");
      if (state.steps >= stepLimit) {
        if (await askRepair()) continue;
        emit.log(`stopped after ${state.steps} model turns`);
        break;
      }

      const elided = compactMessages(state.messages, contextBudgetChars);
      if (elided) emit.log(`context: elided ${elided} earlier tool result(s)`);

      emit.phase("thinking");
      const response = await llm.complete(
        { model: state.model, messages: state.messages, tools: HOMEPAGE_TOOLS, maxTokens: opts.maxTokens },
        signal,
      );
      state.steps++;

      if (response.content) {
        state.finalMessage += (state.finalMessage ? "\n" : "") + response.content;
        emit.text(response.content);
      }
      state.messages.push({
        role: "assistant",
        content: response.content ?? null,
        ...(response.toolCalls.length ? { tool_calls: response.toolCalls } : {}),
      });

      if (response.toolCalls.length) {
        // Every call gets a result, in order — an unanswered call is a malformed conversation.
        for (const call of response.toolCalls) {
          const result = await runTool(call);
          state.messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
        await checkpoint();
        continue;
      }

      if (findDeliverable(workspace)) {
        if (await askRepair()) continue;
        break;
      }
      if (state.nudges >= LOOP_DEFAULTS.maxNudges) break;
      state.nudges++;
      emit.log(`no ${OUTPUT_PATH} yet (finish_reason=${response.finishReason ?? "?"}); reminding the model`);
      state.messages.push({
        role: "user",
        content:
          `You have not written the homepage yet. Call the write tool now: the edition JSON to ${EDITION_PATH} ` +
          `(default look) or the complete component to ${OUTPUT_PATH} (use append: true to send it in parts if it is long).`,
      });
      await checkpoint();
    }

    emit.phase("writing");
    const built = collectDeliverable(workspace, state.finalMessage, emit, now);
    const problem = checkComponent(built.code);
    if (problem) throw new Error(`The homepage failed to build${state.repaired ? " after one repair attempt" : ""}: ${problem}`);
    const checked = validateHomepageLinks(built.code, seen);
    emit.log(`links: kept ${checked.links.length}, removed ${checked.removed.length} (not seen or not http(s))`);
    emit.phase("done");
    return {
      code: checked.code,
      sessionId: state.id,
      source: built.source,
      links: checked.links,
      removedLinks: checked.removed,
      repaired: Boolean(state.repaired),
    };
  } finally {
    // Privacy: the checkpoint holds every domain, title and page body this
    // build read. It exists only so a killed worker can resume; drop it now.
    emit.phase("cleanup");
    await store.remove(STORAGE_KEYS.runCheckpoint);
    await store.remove(STORAGE_KEYS.activeSessionId);
  }
}

/** Shrink the digest by dropping the lowest-ranked sites until it fits — valid JSON, unlike a cut string. */
function fitJson(digest: GetHistoryResult, max: number): string {
  let text = JSON.stringify(digest);
  const sites = [...digest.sites];
  while (text.length > max && sites.length > 1) {
    sites.pop();
    text = JSON.stringify({ ...digest, sites });
  }
  return truncate(text, max);
}

// ---------------------------------------------------------------------------
// browser tools
// ---------------------------------------------------------------------------

async function runGetHistory(
  input: Record<string, unknown>,
  bridge: BrowserBridge,
  emit: Emit,
  blockedSites: string[],
  seen: SeenUrls,
): Promise<GetHistoryResult> {
  const daysToAnalyze = clamp(input.daysToAnalyze, DEFAULTS.daysToAnalyze, 1, 90);
  const maxResults = clamp(input.maxResults, DEFAULTS.maxResults, 1, 50);

  emit.phase("history", `${daysToAnalyze}d`);
  const { sites, totalSitesSeen } = await bridge.getHistory({ daysToAnalyze, maxResults });
  const allowed = sites.filter((site) => !isBlocked(site.domain, blockedSites));
  // Blocked domains are dropped from the count too: the model is never told they exist.
  const digest = buildHistoryDigest(allowed, {
    daysToAnalyze,
    maxResults,
    totalSitesSeen: totalSitesSeen - (sites.length - allowed.length),
  });
  for (const site of digest.sites) seen.addDomain(site.domain);
  emit.log(`history: ${digest.sites.length} of ${digest.totalSitesSeen} domains`);
  return digest;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value ?? NaN);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

async function runGetPageHtml(
  input: Record<string, unknown>,
  ctx: { bridge: BrowserBridge; workspace: Workspace; emit: Emit; blockedSites: string[]; seen: SeenUrls },
): Promise<GetPageHtmlResult> {
  const requested = Array.isArray(input.urls) ? input.urls.map(String) : [];
  if (!requested.length) throw new Error("getPageHtml needs a non-empty `urls` array");
  const urls = requested.slice(0, 8);
  ctx.emit.phase("scraping", `${urls.length} pages`);

  const allowed: string[] = [];
  const blocked: GetPageHtmlResult["failed"] = [];
  for (const url of urls) {
    // Match on the URL the browser will load; malformed URLs never reach the signed-in browser.
    if (isAllowedUrl(url, ctx.blockedSites)) allowed.push(url);
    else blocked.push({ url, reason: "blocked by the user's settings" });
  }

  // Skip the bridge entirely when nothing is left, so no scraper window opens.
  const { pages: loaded, failed } = allowed.length
    ? await ctx.bridge.getPageHtml({
        urls: allowed,
        loadDelayMs: clamp(input.loadDelayMs, DEFAULTS.loadDelayMs, 0, 30_000),
      })
    : { pages: [], failed: [] };

  // A redirect can land on a blocked host, and a public-looking name (fritz.box, an
  // intranet name) can resolve to a private address; drop what it read before the model sees it.
  const pages = loaded.filter((page) => {
    const urlAllowed = !page.finalUrl || isAllowedUrl(page.finalUrl, ctx.blockedSites);
    if (urlAllowed && !(page.ip && isPrivateAddress(page.ip))) return true;
    blocked.push({ url: page.url, reason: "blocked by the user's settings" });
    return false;
  });
  if (blocked.length) ctx.emit.log(`blocked: ${blocked.length} url(s)`);

  const refs: PageRef[] = [];
  const saveFailures = [...blocked, ...failed];
  const existing = ctx.workspace.list().length;

  for (const page of pages) {
    try {
      const filename = `${slugifyUrl(page.url)}_${existing + refs.length}.html`;
      const saved = ctx.workspace.addPage(filename, page.html);
      // Links the model may use: the page itself and every href on it.
      ctx.seen.add(page.url);
      ctx.seen.addPage(page.html, page.finalUrl || page.url);
      if (page.finalUrl && page.finalUrl !== page.url) ctx.seen.add(page.url);
      refs.push({ url: page.url, title: page.title, mountPath: saved.path, bytes: saved.bytes });
      ctx.emit.log(`saved ${page.url} -> ${saved.path} (${saved.bytes} chars)`);
    } catch (err) {
      saveFailures.push({ url: page.url, reason: `save failed: ${String(err)}` });
    }
  }

  if (refs.length === 0 && saveFailures.length > 0 && blocked.length === 0) {
    throw new Error(
      `No pages could be loaded. Failures: ${saveFailures.map((f) => `${f.url} (${f.reason})`).join("; ")}`,
    );
  }

  return { pages: refs, failed: saveFailures };
}

// ---------------------------------------------------------------------------
// deliverable
// ---------------------------------------------------------------------------

const CODE_FENCE = /```(?:tsx|jsx|ts|js|typescript|javascript)?\s*\n([\s\S]*?)```/;

/** What is wrong with the current deliverable, or null when it builds. */
function deliverableProblem(workspace: Workspace, finalMessage: string, now: Date): string | null {
  try {
    return checkComponent(collectDeliverable(workspace, finalMessage, { phase() {}, text() {}, log() {} }, now).code);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Strip a ```tsx fence, if the model wrapped the file contents in one. */
function stripFence(text: string): string {
  const fenced = text.match(CODE_FENCE);
  return (fenced ? fenced[1]! : text).trim();
}

function findDeliverable(workspace: Workspace): { path: string; text: string } | undefined {
  const primary = workspace.get(OUTPUT_PATH);
  if (primary?.trim()) return { path: OUTPUT_PATH, text: primary };
  const edition = workspace.get(EDITION_PATH);
  if (edition?.trim()) return { path: EDITION_PATH, text: edition };
  for (const file of workspace.list()) {
    if (!file.path.startsWith(`${OUTPUTS_DIR}/`) || !/\.(tsx|jsx|ts|js)$/.test(file.path)) continue;
    const text = workspace.get(file.path);
    if (text?.trim()) return { path: file.path, text };
  }
  return undefined;
}

function collectDeliverable(
  workspace: Workspace,
  finalMessage: string,
  emit: Emit,
  now: Date,
): { code: string; source: HomepageBuildResult["source"] } {
  const file = findDeliverable(workspace);
  if (file?.path === EDITION_PATH) {
    const edition = parseEdition(file.text);
    emit.log(`deliverable: The Morning Tab from ${EDITION_PATH} (${1 + edition.stories.length + edition.briefs.length} items)`);
    return { code: renderMorningTab(edition, now), source: "edition" };
  }
  if (file) {
    emit.log(`deliverable from workspace output: ${file.path} (${file.text.length} chars)`);
    return { code: stripFence(file.text), source: "session-output" };
  }

  // Fallback: the model sometimes answers with the component inline instead of
  // (or as well as) writing it. Better than failing the run outright.
  const fenced = finalMessage.match(CODE_FENCE);
  if (fenced && fenced[1]!.includes("PersonalizedHomepage")) {
    emit.log("deliverable recovered from message fence");
    return { code: fenced[1]!.trim(), source: "message-fence" };
  }

  throw new Error(
    `Agent produced no homepage. Expected a file at ${OUTPUT_PATH}. ` +
      `Final message: ${finalMessage.slice(0, 400)}`,
  );
}

// ---------------------------------------------------------------------------
// repair after a failed render
// ---------------------------------------------------------------------------

export interface RepairOptions {
  llm: ChatClient;
  model?: HomepageModel;
  /** The component that failed. */
  code: string;
  /** What the page reported (an exception message, "rendered an empty page", …). */
  error: string;
  /** Links the failed homepage was allowed to use; the repair may not add others. Defaults to its literal links. */
  allowedLinks?: string[];
  callbacks?: RunCallbacks;
  signal?: AbortSignal;
  maxSteps?: number;
  maxTokens?: number;
}

/**
 * The one repair attempt for a homepage that failed to render in a tab. The model
 * gets only the component and the error (no history, no pages) and may only call
 * write. The result is checked like a fresh build; if it still fails, this throws
 * and the caller keeps showing the last working homepage.
 */
export async function runHomepageRepair(opts: RepairOptions): Promise<HomepageBuildResult> {
  const { llm, callbacks, signal } = opts;
  const emit: Emit = {
    phase: (p, d) => callbacks?.onPhase?.(p, d),
    text: (t) => callbacks?.onText?.(t),
    log: (l) => callbacks?.onLog?.(l),
  };
  const model = normalizeModelId(opts.model ?? DEFAULT_MODEL);
  const maxSteps = opts.maxSteps ?? 4;
  const allowed = new Set((opts.allowedLinks ?? literalLinks(opts.code)).map((u) => linkKey(u)).filter(Boolean) as string[]);
  const workspace = new Workspace();
  const messages: ChatMessage[] = [
    { role: "system", content: REPAIR_SYSTEM_PROMPT },
    { role: "user", content: buildRepairMessage(opts.code, opts.error) },
  ];
  const writeTool = HOMEPAGE_TOOLS.filter((t) => t.function.name === "write");
  let finalMessage = "";
  emit.phase("setup");
  emit.log(`repair: model=${model}, error=${opts.error.slice(0, 200)}`);

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) throw new Error("aborted");
    emit.phase("thinking");
    const response = await llm.complete({ model, messages, tools: writeTool, maxTokens: opts.maxTokens }, signal);
    if (response.content) {
      finalMessage += (finalMessage ? "\n" : "") + response.content;
      emit.text(response.content);
    }
    messages.push({
      role: "assistant",
      content: response.content ?? null,
      ...(response.toolCalls.length ? { tool_calls: response.toolCalls } : {}),
    });
    if (!response.toolCalls.length) break;
    for (const call of response.toolCalls) {
      let result: string;
      try {
        if (call.function.name !== "write") throw new Error(`Only the write tool is available.`);
        const input = JSON.parse(call.function.arguments || "{}");
        emit.phase("writing");
        result = workspace.write({ ...input, path: OUTPUT_PATH });
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  emit.phase("writing");
  const written = workspace.get(OUTPUT_PATH);
  const fenced = finalMessage.match(CODE_FENCE);
  const code = written?.trim() ? stripFence(written) : fenced?.[1]?.includes("PersonalizedHomepage") ? fenced[1].trim() : "";
  if (!code) throw new Error("The repair attempt produced no component.");
  const problem = checkComponent(code);
  if (problem) throw new Error(`The repaired homepage still fails: ${problem}`);
  const checked = validateHomepageLinks(code, { has: (u) => allowed.has(linkKey(u) ?? "") });
  emit.log(`repair: links kept ${checked.links.length}, removed ${checked.removed.length}`);
  emit.phase("done");
  return {
    code: checked.code,
    sessionId: `repair-${Date.now().toString(36)}`,
    source: "repair",
    links: checked.links,
    removedLinks: checked.removed,
    repaired: true,
  };
}
