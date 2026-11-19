# Handover prompt: set up opencodezen on this machine

Paste everything below the line into a coding agent (Claude Code, OpenCode, Codex…) on the new machine.

---

You are setting up **opencodezen**, a Cloudflare Worker that lets Anthropic-format clients (Claude Desktop / Cowork, Claude Code) talk to OpenCode models. Work step by step and stop to ask me whenever a step needs my sign-in, approval, or a secret.

## Facts

- Repo: https://github.com/raphaelmans/opencodezen (fork of `cucoleadan/opencode-cowork-proxy`, MIT).
- Worker name: `opencodezen` (set in `wrangler.toml`).
- **Live Worker URL: https://opencodezen.nameless-hill-af77.workers.dev** (deployed 2026-11-19). Use it as `<worker-url>`; a new machine does not need to redeploy.
- Routes: `<worker-url>/zen` → `https://opencode.ai/zen/v1` (pay-as-you-go Zen models), `<worker-url>/go` → `https://opencode.ai/zen/go/v1` (OpenCode Go subscription).
- Auth: the client sends its OpenCode API key as `x-api-key`. The Worker stores no key; it forwards it only to opencode.ai.
- This fork adds what OpenCode Go now requires from third-party clients: a stable `X-Opencode-Session` header (taken from the client's `X-Opencode-Session`, `X-Claude-Code-Session-Id` or `X-Session-Id`) and its own `User-Agent`. Without a session id, Go answers `MissingSessionID`.

## Known limits (verified 2026-11-19 against the live Worker)

- **Free Zen models (`*-free`, `big-pickle`) do not work through this proxy.** OpenCode's docs: free-tier chat models require the OpenCode app; other clients get `FreeUsageLimitError` (429). `minimax-m2.5-free` is retired.
- **Go models need an active OpenCode Go subscription** (otherwise 403 `permission_error`).
- Some Go models (e.g. `deepseek-v4.1-flash`) are hosted outside the EU/US and need "Global" enabled under OpenCode console → Settings → Privacy → Regions.
- Check current model ids with `GET <worker-url>/go/v1/models` or `/zen/v1/models` (send `x-api-key`).

## Steps

1. **Prerequisites.** Confirm Node.js ≥ 20 and git. Check whether the live Worker answers (`curl https://opencodezen.nameless-hill-af77.workers.dev/`). If it does, skip to step 4; only redeploy if I ask or it is gone.
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
   - **Claude Desktop:** Help → Troubleshooting → Enable Developer Mode, then Developer → Configure Third-Party Inference. Backend `Gateway`, base URL `<worker-url>/go` (or `/zen`), auth scheme `x-api-key`, API key = mine (I type it), model = an id from the list, added to the model list by hand. Apply locally, then fully quit and reopen Claude.
   - **Claude Code CLI:** `ANTHROPIC_BASE_URL=<worker-url>/go ANTHROPIC_API_KEY=<my key> ANTHROPIC_MODEL=<model> claude`. Claude Code already sends a session header that Go recognises.
7. **Report** what passed, what failed with the exact error text, and the Worker URL.

## Rules

- Never paste my API key into files, commits, or chat output. I enter it myself at prompts.
- Don't send client code or secrets through free/trial models; they may train on inputs.
- Ask before anything that costs money, changes account settings, or publishes something.
