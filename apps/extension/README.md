# @homepage/extension

The MV3 browser extension (WXT + React). See the [root README](../../README.md)
for setup and [ARCHITECTURE.md](../../ARCHITECTURE.md) for how it fits together.

```bash
pnpm build       # → .output/chrome-mv3
pnpm dev         # hot-reload dev build
pnpm typecheck
```

- `entrypoints/background.ts`: the service worker that hosts the build (the local agent loop talking to OpenRouter)
- `entrypoints/newtab/`: the new-tab UI, a thin client onto the worker (API key, model and base URL live in Settings)
- `components/ui/`: shadcn/ui components (Radix primitives + Tailwind v4) for the new-tab UI; styles stay out of the Sandpack homepage iframe
- `lib/`: the build manager, the two browser tools, storage, the page↔worker protocol, and `model-catalog.ts` (the anonymous public model list behind the model picker)
