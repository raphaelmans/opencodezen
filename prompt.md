# Handover prompt: set up OpenCode through opencodezen on this machine

Paste everything below the line into a coding agent (Claude Code, OpenCode, Codex…) on the new machine.

---

You are setting up this machine so that **the OpenCode app uses its own providers (OpenCode Console / Zen, and OpenCode Go) through a Cloudflare Worker called opencodezen**. Work step by step. Stop and ask me whenever a step needs my sign-in, approval, a secret, or a change to app settings.

## Facts

- Repo: https://github.com/raphaelmans/opencodezen (fork of `cucoleadan/opencode-cowork-proxy`, MIT).
- **Live Worker: https://api.raphaelmansueto.com**. It is already deployed, so a new machine does not need to redeploy. Public paths are `/chat/v1` and `/chat/go/v1`.
- The domain's DNS is on Cloudflare; the website `raphaelmansueto.com` / `www` runs on Vercel through **DNS only** records. Never proxy or delete those two records.
- `<worker-url>/chat/*` is a transparent pass-through to OpenCode's inference endpoints (`opencode.ai/inference/[go/]{openai,anthropic,google}`). The Worker picks the family from the request path (Gemini `:streamGenerateContent` → google, `/messages` → anthropic, else openai). It keeps OpenCode's headers and streaming, and forwards the real client IP.
- OpenCode providers and their base URLs through the Worker:
  - `opencode` (Console / Zen models; sign-in **OpenCode Console**): `<worker-url>/chat/v1`
  - `opencode-go` (Go subscription; sign-in **OpenCode Go**): `<worker-url>/chat/go/v1`
- OpenCode 2.x has **no separate Zen sign-in**. Zen models come through **OpenCode Console**, and the provider id is still `opencode`.
- The Worker stores no key. OpenCode's own key passes through to opencode.ai only.

## Known limits (verified 2026-11-19 with OpenCode 1.18.25 and 2.3.2)

- ✅ OpenCode requests reach the Worker with OpenCode's own `User-Agent`. Paid Console / Zen models (e.g. `gpt-5.4-nano`) return 200.
- ❌ **Free Zen models (`big-pickle`, `*-free`) are refused when proxied**: `429 Client IP address is required for free usage.` Zen takes the user's IP from Cloudflare's edge, and a Worker hides it. This is intentional; **do not try to work around it.** For free models, remove the `baseURL` override.
- ✅ Go through the Worker works in the app with an active Go subscription, in all three API formats (verified: `gemini-4-argon`, `qwen3.8-flash`, `glm-5.3-flash`). Console Gemini works too. Without a subscription Go answers 403.
- If a model fails with `Provider request failed with HTTP 404`, check the Worker log path: a new API family may need a rule in `upstreamFor` (src/index.ts).
- OpenCode 2.x keeps loaded config in a background service: after editing config, quit OpenCode fully, or check with `opencode run --standalone -m <model> "…"`.
- `Reconnect OpenCode Console to continue` means the Console rejected the saved key (often a shortened key copied from the key list). Sign in with the browser option, or paste a freshly created key.
- "This API key has expired" means: create a new key in the OpenCode Console and run `opencode auth login` again. Signing in again with the old key does not renew it.

## Steps

1. **Check the Worker.** Run `curl https://api.raphaelmansueto.com/`. It must return JSON whose `routes` include `/chat/v1`. If it doesn't answer, tell me; redeploy only if I ask (see "Redeploying").
2. **Install OpenCode with mise.**
   - If an older OpenCode exists (`which -a opencode`), show me where it lives and ask before removing it. Remove only the binary and its PATH line (e.g. `~/.opencode/bin` in `~/.zshrc`). Keep `~/.config/opencode`, `~/.local/share/opencode` and plugin folders.
   - `mise use -g opencode@latest`, then open a new shell and confirm with `opencode --version` (2.3.2 or later).
   - The first launch can take about a minute ("Location plugins did not finish activating") while plugins install. Wait and retry.
3. **Sign in.** Ask me to run `opencode auth login` and choose **OpenCode Console** (and **OpenCode Go** if I subscribe), pasting a fresh key from opencode.ai/console. Never type, print or store the key yourself. Check with `opencode auth list`.
4. **Point OpenCode at the Worker** (ask first; back up the file before editing). In `~/.config/opencode/opencode.json`, merge this in and keep everything else:
   ```json
   {
     "providers": {
       "opencode":    { "settings": { "baseURL": "https://api.raphaelmansueto.com/chat/v1" } },
       "opencode-go": { "settings": { "baseURL": "https://api.raphaelmansueto.com/chat/go/v1" } }
     }
   }
   ```
   That is the 2.x format. If the file already uses the 1.x format (`"provider"` singular, with `"options"`), add `"provider": {"opencode": {"options": {"baseURL": "…/chat/v1"}}}` instead; 2.x converts it on load. Check that it applies: `opencode debug config` should show the `baseURL` under `opencode`.
5. **Verify the traffic goes through the Worker.**
   - In one terminal: `git clone https://github.com/raphaelmans/opencodezen && cd opencodezen && npm ci && npx wrangler tail opencodezen` (needs `npx wrangler login`, which I approve in the browser).
   - In another: `opencode run -m opencode/<paid-model> "Reply with exactly: PROXY OK"`. Ask me before running a paid model; it costs a fraction of a cent.
   - The tail must show `POST /chat/v1/...` with an `opencode/...` user agent and status 200. Then do the same with an `opencode-go/<model>` (e.g. `qwen3.8-flash`) if I have Go; expect `POST /chat/go/v1/...` 200.
   - Optional, without the app: `./test-proxy.sh https://api.raphaelmansueto.com chat <paid-model>` (it asks for the key with hidden input).
6. **Report** what passed, what failed with the exact error text, and the OpenCode version.

## Redeploying (only if I ask)

```bash
cd opencodezen && npm ci && npx vitest run   # all tests must pass
npx wrangler login && npx wrangler deploy
```

If Cloudflare says there is no `workers.dev` subdomain, open `https://dash.cloudflare.com/?to=/:account/workers/workers-and-pages` once in the browser; that creates one. Then deploy again. A new subdomain can take a couple of minutes to resolve. If the URL changes, update the `baseURL` values.

## Undo

Remove the `opencode` / `opencode-go` `baseURL` entries (or restore your backup). OpenCode then talks to opencode.ai directly, and free models work again.

## Other clients (optional)

The same Worker also serves Anthropic-format routes for Claude Desktop / Claude Code: `<worker-url>/go` and `<worker-url>/zen`, with auth scheme `x-api-key`. See the README's "Original project" section. Changing Claude Desktop's inference settings restarts it and reroutes all its traffic, so do that only when I say so.

## Rules

- Never put my API key in files, commits, logs or chat. I enter it myself at prompts.
- Don't send client code or secrets through free or trial models; they may train on inputs.
- Ask before anything that costs money, changes account or app settings, deletes files, or publishes something.
