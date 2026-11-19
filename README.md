# opencodezen

> **This is opencodezen**, a fork of [cucoleadan/opencode-cowork-proxy](https://github.com/cucoleadan/opencode-cowork-proxy). Its main job: **run the OpenCode app's own providers (OpenCode Console / Zen, and OpenCode Go) through Cloudflare.** The original Anthropic-format routes for Claude Desktop / Claude Code are kept. See [opencodezen: OpenCode through Cloudflare](#opencodezen-opencode-through-cloudflare) below, and [prompt.md](prompt.md) to hand the setup to an agent on another machine.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/raphaelmans/opencodezen)

## opencodezen: OpenCode through Cloudflare

Live Worker: **https://api.raphaelmansueto.com**

### Domain and naming

- `api.raphaelmansueto.com` is a Workers **custom domain**. The `raphaelmansueto.com` zone's DNS is on Cloudflare (moved from GoDaddy on 2026-11-19). The website itself still runs on Vercel: the apex `A 76.76.21.21` and `www CNAME cname.vercel-dns.com` records are **DNS only** (grey cloud).
- Public paths are provider-neutral: `/chat/v1` and `/chat/go/v1`. The info page (`GET /`) names no upstream provider.
- The old `/opencode/...` paths were removed on 2026-11-19. The `*.workers.dev` URL is still enabled (`workers_dev = true` in `wrangler.toml`) as a fallback while the new domain's IPv6 TLS settles; set it to `false` to retire it.
- A brand-new custom domain can have slow TLS handshakes (seconds) for a while, until Cloudflare's certificate is fully rolled out. A Mac may also cache "no such host" for its IPv4 address from before activation. Flush the cache with `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`.

### How it works

`<worker-url>/chat/*` is a transparent pass-through to OpenCode's inference endpoints. It keeps the request method, body, streaming responses and OpenCode's own headers (`User-Agent`, `x-opencode-*`, auth). It also forwards the real client IP in `X-Forwarded-For` / `X-Real-IP`. No format translation happens.

OpenCode's catalog gives each model family its own upstream: `opencode.ai/inference/[go/]openai/v1`, `…/anthropic/v1` and `…/google/v1beta`. A provider-wide `baseURL` override sends all of them to one URL, so the Worker picks the family from the request's shape:

| Request path (after `/chat` or `/chat/go`) | Upstream |
|---|---|
| `/v1/models/<id>:generateContent` or `:streamGenerateContent` (Gemini) | `inference/[go/]google/v1beta/...` |
| `/v1/messages...` (Claude, Qwen, MiniMax M3) | `inference/[go/]anthropic/v1/...` |
| any other `/v1/...` (`chat/completions`, `responses`, `models`) | `inference/[go/]openai/v1/...` |

Without this, Gemini returns `Provider request failed with HTTP 404`: the older `zen/v1` path has no Gemini endpoint.

| OpenCode provider | Sign-in in OpenCode 2.x | Base URL through the Worker |
|-------------------|-------------------------|-----------------------------|
| `opencode` (Console / Zen models) | **OpenCode Console** | `<worker-url>/chat/v1` |
| `opencode-go` (Go subscription) | **OpenCode Go** | `<worker-url>/chat/go/v1` |

OpenCode 2.x has no separate "Zen" sign-in. Zen's pay-as-you-go models come through the **OpenCode Console** sign-in, and the provider id is still `opencode`.

### Install OpenCode (mise)

```bash
mise use -g opencode@latest   # verified with 2.3.2
opencode auth login           # choose OpenCode Console (and/or OpenCode Go), paste an API key from opencode.ai/console
```

The first launch of 2.x can take about a minute while plugins install. Until then you may see `Location plugins did not finish activating`.

OpenCode 2.x runs a background service that keeps the config it loaded. After editing the config, run `opencode reload` (or `opencode run --standalone …` for a one-off check). Symptom of a stale service: `Provider request failed with HTTP 404` whose body is this Worker's info page (`{"name": "api", "status": "ok", …}`), meaning OpenCode is still calling an old path.

If you see `Reconnect OpenCode Console to continue`, the Console rejected the saved key. The key list only shows the start of each key; the full key appears once, at creation. Sign in again with the browser option, or paste a freshly created key.

### Point OpenCode at the Worker

Global (`~/.config/opencode/opencode.json`) or per project (`opencode.json`).

OpenCode 2.x format:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "opencode":    { "settings": { "baseURL": "https://api.raphaelmansueto.com/chat/v1" } },
    "opencode-go": { "settings": { "baseURL": "https://api.raphaelmansueto.com/chat/go/v1" } }
  }
}
```

OpenCode 1.x format (2.x still reads it and converts it on load):

```json
{
  "provider": {
    "opencode": { "options": { "baseURL": "https://api.raphaelmansueto.com/chat/v1" } }
  }
}
```

To use a key other than the stored sign-in, add `"apiKey": "{env:OPENCODE_ZEN_KEY}"` next to `baseURL` and export that variable.

### What works (verified 2026-11-19, OpenCode 1.18.25 and 2.3.2)

| Check | Result |
|-------|--------|
| OpenCode requests reach the Worker (`/chat/v1/chat/completions`, `/responses`) with OpenCode's own `User-Agent` | ✅ |
| Paid Console / Zen models (e.g. `gpt-5.4-nano`) | ✅ 200 |
| Model lists: `/chat/v1/models` (Console / Zen), `/chat/go/v1/models` (Go) | ✅ |
| Go models in the OpenCode app (`opencode-go` override → `/chat/go/v1`) | ✅ 200 with an active Go subscription, all three formats: `gemini-4-argon` (Google), `qwen3.8-flash` (Anthropic), `glm-5.3-flash` (OpenAI). Without a subscription: 403 `permission_error`. |
| Console Gemini (`opencode/gemini-4-argon`) | ✅ 200 |
| **Free Zen models** (`big-pickle`, `*-free`) | ❌ **Refused when proxied**: `429 Client IP address is required for free usage.` |

**Free models need OpenCode connecting directly.** Zen takes the user's IP from Cloudflare's edge. A Worker's subrequest hides it, and `X-Forwarded-For` is not trusted for free usage. This is intentional on OpenCode's side, so don't try to work around it. To use free models, remove the `baseURL` override.

### Test a deployment

```bash
./test-proxy.sh <worker-url> chat <paid-zen-model>   # Console / Zen pass-through
./test-proxy.sh <worker-url> chat-go <go-model>      # Go pass-through
./test-proxy.sh <worker-url> go <go-model>               # Anthropic-format route (Claude clients)
```

The script asks for your key with hidden input and never prints it. To watch live traffic, run `npx wrangler tail opencodezen`.

### Other changes in this fork

- The Anthropic-format routes (`/go`, `/zen`) send `X-Opencode-Session` (taken from the client's `X-Opencode-Session`, `X-Claude-Code-Session-Id` or `X-Session-Id`) and a `User-Agent`. OpenCode Go requires both from third-party clients; without them it returns `MissingSessionID`.
- The Worker is named `opencodezen` in `wrangler.toml`.

## Original project: Claude Desktop / Claude Code

> The sections below are from upstream and describe the original Claude Desktop / Claude Code setup. Their free-model tables are out of date: free Zen models no longer work through any proxy.

This project lets Claude use OpenCode Go models, and some OpenCode Zen models.

Claude normally speaks the Anthropic API format. OpenCode Go mostly speaks OpenAI-compatible API format. This small Cloudflare Worker sits in the middle and translates between them.

I covered how to set this up in Claude in [How to Use Claude Code for Free with OpenCode](https://vibestacklab.substack.com/p/how-to-use-claude-code-for-free-with).

### Image / Vision Support

When you attach an image in Claude Code and send it through this proxy, the request is automatically routed to **Qwen3.6 Plus** (`qwen3.6-plus`) — a vision-capable model available on both OpenCode Go and OpenCode Zen. This happens transparently: the proxy detects image blocks in your request, translates them to OpenAI's image format, and overrides the model to Qwen3.6 Plus so the model can actually see the image.

No configuration needed — it just works as long as you have an OpenCode Go or Zen subscription.

## Free Models

We support a pay-as-you-go model. Below are the prices per 1M tokens for completely free models available through OpenCode Zen.

| Model | Model ID | Input | Output | Cached Read |
|-------|----------|-------|--------|-------------|
| Big Pickle | `big-pickle` | Free | Free | Free |
| DeepSeek V4 Flash Free | `deepseek-v4-flash-free` | Free | Free | Free |
| MiMo-V2.5 Free | `mimo-v2.5-free` | Free | Free | Free |
| North Mini Code Free | `north-mini-code-free` | Free | Free | Free |
| Nemotron 3 Ultra Free | `nemotron-3-ultra-free` | Free | Free | Free |

These models are available at `https://opencode.ai/zen/v1/chat/completions` via the `/zen` prefix. For the full model list and latest pricing, see the [OpenCode Zen endpoint docs](https://opencode.ai/docs/zen/#endpoints).

## Set Up In Claude

If you want the fastest working setup, use `mimo-v2.5-free` as the first model.

1. Deploy this Worker to Cloudflare.
2. Copy your deployed Worker URL.
3. In Claude, open **Configure third-party Inference**.
4. Choose the gateway / third-party inference option.
5. Set the base URL to `YOUR_DEPLOYED_WORKER_URL/zen`.
6. Set the auth scheme to `x-api-key`.
7. Paste your OpenCode API key.
8. Add `mimo-v2.5-free` as the model name.

Important: do not add `/v1/messages` to the URL. Claude adds that path automatically.

## Quick Claude Configuration

Use these values in Claude's **Configure third-party Inference** screen:

| Setting | Value |
|---------|-------|
| Provider | Gateway / third-party inference gateway |
| Base URL | `YOUR_DEPLOYED_WORKER_URL/zen` |
| Auth scheme | `x-api-key` |
| API key | Your OpenCode API key |
| Models | Add manually, for example `mimo-v2.5-free` |

For the default example above, use `/zen` because `mimo-v2.5-free` is a Zen model. Use `/go` for OpenCode Go models instead. Do not add `/v1/messages` yourself. Claude adds the API path automatically.

## What This Does

The Worker accepts Claude's Anthropic-style requests at `/v1/messages`, converts them to OpenAI-style requests, and sends them to OpenCode Go by default.

You can choose an OpenCode upstream by adding a prefix to the Worker URL:

| Worker URL suffix | Upstream |
|-------------------|----------|
| no suffix | OpenCode Go |
| `/go` | OpenCode Go |
| `/zen` | OpenCode Zen |

For example, use `YOUR_DEPLOYED_WORKER_URL/go` for Go models and `YOUR_DEPLOYED_WORKER_URL/zen` for Zen models.

It also handles tool calls, streaming, and DeepSeek reasoning output so coding-agent workflows work correctly.

Important: this proxy has been live-tested with `minimax-m3` and `minimax-m2.7`. Other OpenCode Go models are included from the public OpenCode Go model list, but provider behavior can vary, especially around streaming usage/token accounting.

## Important Zen Limitation

OpenCode Zen support is partial.

This proxy currently works with Zen models that use the OpenAI-compatible `/chat/completions` endpoint.

Known Zen model categories that should work through `/zen`:

| Zen model category | Examples |
|--------------------|----------|
| OpenAI-compatible chat models | `minimax-m2.7`, `minimax-m2.5`, `mimo-v2.5-free`, `glm-5.2`, `glm-5.1`, `glm-5`, `kimi-k2.5`, `kimi-k2.6`, `grok-build-0.1`, `big-pickle`, `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4-flash-free`, `north-mini-code-free`, `nemotron-3-ultra-free` |

Known Zen model categories that do not work yet through this proxy:

| Zen model category | Why it does not work yet |
|--------------------|--------------------------|
| GPT models such as `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.3-codex`, `gpt-5.2` | Zen exposes these through `/responses`, and this proxy does not yet translate Anthropic Messages to OpenAI Responses API. |
| Claude models such as `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` | Zen exposes these through `/messages`; this proxy's `/zen` Claude path currently translates to OpenAI-compatible `/chat/completions`. |
| Qwen models such as `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`, `qwen3.5-plus` | Zen exposes these through `/messages` (Anthropic-compatible), not `/chat/completions`. |
| Gemini models such as `gemini-3.5-flash`, `gemini-3.1-pro`, `gemini-3-flash` | Zen exposes these through model-specific endpoints, not the generic chat-completions path used here. |

Use `/go` for OpenCode Go. Use `/zen` only for Zen models listed as OpenAI-compatible chat models in the [OpenCode Zen endpoint docs](https://opencode.ai/docs/zen/#endpoints).

## For Developers (OpenCode Cowork Proxy Worker)

Technically, this is a Cloudflare Worker gateway that lets Anthropic/Claude clients talk to OpenAI-compatible APIs, and lets OpenAI clients talk to Anthropic-compatible APIs.

The default upstream is [OpenCode Go](https://opencode.ai/docs/go/#endpoints):

```text
https://opencode.ai/zen/go/v1
```

This means Claude can be configured to use OpenCode Go models through this proxy without additional server-side configuration.

```text
Claude / Anthropic SDK  ->  /v1/messages           ->  OpenAI-compatible upstream
OpenAI SDK              ->  /v1/chat/completions   ->  OpenAI-compatible upstream
OpenAI SDK              ->  /v1/chat/completions   ->  Anthropic upstream with x-upstream-format: anthropic
```

## Detailed Claude Setup

Use Claude's **Configure third-party Inference** flow and add the Worker as a custom gateway.

Configure the gateway like this:

| Setting | Value |
|---------|-------|
| Base URL | Your deployed Worker URL, or add `/go` or `/zen` |
| Auth scheme | `x-api-key` |
| API key | Your OpenCode Go API key |
| Model | Add manually, for example `deepseek-v4-pro` |

Do not include `/v1/messages` in the Claude base URL. Claude will call `/v1/messages`; the Worker handles that path.

Use `/go` for OpenCode Go subscription models. Use `/zen` only for OpenCode Zen models available through the OpenAI-compatible `/chat/completions` endpoint. Zen GPT `/responses`, Zen Claude `/messages`, and Zen Gemini model-specific endpoints are not supported yet.

### Manual Model Setup

Claude may not discover the OpenCode Go models automatically. Add the model manually in **Configure third-party Inference**.

Common OpenCode Go model IDs:

| Model | Model ID | Upstream API style |
|-------|----------|--------------------|
| GLM-5.2 | `glm-5.2` | OpenAI-compatible |
| GLM-5.1 | `glm-5.1` | OpenAI-compatible |
| Kimi K2.7 | `kimi-k2.7` | OpenAI-compatible |
| Kimi K2.6 | `kimi-k2.6` | OpenAI-compatible |
| DeepSeek V4 Pro | `deepseek-v4-pro` | OpenAI-compatible |
| DeepSeek V4 Flash | `deepseek-v4-flash` | OpenAI-compatible |
| MiMo-V2.5-Pro | `mimo-v2.5-pro` | OpenAI-compatible |
| MiMo-V2.5 | `mimo-v2.5` | OpenAI-compatible |
| MiniMax M3 | `minimax-m3` | Anthropic-compatible upstream |
| MiniMax M2.7 | `minimax-m2.7` | Anthropic-compatible upstream |
| MiniMax M2.5 | `minimax-m2.5` | Anthropic-compatible upstream |
| Qwen3.7 Max | `qwen3.7-max` | Anthropic-compatible upstream |
| Qwen3.7 Plus | `qwen3.7-plus` | Anthropic-compatible upstream |
| Qwen3.6 Plus | `qwen3.6-plus` | Anthropic-compatible upstream |

For the latest list, see the OpenCode Go endpoint docs:

```text
https://opencode.ai/docs/go/#endpoints
```

For OpenCode's own config files, model IDs use the `opencode-go/<model-id>` format. For Claude's third-party inference setup through this proxy, use the raw API model ID such as `deepseek-v4-pro`, `kimi-k2.6`, or `minimax-m3`.

### `claude.json` Example

You can also configure Claude with a `claude.json` gateway entry. Replace the Worker URL and API key with your own values.

```json
{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "YOUR_DEPLOYED_WORKER_URL/go",
  "inferenceGatewayApiKey": "YOUR_OPENCODE_GO_API_KEY",
  "inferenceGatewayAuthScheme": "x-api-key",
  "inferenceModels": [
    {
      "name": "glm-5.2"
    },
    {
      "name": "glm-5.1"
    },
    {
      "name": "kimi-k2.7"
    },
    {
      "name": "kimi-k2.6"
    },
    {
      "name": "deepseek-v4-pro"
    },
    {
      "name": "deepseek-v4-flash"
    },
    {
      "name": "mimo-v2.5-pro"
    },
    {
      "name": "mimo-v2.5"
    },
    {
      "name": "minimax-m3"
    },
    {
      "name": "minimax-m2.7"
    },
    {
      "name": "minimax-m2.5"
    },
    {
      "name": "qwen3.7-max"
    },
    {
      "name": "qwen3.7-plus"
    },
    {
      "name": "qwen3.6-plus"
    }
  ]
}
```

## Deploy On Cloudflare

This project is intended to run as a Cloudflare Worker. Deploy it to Cloudflare using either the deploy button above or Cloudflare's Git-based Worker deployment flow.

Use these settings when connecting the repository in Cloudflare:

| Setting | Value |
|---------|-------|
| Build command | empty |
| Deploy command | `npm run deploy` |
| Production branch | `main` |

Do not deploy this as a normal Node.js web app. `wrangler deploy` builds and publishes the Worker from `wrangler.toml`.

## Configuration

The Worker is zero-config by default. It forwards to OpenCode Go using OpenAI-compatible format. You can also route to OpenCode Zen by adding `/zen` to the Worker URL.

Optional request headers:

| Header | Default | Description |
|--------|---------|-------------|
| `x-upstream-url` | `https://opencode.ai/zen/go/v1` | Upstream API base URL |
| `x-upstream-format` | `openai` | Upstream format: `openai` or `anthropic` |
| `x-api-key` | required | Upstream API key |
| `authorization` | optional | `Bearer <key>` also works |
| `anthropic-version` | `2023-06-01` | Forwarded when calling Anthropic-compatible upstreams |
| `anthropic-beta` | unset | Forwarded when calling Anthropic-compatible upstreams |

The API key is validated locally before any upstream call. Missing or short keys receive a 401 response.

Prefix routes:

| Path prefix | Upstream base URL |
|-------------|-------------------|
| `/go` | `https://opencode.ai/zen/go/v1` |
| `/zen` | `https://opencode.ai/zen/v1` |

### Model Name Override

Claude Desktop may reject model names that don't look like Anthropic models (e.g. `claude-sonnet-4-5` or `anthropic/claude-*`). To work around this, embed the real model name in the URL path after the prefix:

```
YOUR_DEPLOYED_WORKER_URL/zen/mimo-v2.5-free   # free Zen models
YOUR_DEPLOYED_WORKER_URL/go/deepseek-v4-pro   # paid Go models
```

Claude appends `/v1/messages`, so the full request becomes `YOUR_WORKER_URL/zen/mimo-v2.5-free/v1/messages`. The proxy extracts the model from the path and uses it regardless of what Claude sends in the request body.

**Usage:**
1. Configure Claude with any Anthropic-looking model name (e.g. `claude-sonnet-4-5-20250514`) — this passes Claude's client-side validation.
2. Set the base URL to `YOUR_WORKER_URL/zen/REAL_MODEL_ID` (replace `REAL_MODEL_ID` with the actual OpenCode model).
3. The proxy silently maps the model for the upstream request.
4. The response uses the original model name you configured, so Claude sees consistency.

| Setting | Value |
|---------|-------|
| Base URL | `YOUR_WORKER_URL/zen/mimo-v2.5-free` |
| Auth scheme | `x-api-key` |
| API key | Your OpenCode API key |
| Model | `claude-sonnet-4-5-20250514` (any Anthropic-looking name) |

This works with all Go and Zen models.

## API Endpoints

| Path | Method | Purpose |
|------|--------|---------|
| `/chat/*` | any | **opencodezen:** transparent pass-through to `https://opencode.ai/inference/{openai,anthropic,google}` for the OpenCode app (family picked from the path). |
| `/v1/messages` | POST | Anthropic Messages API. Translates to OpenAI format by default. |
| `/v1/chat/completions` | POST | OpenAI Chat Completions API. Pass-through by default. |
| `/v1/models` | GET | Model discovery proxy. |

## OpenAI SDK Usage

Point any OpenAI-compatible client at the gateway. By default, `/v1/chat/completions` passes through to OpenCode Go.

```python
from openai import OpenAI

client = OpenAI(
    base_url="YOUR_DEPLOYED_WORKER_URL/v1",
    api_key="your-opencode-go-api-key",
)

response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=[{"role": "user", "content": "Hello"}],
)
```

## OpenAI SDK To Anthropic

Set `x-upstream-format: anthropic` and point `x-upstream-url` at an Anthropic-compatible API.

```bash
curl YOUR_DEPLOYED_WORKER_URL/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_ANTHROPIC_KEY" \
  -H "x-upstream-url: https://api.anthropic.com" \
  -H "x-upstream-format: anthropic" \
  -d '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"Hello"}]}'
```

## Translation Notes

The gateway handles:

- Anthropic Messages requests to OpenAI Chat Completions requests
- OpenAI Chat Completions responses to Anthropic Messages responses
- Tool calls and tool results in both directions
- Streaming SSE in both directions
- DeepSeek/OpenAI `reasoning_content` as Anthropic `thinking` blocks
- Prompt cache key injection for OpenAI-style prefix caching

## Prompt Caching

When translating Anthropic to OpenAI, the gateway injects a `prompt_cache_key` derived from a hash of the system prompt. This keeps requests with the same system prompt routed to the same backend node when the upstream supports OpenAI-style prefix caching.

Cache hit tokens from OpenAI-compatible usage metadata are mapped back to Anthropic's `cache_read_input_tokens` field.

## Development

```bash
npm install
npm test
npm run deploy -- --dry-run
```

Project structure:

```text
src/
├── index.ts                          Main Worker router and auth gate
├── auth.ts                           API key extraction and validation
├── cache.ts                          Prompt cache key utilities
└── translate/
    ├── request/                      Request translators
    ├── response/                     Response translators
    └── stream/                       SSE stream translators
test/
├── auth.test.ts
├── cache.test.ts
├── index.test.ts
├── request.test.ts
├── response.test.ts
└── stream.test.ts
```

## Community Resources

Community-maintained projects that complement this proxy. These are independently maintained by their respective authors.

- [claude-cowork-local](https://github.com/a-a-borodin/claude-cowork-local) - A local wrapper that helps avoid shared Cloudflare IP rate limits when using the free Zen tier.

## License

MIT. See [LICENSE](LICENSE).
