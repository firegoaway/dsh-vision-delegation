# dsh-vision-flash

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that gives a **text-only main model** eyes: it registers one tool, `vision_analyze`, which streams an image plus the caller's own question through the harness LLM seam to a **vision-capable model route** and returns that model's answer as plain text.

Since 1.1.0 the route is **discovered, not hard-coded**. Switching providers, adding an endpoint, or burning one route's weekly quota no longer breaks vision.

## How a route is chosen

1. Every registered provider is asked for its advertised models (`ctx.llm.listProviders()` → `ctx.llm.listModels(provider)`).
2. Only models whose catalog **declares `image` in `inputModalities`** become candidates. A route that does not declare image input is never tried, because the harness then replaces images with per-image text placeholders and the "vision model" would answer from thin air.
3. Candidates are ranked by the `prefer` config (substrings of `provider/model`, first match wins), then tried in order. The first route that answers wins; the answer and the used route are returned to the main model.
4. Outcomes are classified per route: quota/rate limit → try the next one; missing credential or unregistered route → try the next one; an explicit refusal to accept image content → remembered for `10 min` and skipped on later calls.
5. Discovery is cached for 60 s and invalidated immediately on `llm/adapters-updated` / `llm/models-updated`, so a provider added or reconfigured mid-session is picked up without a restart.

When nothing can answer, the error lists every route with its verdict — and states how to fix it.

## Config

| Key | Default | Meaning |
|---|---|---|
| `provider` / `model` | `""` | Pin one route to try **first**; leave empty for pure discovery |
| `prefer` | `-vl`, `vl-`, `vision`, `qvq` | Ranking substrings for a deployment (strongest vision model first) |
| `probeUndeclared` | `false` | Also try routes that never declared image input (they may get placeholders) |
| `maxCandidates` | `6` | How many routes one call may try |
| `maxTokens` | `4096` | Output cap per answer |
| `timeoutMs` | `60000` | Budget for one candidate |
| `totalTimeoutMs` | `150000` | Budget for the whole call, shared by all candidates |
| `maxImages` | `4` | Images per call |

## Teaching a route that it can see

Providers built from the bundled catalog already declare modalities. A **custom** OpenAI-compatible provider (a `models:` list in `dsh-llm-pi-ai` config) does not: every entry there falls back to `input: [text]` unless you say otherwise. So for an endpoint whose models are not in the catalog, declare the truth on the entries that really accept images:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      my-endpoint:
        api: openai-completions
        baseURL: https://example.com/compatible-mode/v1
        models:
          - id: some-strong-model
            name: some-strong-model
            input: [text, image]   # ← now this route is a vision candidate
```

That single line also unblocks the native path: with `input: [text, image]` on the model the session actually runs, `read_image` hands pixels to the main model directly and this plugin becomes a fallback rather than the only channel. If the endpoint turns out to refuse images anyway, the plugin records that verdict, moves on to the next route, and says so.

## Self-test

The selection logic is verified offline against a fake LLM seam — no provider traffic. From a fresh clone, install the harness packages the bundle declares first (they are published on npm, pinned by `package-lock.json`):

```
npm install --no-audit --no-fund
node selftest.mjs
```

Inside a DSH profile the plugin is already resolvable through the profile's own `node_modules`, so `node selftest.mjs` runs there without the install step.

It covers: preference ranking, fall-through past an exhausted route, never offering text-only routes, the "no vision route declared" guidance, the quota summary, remembered image refusals, mid-session topology changes, and a forced `route` override.

## Pairing

`dsh-vision-delegation` turns pasted composer images into file attachments so a text-only main model receives a readable path and can call this tool on it. This plugin needs nothing else: any file path it can read is fair game.

## License

[MIT](LICENSE)
