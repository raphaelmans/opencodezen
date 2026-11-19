# Handover prompt: set up opencodezen on this machine

Paste everything below the line into a coding agent (Claude Code, OpenCode, Codex…) on the new machine.

---

You are setting up **opencodezen**, a Cloudflare Worker that proxies OpenCode Zen. Main use: the **OpenCode app itself uses its `opencode` (Zen) provider, routed through this Worker**. It also lets Anthropic-format clients (Claude Desktop / Cowork, Claude Code) reach OpenCode models. Work step by step and stop to ask me whenever a step needs my sign-in, approval, or a secret.

## Facts

- Repo: https://github.com/raphaelmans/opencodezen (fork of `cucoleadan/opencode-cowork-proxy`, MIT).
- Worker name: `opencodezen` (set in `wrangler.toml`).
- **Live Worker URL: https://opencodezen.nameless-hill-af77.workers.dev** (deployed 2026-11-19). Use it as `<worker-url>`; a new machine does not need to redeploy.
- Routes: `<worker-url>/opencode/*` → `https://opencode.ai/zen/*` **transparent pass-through for the OpenCode app** (keeps OpenCode's headers, request formats and streaming; forwards the real client IP). `<worker-url>/zen` → `https://opencode.ai/zen/v1` (pay-as-you-go Zen models), `<worker-url>/go` → `https://opencode.ai/zen/go/v1` (OpenCode Go subscription).
- Auth: the client sends its OpenCode API key as `x-api-key`. The Worker stores no key; it forwards it only to opencode.ai.
- This fork adds what OpenCode Go now requires from third-party clients: a stable `X-Opencode-Session` header (taken from the client's `X-Opencode-Session`, `X-Claude-Code-Session-Id` or `X-Session-Id`) and its own `User-Agent`. Without a session id, Go answers `MissingSessionID`.

## Known limits (verified 2026-11-19 against the live Worker)

- **Through `/opencode`, paid Zen models work** (verified: OpenCode's `gpt-5.4-nano` calls returned 200).
- **Free Zen models do not work through any Cloudflare proxy.** Zen answers `429 Client IP address is required for free usage.` It takes the user's IP from Cloudflare's edge, and a Worker's subrequest hides it (`X-Forwarded-For` is not trusted). This is by design; do not try to work around it. Use free models with OpenCode directly, without the proxy.

- **Free Zen models (`*-free`, `big-pickle`) do not work through this proxy.** OpenCode's docs: free-tier chat models require the OpenCode app; other clients get `FreeUsageLimitError` (429). `minimax-m2.5-free` is retired.
- **Go models need an active OpenCode Go subscription** (otherwise 403 `permission_error`).
- Some Go models (e.g. `deepseek-v4.1-flash`) are hosted outside the EU/US and need "Global" enabled under OpenCode console → Settings → Privacy → Regions.
- Check current model ids with `GET <worker-url>/go/v1/models` or `/zen/v1/models` (send `x-api-key`).

## Steps

1. **Prerequisites.** Confirm Node.js ≥ 20 and git. Check whether the live Worker answers (`curl https://opencodezen.nameless-hill-af77.workers.dev/`). If it does, still do step 2 (you need `test-proxy.sh`) but skip step 3; only redeploy if I ask or it is gone.
2. **Get the code and test it.**
   ```bash
   git clone https://github.com/raphaelmans/opencodezen && cd opencodezen
   npm ci && npx vitest run
   ```
   All tests must pass.
3. **Deploy.** Run `npx wrangler login` (I approve in the browser), then `npx wrangler deploy`. If Cloudflare asks to register a `workers.dev` subdomain, let me choose it. Note the URL it prints: `https://opencodezen.<subdomain>.workers.dev`.
4. **Smoke test without a key.** `curl <worker-url>/` must return JSON with `"name": "opencode-cowork-proxy"`, and a POST to `<worker-url>/go/v1/messages` with no key must return a 401 `authentication_error`.
5. **Full test with my key.** Run `./test-proxy.sh <worker-url> go <model>` (it prompts for the key with hidden input; never echo, log, or commit the key). It checks model listing, a plain reply, streaming, and tool use. If I have no Go subscription, expect 403 and stop there — report it, don't work around it.
6. **Point a client at it** (only when I say so — this changes the app's settings):
   - **OpenCode (main use case):** add this to the project's `opencode.json` (or the global `~/.config/opencode/opencode.json` if I ask). OpenCode keeps using its own stored OpenCode key; to use a different key, add `"apiKey": "{env:OPENCODE_ZEN_KEY}"` under `options` and export that variable.
     ```json
     {
       "$schema": "https://opencode.ai/config.json",
       "provider": {
         "opencode": {
           "options": { "baseURL": "https://opencodezen.nameless-hill-af77.workers.dev/opencode/v1" }
         }
       }
     }
     ```
     Test with a paid Zen model: `opencode run -m opencode/<paid-model> "Reply with exactly: PROXY OK"`, and confirm with `npx wrangler tail opencodezen` that requests hit `/opencode/v1/...`. If OpenCode says "This API key has expired", ask me to create a new key in the OpenCode console and run `opencode auth login`.
   - **Claude Desktop:** Help → Troubleshooting → Enable Developer Mode, then Developer → Configure Third-Party Inference. Backend `Gateway`, base URL `<worker-url>/go` (or `/zen`), auth scheme `x-api-key`, API key = mine (I type it), model = an id from the list, added to the model list by hand. Apply locally, then fully quit and reopen Claude.
   - **Claude Code CLI:** `ANTHROPIC_BASE_URL=<worker-url>/go ANTHROPIC_API_KEY=<my key> ANTHROPIC_MODEL=<model> claude`. Claude Code already sends a session header that Go recognises.
7. **Report** what passed, what failed with the exact error text, and the Worker URL.

## Rules

- Never paste my API key into files, commits, or chat output. I enter it myself at prompts.
- Don't send client code or secrets through free/trial models; they may train on inputs.
- Ask before anything that costs money, changes account settings, or publishes something.
