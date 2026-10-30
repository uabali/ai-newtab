# AI Homepage

**A new tab that reads the internet for you.**

> This is a fork of [ThariqS/ai-newtab](https://github.com/ThariqS/ai-newtab) by
> Thariq Shihipar (MIT). The original drives a Claude Managed Agents session with an
> Anthropic API key; this fork (`openrouter` branch) runs the agent loop locally in
> the extension and talks to **[OpenRouter](https://openrouter.ai)** (or any
> OpenAI-compatible `/chat/completions` endpoint with tool calling), so no Anthropic
> key is needed. All credit for the idea, UI and tooling goes to the original author.

AI Homepage replaces Chrome's new-tab page with one that's written for you. An
agent looks at what you've actually been browsing, opens the pages you follow
(signed in as you), and writes a fresh homepage from what it finds there. It
rebuilds itself in the background, so each new tab is up to date.

![An example homepage in a morning-newspaper style](docs/preview.png)
<sub>Illustration. Your homepage is built from your own browsing, so its stories will be different.</sub>

A morning newspaper is just one look. You can describe any look and the next build
follows it: a quiet one-column digest, a dense dashboard, a green-on-black
terminal, a zine.

> **Privacy, up front.** To build your homepage, the extension sends a summary of
> your browsing history (top domains, visit counts, a few page titles) and the
> cleaned-up HTML of up to 8 pages (truncated) to OpenRouter, or to the base URL
> you configure, using your own API key. OpenRouter forwards each request to the
> provider of the model you pick, so that provider's data policy applies too.
> Those pages are loaded in your signed-in browser, so they can include private
> content. There is no remote session: pages are held in the extension's memory for
> the duration of a build and only reach the model as tool results. Your API key
> stays in the extension's local storage. More detail in
> [ARCHITECTURE.md](./ARCHITECTURE.md#privacy).

---

## Install

You need Chrome (or another Chromium browser), [Node.js](https://nodejs.org) 20+,
and an [OpenRouter API key](https://openrouter.ai/settings/keys).

```bash
git clone -b openrouter https://github.com/uabali/ai-newtab.git
cd ai-newtab
npx pnpm@10.11.1 install
npx pnpm@10.11.1 build
```

(If you already have [pnpm](https://pnpm.io), plain `pnpm install && pnpm build` works too.)

Then load it into Chrome:

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose `apps/extension/.output/chrome-mv3`.

If Chrome asks whether to keep the changed new-tab page, choose **Keep it**.

## Your first homepage

1. Open a new tab and paste your OpenRouter API key (`sk-or-…`).
2. Click **Build today's homepage**.
3. Watch it work. The progress view walks through each step: preparing the
   agent, reading your history, opening pages in your browser, analyzing them,
   and writing your homepage.

The first build takes a few minutes. You can close the tab while it runs, since
the build lives in the extension's background worker and appears in any new tab
you open.

## Make it yours

Click **⚙️ Settings** on the new tab.

**Instructions.** Anything you write here goes into every build and takes priority
over the agent's own defaults. This box sets both the content and the look:

| You write | You get |
| --- | --- |
| *"A morning newspaper. Serif type, a big masthead, a lead story, a column of briefs."* | A broadsheet front page |
| *"One calm column. No images. Five things worth reading, with one line on why."* | A quiet reading list |
| *"Dense dashboard: GitHub PRs and issues first, then Hacker News, then everything else."* | A work cockpit |
| *"Green-on-black terminal, monospace, like a 1980s BBS."* | Exactly that |
| *"Skip sports and politics. Always show the weather and my next three calendar events."* | Your rules, every day |

Click **Save & rebuild** to apply them right away.

**Sites the agent never reads.** Enter one host per line; subdomains are included,
and `*.example.com` is supported. The editable defaults include common webmail,
sign-in and document hosts. **Save & rebuild** saves the list and applies it to
history summaries and URLs requested through `getPageHtml`. A page that redirects
onto a blocked host is dropped before its content is uploaded. Local-network
addresses (localhost, private IPs, `.local` and `.internal` hosts) are always blocked.

**Model.** Type any OpenRouter model id, or click **Presets** to pick one. The model
must support **tool calling**; check the "Tools" filter on
[openrouter.ai/models](https://openrouter.ai/models?supported_parameters=tools).
A model you already saved is kept as-is, even if it isn't a preset.

- **`nvidia/nemotron-3-ultra-550b-a55b:free`** (default, shown first).
- `deepseek/deepseek-v4.1-flash`, `anthropic/claude-haiku-5.5`, `z-ai/glm-5.3-flash`,
  `qwen/qwen3.8-flash`, `deepseek/deepseek-v4-pro-0813`, `google/gemini-3.8-flash`,
  `openai/gpt-6.1-terra`, `anthropic/claude-sonnet-5.5`, `google/gemini-4-argon`.

> **Free models (`:free`, including the default) are rate-limited** and may be slower
> or fail mid-build, and **OpenRouter or the provider may log your prompts** for free
> endpoints, which here include history summaries and page text. For anything you'd
> rather not have logged, pick a paid model and check its provider's data policy.

When the endpoint is OpenRouter, opening **Presets** also lists the other tool-calling
models from OpenRouter's public model list (`GET /api/v1/models`). That request is
anonymous: no API key, no cookies, no referrer, no history; it is sent only when you
open the picker. If it fails, or you set a custom base URL, only the presets are shown.

The new model takes effect from your next build.

**Base URL** (optional). Defaults to `https://openrouter.ai/api/v1`. Any HTTPS,
OpenAI-compatible endpoint that supports `tools` works; the extension appends
`/chat/completions`. Plain `http://` (e.g. a local server) is rejected.

**Rebuild automatically each morning.** On by default. The extension builds one
morning edition a day, quietly in the background, the first time Chrome is open
between 5am and noon. If Chrome isn't open that morning, the day is skipped. It
only starts after you've built once by hand, and it tries at most once per
morning, so it never loops.

**↻ Rebuild** in the top-right corner rebuilds right away.

## Good to know

- **Cost.** Each build is a series of chat-completion calls (up to 40 steps)
  billed to your OpenRouter key. What it costs depends on the model and on how
  much it reads; page HTML and tool results are truncated to keep prompts small.
  `:free` models cost nothing but are rate-limited, and you can turn off
  automatic rebuilds to build only when you ask.
- **What it can see.** It ranks the sites in your history and opens up to 8 of
  them per build. It skips search engines, webmail, banking and logged-out
  marketing pages. Anything it can't open is reported, not hidden.
- **Links are real.** Every link on the page comes from a page the agent actually
  read. It's told never to invent a URL.
- **Interrupted builds.** The conversation and scraped pages are checkpointed to
  local storage after every tool turn. If Chrome closes mid-build, the new tab
  offers **Resume interrupted build** and continues from the last checkpoint
  without re-scraping.
- **Updating.** After pulling new code, run `npx pnpm@10.11.1 build` again, then
  click the reload icon on the extension in `chrome://extensions`.

## How it works

1. **`getHistory`**: the agent gets a ranked summary of your most-visited domains.
2. **`getPageHtml`**: it picks up to 8 pages, which the extension opens in a
   background window, cleans up, and stores in an in-memory workspace as
   `/pages/*.html`.
3. **`grep` / `glob` / `read`**: the agent pulls headlines, posts and links out of
   those files. These tools run in the extension, over memory only.
4. **`write`**: it writes one React component to `/outputs/homepage.tsx`, which
   the new tab renders.

The extension's background worker runs the agent loop itself
(`packages/agent-core/orchestrator.ts`) and calls the model through the
OpenAI-compatible chat completions API with tool calling, with no server in
between. Every tool executes locally; there is no shell and no network tool, and
scraped pages are treated as untrusted input.

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the event flow, the layout, and
the gotchas worth knowing.

## Development

```
packages/agent-core   the agent loop: host-agnostic, no chrome.* or node:*
apps/extension        the MV3 extension (WXT + React)
harness               Bun scripts that run agent-core outside Chrome, and test the built extension
```

```bash
pnpm dev                 # WXT with hot reload
pnpm typecheck           # all packages
pnpm test                # unit tests incl. the agent loop against a mock fetch (no API calls; needs Bun, or `npx -y bun test harness/`)
pnpm extension:test      # loads the built extension into headless Chrome (no API calls)
pnpm extension:screenshots # UI screenshots in headless Chrome with a dummy key → harness/out/shots/

cp .env.example .env     # add OPENROUTER_API_KEY, then:
pnpm agent:run           # a full build against the real API (spends credits), with fixture history
pnpm agent:verify        # check the output actually renders
```

## Status

Early and experimental. It's a tool you run yourself with your own key. Don't
publish it to a store as-is: anyone with access to the browser profile can read
the stored API key.

## License

MIT. Original work © Thariq Shihipar ([ThariqS/ai-newtab](https://github.com/ThariqS/ai-newtab));
OpenRouter port in this fork by [uabali](https://github.com/uabali).
