# Architecture

There is no server. Two parties are involved, and you run one of them.

| | Runs where | Does what |
|---|---|---|
| **Extension** (service worker) | Your browser | Runs the agent loop, executes every tool (`getHistory`, `getPageHtml`, `read`, `grep`, `glob`, `write`), holds the scraped pages in memory, persists checkpoints and the homepage |
| **Extension** (new-tab page(s)) | Your browser | Thin view: subscribes to the worker over a port, renders live progress and the finished homepage |
| **Model endpoint** | OpenRouter (or your base URL) | Stateless `POST /chat/completions` with `tools`; returns text and `tool_calls` |

The agent loop runs **in the service worker** (`apps/extension/lib/build-manager.ts` →
`packages/agent-core/orchestrator.ts`), so a build survives closing the tab, shows up in
every open tab, and can run headless on a `chrome.alarms` schedule. The model never
executes anything: it returns `tool_calls`, the worker runs them and sends the results
back as `role: "tool"` messages in the next request. There is no inbound connection and
no public endpoint.

```
service worker                                   OpenRouter
    │                                                │
    ├─ POST /chat/completions (system, kickoff, tools)▶
    │◀─ tool_calls: getHistory ──────────────────────┤
    ├─ chrome.history → digest                       │
    ├─ POST (… + tool result) ──────────────────────▶│
    │◀─ tool_calls: getPageHtml(urls) ───────────────┤
    ├─ tabs + scripting → /pages/*.html (in memory)  │
    ├─ POST (… + "fetched N pages, use grep/read") ─▶│
    │◀─ tool_calls: grep / read / glob ──────────────┤
    ├─ in-memory search, truncated results           │
    ├─ POST … ──────────────────────────────────────▶│
    │◀─ tool_calls: write /outputs/homepage.tsx ─────┤
    ├─ POST … ──────────────────────────────────────▶│
    │◀─ finish_reason: stop ─────────────────────────┤
    └─ return /outputs/homepage.tsx, clear checkpoint
```

### The loop (`packages/agent-core`)

- `llm.ts`: a minimal OpenAI-compatible client with an injectable `fetch`. Non-streaming;
  retries 408/409/425/429/5xx, network errors and 200-responses carrying an `error` body
  (OpenRouter does this when an upstream provider fails). Sends `Authorization: Bearer`,
  `HTTP-Referer` and `X-Title`. The base URL must be `https://` and must not contain
  credentials.
- `workspace.ts`: the in-memory file system. Scraped pages go to `/pages/<slug>_<n>.html`
  (a line break before each block-level tag, so `grep`/`read` return a headline with its link, capped at 400k chars each). `write` is
  only allowed under `/outputs/` with a `.tsx/.jsx/.ts/.js/.json` extension, and supports
  `append` so small-output models can write the component in chunks.
- `orchestrator.ts`: `runHomepageBuild`. Up to 40 model steps. Tool results are truncated
  to 12k chars; once the conversation passes ~120k chars the oldest tool results (and old
  `write` arguments) are replaced with a short placeholder, so small-context models keep
  working. If the model stops without writing the deliverable it is nudged (twice at most);
  as a last resort a ```tsx fence containing `PersonalizedHomepage` in the final message
  is accepted. The deliverable is `/outputs/homepage.tsx` (a custom look) or
  `/outputs/edition.json` (the default look, rendered by `morning-tab.ts`).
- `check-component.ts`: the deliverable must compile (sucrase), `export default`, and
  import only `react`. If it fails (or the edition JSON doesn't parse), the error goes
  back to the model **once** (`repaired` in the checkpoint, plus 6 extra steps); still
  failing, the build throws and the old homepage stays.
- `links.ts`: every URL the build saw (`SeenUrls`, checkpointed): history domains'
  front pages, pages opened by `getPageHtml` (requested and final URL) and their
  `<a href>`s, resolved. `validateHomepageLinks` then removes JSX `href="…"` literals
  and nulls link-ish data fields (`url`, `href`, `link`, `*Url` …, not images) whose
  value isn't an absolute `http(s)` URL in that set. The kept links are saved with the
  homepage as its click allowlist.
- `runHomepageRepair`: the one repair for a homepage that compiled but failed to
  render in a tab. Only the component and the error are sent; only `write` is offered;
  the result is checked the same way, and may not add links outside the old allowlist.

### Keeping the worker alive

An MV3 service worker is torn down after ~30s idle, and a build spends most of its
wall clock waiting on the model. Three things keep it alive or bring it back:

- **During a turn**, the in-flight fetch plus a 20s self-ping
  (`runtime.getPlatformInfo`) reset the idle timer.
- **A 1-minute alarm heartbeat** calls `BuildManager.tick()`. After every tool turn the
  orchestrator saves a checkpoint (messages, workspace files, step counters, model) under
  `activeRunCheckpoint`, with the run id in `activeSessionId`. If the worker was killed,
  the heartbeat finds them and resumes from the checkpoint without re-scraping. Both keys
  are removed when a build ends, successfully or not.
- **The same heartbeat** drives scheduled rebuilds (`lib/auto-rebuild.ts`), so the
  first new tab of the day already shows a fresh homepage.

### Tabs are views

Each new tab connects on a port (`lib/protocol.ts`), receives a snapshot of the
build state, then streams phase/text/log deltas. Every open tab shows the same live
run. A throttled snapshot is also mirrored to storage so a tab opened while the
worker is asleep paints instantly. Responses are not streamed, so narration appears
one model turn at a time.

The finished component renders inside a Sandpack iframe
(`entrypoints/newtab/components/HomepagePreview.tsx`): it is model-written code, so
it runs sandboxed, not in the extension's own page.

**Links and render status** (`lib/link-bridge.ts`). A link in that iframe would
navigate the cross-origin, sandboxed frame itself (most sites refuse to be framed),
so the Sandpack entry imports `/bridge.js` before the component. It cancels every
link click in the capture phase and replaces `window.open`, posting
`{type: "ai-homepage:open-link", url, disposition}` to the parent; it also unlinks
any `<a href>` outside the homepage's allowlist (MutationObserver, so links built at
runtime too). The new tab only accepts messages whose `source` is the preview
iframe, re-checks the URL (absolute `http(s)`, on the allowlist) and that the page
has user activation, then calls `tabs.update` (click) or `tabs.create` (Ctrl/⌘/
middle click, `window.open`). Homepages saved before the allowlist existed accept any
absolute `http(s)` URL.

The entry also wraps the component in an error boundary and reports
`ai-homepage:rendered` (non-empty `#root` after mount) or `ai-homepage:render-error`;
Sandpack's own `show-error` covers compile errors. On success the tab stores the
version as `lastGoodHomepage`. On failure (`lib/render-fallback.ts`) it shows that
last working version with a notice, or an error card if there is none, and sends
`{kind: "repair"}` once; the worker marks the homepage `repairAttempted` before
calling the model, so a homepage is never repaired twice.

The extension's own UI (key screen, Settings, toolbar, build progress) uses Tailwind
v4 and shadcn/ui components on Radix primitives (`components/ui/`). Those styles
apply only to the new-tab document; the homepage renders in Sandpack's cross-origin
iframe, a separate document, so Tailwind's reset and utilities never reach it.

## Layout

```
packages/agent-core/      host-agnostic agent loop — imports no chrome.*, browser.*, or node:*
  orchestrator.ts         runHomepageBuild: local tool-calling loop, checkpoint/resume, truncation
  llm.ts                  OpenAI-compatible chat client (OpenRouter by default)
  workspace.ts            in-memory /pages and /outputs with read / grep / glob / write
  setup.ts                default model, model suggestions, storage keys
  prompt.ts               system prompt (Morning Tab default, links rules), kickoff and repair messages
  morning-tab.ts          The Morning Tab: edition.json schema, sanitizer, fixed template
  links.ts                linkKey, SeenUrls, validateHomepageLinks
  check-component.ts      compile / export / imports check for a deliverable
  schemas.ts              tool input schemas and defaults
  history-digest.ts       narrows raw history to fit a tool result
  types.ts                BrowserBridge, KVStore, RunPhase, …

apps/extension/           MV3 extension (WXT + React)
  entrypoints/
    background.ts         service worker: hosts BuildManager, alarm heartbeat
    scraper.content.ts    injected into scraped tabs: scroll, return HTML
    newtab/               the new-tab UI (thin client onto the worker)
  components/ui/          shadcn/ui components (Radix + Tailwind) used by the new-tab UI
  lib/
    build-manager.ts      single-flight build host, broadcast, keepalive, reattach
    browser-bridge.ts     BrowserBridge over chrome.history / chrome.tabs
    history.ts            getHistory: group and rank chrome.history by domain
    scraper.ts            getPageHtml: load URLs in a background window, sanitize HTML
    protocol.ts           page ↔ worker messages and the five UI build steps
    auto-rebuild.ts       when to rebuild on a schedule
    storage.ts            every chrome.storage key, settings, saved homepage
    transpile.ts          TSX → JS for the preview
    link-bridge.ts        iframe bridge script + parent-side message handler (links, render status)
    render-fallback.ts    what to show when a homepage fails to render, and when to repair
    model-catalog.ts      model picker: presets + OpenRouter's public tool-calling list
    utils.ts              cn() class-name helper for the UI components

harness/                  Bun scripts: mock-fetch tests of the loop, a real-API runner, extension test,
                          screenshots (headless Chrome, dummy key, no model calls)
```

## Verification

| Command | Proves |
|---|---|
| `pnpm test` | History digest; blocked-site / private-IP filtering through the real loop; the agent loop against a mock `fetch` (request shape, tools, append, nudges, fence fallback, truncation, compaction, retries, 401, abort, checkpoint → resume); link validation; the Morning Tab template; the in-build and runtime repair; the link bridge (script and parent handler); the render fallback decision |
| `pnpm agent:run` | Full build against the real API with fixture history (needs `OPENROUTER_API_KEY`, spends credits) |
| `pnpm agent:verify` | The deliverable transforms, evaluates and server-renders |
| `pnpm extension:test` | In headless Chrome: worker registers, new tab renders, port protocol answers, `chrome.history` reads; a fixture homepage reports its render, an allowlisted link opens via `chrome.tabs` (⌘-click: new tab, click: this tab) and an unlisted one doesn't; a throwing homepage falls back, or shows an error card (needs network for Sandpack and example.com) |

The harness's bridge uses fixture history and a plain `fetch`, so it can't see
logged-in pages — that's the whole reason `getPageHtml` runs in your browser.

## Privacy

The editable blocked-sites list is enforced in agent-core's tool handlers, not
just the prompt: blocked domains are excluded from history digests and their
counts, and blocked or non-HTTP(S) page requests never reach the browser bridge.
Each scraped page's final URL is checked again before it enters the workspace, so a
redirect onto a blocked host is dropped: the browser still loads it, but nothing it
read is sent. Loopback, private-IP and local-network hosts are always blocked,
whatever the list says. A name can still resolve to a private address (`fritz.box`, an
intranet name), so the scraper also records the address each page was served
from (`webRequest`, observe only) and the page is dropped when it is private. That
address is only reported when the extension's own requests to the configured model
endpoint connect to a public address; behind a proxy at a private address, or when
Chrome reports no address, the name check is all there is. History digests still list
such a domain. Subresource loads are not intercepted.

Data leaves the browser only in requests to the configured endpoint (OpenRouter by
default). The one other request is the model picker's anonymous `GET
https://openrouter.ai/api/v1/models?supported_parameters=tools`
(`lib/model-catalog.ts`): sent only when the endpoint is OpenRouter and the picker is
opened, with no key, cookies, referrer or user data; on failure the presets are shown. Nothing is stored server-side by the extension, but OpenRouter and the
upstream model provider each have their own logging/retention policies (free
endpoints in particular may log prompts). Check them before pointing this at private
pages. Locally, a checkpoint with the scraped pages sits in `chrome.storage.local`
until the build ends.

The API key lives in `chrome.storage.local`, readable by anyone with access to the
browser profile. Fine for a tool you run yourself; **do not ship this to the Web Store**
without moving the key behind a proxy. Consider a spending limit on the OpenRouter key.

## Credits

Original design and implementation: [ThariqS/ai-newtab](https://github.com/ThariqS/ai-newtab)
(MIT). This fork replaces the Claude Managed Agents session with a local loop over
OpenRouter.
