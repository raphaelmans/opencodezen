import { Hono } from 'hono';
import { extractApiKey, validateApiKey, authErrorResponse } from './auth';
import { formatAnthropicToOpenAI } from './translate/request/anthropic-to-openai';
import { formatOpenAIToAnthropic } from './translate/request/openai-to-anthropic';
import { formatOpenAIToAnthropic as toAnthropicResponse } from './translate/response/openai-to-anthropic';
import { formatAnthropicToOpenAI as toOpenAIResponse } from './translate/response/anthropic-to-openai';
import { streamOpenAIToAnthropic } from './translate/stream/openai-to-anthropic';
import { streamAnthropicToOpenAI } from './translate/stream/anthropic-to-openai';

const GO_UPSTREAM = "https://opencode.ai/zen/go/v1";
const ZEN_UPSTREAM = "https://opencode.ai/zen/v1";
const DEFAULT_UPSTREAM = GO_UPSTREAM;
const VISION_MODEL = "qwen3.6-plus";

const API_START_PATHS = new Set(['v1', 'v2']);
const ZEN_ORIGIN = "https://opencode.ai/zen";
const PASSTHROUGH_PREFIX = "/opencode";
const HOP_HEADERS = new Set([
  "host", "content-length", "connection", "keep-alive", "transfer-encoding",
  "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip",
  "true-client-ip", "x-upstream-url", "x-upstream-format",
]);

const INFERENCE_ORIGIN = "https://opencode.ai/inference";

/**
 * Where an OpenCode request goes upstream. OpenCode's catalog (models.dev) gives
 * each model family its own base: inference/[go/]openai/v1, inference/[go/]anthropic/v1
 * and inference/[go/]google/v1beta. A provider-wide baseURL override sends every
 * family to one URL, so the family is recovered from the request's shape:
 *   .../models/<id>:<method>   -> google  (Gemini generateContent / streamGenerateContent)
 *   .../messages[...]          -> anthropic
 *   anything else under /v1    -> openai  (chat/completions, responses, models, ...)
 * `rest` is the path after the /opencode prefix, e.g. "/go/v1/messages".
 */
export function upstreamFor(rest: string): string {
  const go = rest === "/go" || rest.startsWith("/go/");
  const base = go ? `${INFERENCE_ORIGIN}/go` : INFERENCE_ORIGIN;
  const tail = go ? rest.slice(3) : rest; // "/v1/..." or "/v1beta/..."
  const m = tail.match(/^\/v1(?:beta)?(\/.*)?$/);
  if (!m) return `${ZEN_ORIGIN}${rest === "/" ? "" : rest}`; // unknown shape: legacy Zen path
  const sub = m[1] ?? "";
  if (/^\/models\/[^/]+:[A-Za-z]+$/.test(sub)) return `${base}/google/v1beta${sub}`;
  if (sub === "/messages" || sub.startsWith("/messages/")) return `${base}/anthropic/v1${sub}`;
  return `${base}/openai/v1${sub}`;
}

/**
 * Transparent pass-through for OpenCode itself: <worker>/opencode/[go/]v1/... is
 * forwarded unchanged to the matching https://opencode.ai/inference/... base (see
 * upstreamFor). Method, body, client headers (User-Agent, x-opencode-*, auth) and
 * streaming responses are preserved; no format translation happens. In OpenCode set
 * the `opencode` provider baseURL to <worker>/opencode/v1 and `opencode-go` to
 * <worker>/opencode/go/v1.
 */
export async function passthrough(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const rest = stripPrefix(url.pathname, PASSTHROUGH_PREFIX);
  if (rest === null) return null;
  const target = `${upstreamFor(rest)}${url.search}`;
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (HOP_HEADERS.has(n) || n.startsWith("cf-")) return;
    headers.set(name, value);
  });
  // Zen rate-limits free models per end-user IP ("Client IP address is
  // required"). Forward the real client IP Cloudflare saw, like any reverse proxy.
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) {
    headers.set("X-Forwarded-For", clientIp);
    headers.set("X-Real-IP", clientIp);
  }
  const hasBody = !["GET", "HEAD"].includes(request.method);
  const res = await fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "manual",
  });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

type RouteConfig = {
  path: string;
  upstream: string;
  modelOverride: string | null;
};

function stripPrefix(path: string, prefix: string): string | null {
  if (path === prefix) return "/";
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
  return null;
}

function extractModelSegment(path: string): { path: string; model: string | null } {
  const segments = path.replace(/^\/+/, '').split('/');
  if (segments.length > 0 && segments[0] && !API_START_PATHS.has(segments[0])) {
    return { path: '/' + segments.slice(1).join('/'), model: segments[0] };
  }
  return { path, model: null };
}

function routeConfig(request: Request): RouteConfig {
  const path = new URL(request.url).pathname;
  const goPath = stripPrefix(path, "/go");
  if (goPath) {
    const { path: remaining, model } = extractModelSegment(goPath);
    return { path: remaining, upstream: GO_UPSTREAM, modelOverride: model };
  }

  const zenPath = stripPrefix(path, "/zen");
  if (zenPath) {
    const { path: remaining, model } = extractModelSegment(zenPath);
    return { path: remaining, upstream: ZEN_UPSTREAM, modelOverride: model };
  }

  const { path: remaining, model } = extractModelSegment(path);
  return { path: remaining, upstream: DEFAULT_UPSTREAM, modelOverride: model };
}

function getUpstream(request: Request, routeUpstream: string): string {
  return request.headers.get("X-Upstream-Url") || routeUpstream;
}

function upstreamFormat(request: Request): "openai" | "anthropic" {
  const fmt = (request.headers.get("X-Upstream-Format") || "openai").toLowerCase();
  return fmt === "anthropic" ? "anthropic" : "openai";
}

function sessionHeaders(request: Request): Record<string, string> {
  // OpenCode Go asks third-party clients to send a stable per-conversation
  // session id and their own user agent (opencode.ai/docs/console/go).
  const h: Record<string, string> = { "User-Agent": "opencode-cowork-proxy/2.0" };
  const sid = request.headers.get("X-Opencode-Session")
    || request.headers.get("X-Claude-Code-Session-Id")
    || request.headers.get("X-Session-Id");
  if (sid) h["X-Opencode-Session"] = sid;
  return h;
}

function anthropicHeaders(request: Request, key: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": key,
    "Anthropic-Version": request.headers.get("Anthropic-Version") || "2023-06-01",
    ...sessionHeaders(request),
  };
  const beta = request.headers.get("Anthropic-Beta");
  if (beta) headers["Anthropic-Beta"] = beta;
  return headers;
}

function hasImages(body: any): boolean {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((msg: any) =>
    Array.isArray(msg.content) && msg.content.some((part: any) => part.type === "image")
  );
}

function upstreamErrorResponse(res: Response, body: string): Response {
  const headers = new Headers();
  for (const name of ["Content-Type", "Retry-After", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"]) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(body, { status: res.status, headers });
}

async function handleRequest(request: Request): Promise<Response> {
  const passed = await passthrough(request);
  if (passed) return passed;

  const route = routeConfig(request);
  const upstream = getUpstream(request, route.upstream);
  const fmt = upstreamFormat(request);

  // Anthropic → OpenAI (for Claude Desktop/Cowork → any OpenAI API)
  if (route.path === '/v1/messages' && request.method === 'POST') {
      const key = extractApiKey(request.headers);
      const err = validateApiKey(key);
      if (err) return authErrorResponse(err);

      if (fmt === "openai") {
        const req = await request.json();
        const originalModel = req.model;
        if (route.modelOverride) req.model = route.modelOverride;
        if (hasImages(req)) {
          req.model = VISION_MODEL;
        }
        const openaiReq = formatAnthropicToOpenAI(req);
        const res = await fetch(`${upstream}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key}`,
            ...sessionHeaders(request),
          },
          body: JSON.stringify(openaiReq),
        });
        if (!res.ok) return upstreamErrorResponse(res, await res.text());

        if (openaiReq.stream) {
          return new Response(streamOpenAIToAnthropic(res.body as ReadableStream, originalModel), {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
          });
        }
        const data: any = await res.json();
        return new Response(JSON.stringify(toAnthropicResponse(data, originalModel)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Pass-through to Anthropic upstream
      const res = await fetch(`${upstream}/v1/messages`, {
        method: "POST",
        headers: anthropicHeaders(request, key!),
        body: await request.text(),
      });
      return res;
  }

  // OpenAI → Anthropic (or pass-through)
  if (route.path === '/v1/chat/completions' && request.method === 'POST') {
      const key = extractApiKey(request.headers);
      const err = validateApiKey(key);
      if (err) return authErrorResponse(err);

      if (fmt === "anthropic") {
        const req = await request.json();
        const anthReq = formatOpenAIToAnthropic(req);
        const res = await fetch(`${upstream}/v1/messages`, {
          method: "POST",
          headers: anthropicHeaders(request, key!),
          body: JSON.stringify(anthReq),
        });
        if (!res.ok) return upstreamErrorResponse(res, await res.text());

        if (anthReq.stream) {
          return new Response(streamAnthropicToOpenAI(res.body as ReadableStream, anthReq.model), {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
          });
        }
        const data: any = await res.json();
        return new Response(JSON.stringify(toOpenAIResponse(data, anthReq.model)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Pass-through to OpenAI upstream
      const res = await fetch(`${upstream}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}`, ...sessionHeaders(request) },
        body: await request.text(),
      });
      return res;
  }

  // Model discovery
  if (route.path === '/v1/models' && request.method === 'GET') {
      const key = extractApiKey(request.headers);
      const err = validateApiKey(key);
      if (err) return authErrorResponse(err);

      const res = fmt === "anthropic"
        ? await fetch(`${upstream}/v1/models`, {
            method: "GET",
            headers: anthropicHeaders(request, key),
          })
        : await fetch(`${upstream}/models`, {
            method: "GET",
            headers: { "Authorization": `Bearer ${key}`, ...sessionHeaders(request) },
      });
      if (!res.ok) return upstreamErrorResponse(res, await res.text());
      return new Response(await res.text(), { headers: { "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({
    name: "opencode-cowork-proxy",
    upstream,
    routes: {
      "/opencode": `${INFERENCE_ORIGIN}/{openai,anthropic,google} (transparent pass-through for the OpenCode app)`,
      "/opencode/v1": "OpenCode `opencode` provider (Console / Zen) baseURL",
      "/opencode/go/v1": "OpenCode `opencode-go` provider baseURL",
      "/go": GO_UPSTREAM,
      "/zen": ZEN_UPSTREAM,
    },
    endpoints: {
      "/v1/messages": "Anthropic → upstream (translated if upstream=openai)",
      "/v1/chat/completions": "OpenAI → upstream (translated if upstream=anthropic)",
      "/v1/models": "Model discovery proxy",
    },
  }, null, 2), {
    headers: { "Content-Type": "application/json" },
    status: route.path === '/' ? 200 : 404,
  });
}

const app = new Hono();
app.all('*', (c) => handleRequest(c.req.raw));

export default app;
