import { describe, it, expect, vi, afterEach } from 'vitest';
import { upstreamFor } from '../src/index';
import worker from '../src/index';

const key = 'a'.repeat(32);

describe('worker routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes /v1/models to Anthropic models endpoint with Anthropic headers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const request = new Request('https://proxy.example/v1/models', {
      headers: {
        'x-api-key': key,
        'x-upstream-url': 'https://api.anthropic.com',
        'x-upstream-format': 'anthropic',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'tools-2024-04-04',
      },
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': key,
        'Anthropic-Version': '2023-06-01',
        'Anthropic-Beta': 'tools-2024-04-04',
        'User-Agent': 'opencode-cowork-proxy/2.0',
      },
    });
  });

  it('forwards Anthropic beta header when translating OpenAI requests to Anthropic', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = new Request('https://proxy.example/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${key}`,
        'x-upstream-url': 'https://api.anthropic.com',
        'x-upstream-format': 'anthropic',
        'anthropic-beta': 'tools-2024-04-04',
      },
      body: JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] }),
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.objectContaining({
      headers: expect.objectContaining({
        'X-Api-Key': key,
        'Anthropic-Version': '2023-06-01',
        'Anthropic-Beta': 'tools-2024-04-04',
      }),
    }));
  });

  it('routes /go-prefixed Anthropic requests to OpenCode Go', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = new Request('https://proxy.example/go/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] }),
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith('https://opencode.ai/zen/go/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: `Bearer ${key}` }),
    }));
  });

  it('routes /zen-prefixed Anthropic requests to OpenCode Zen', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = new Request('https://proxy.example/zen/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ model: 'qwen3.5-plus', messages: [{ role: 'user', content: 'hi' }] }),
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith('https://opencode.ai/zen/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: `Bearer ${key}` }),
    }));
  });

  it('preserves upstream rate limit headers on translated errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"FreeUsageLimitError"}', {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
          'RateLimit-Reset': '1710000000',
        },
      }),
    );

    const request = new Request('https://proxy.example/zen/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ model: 'minimax-m2.5-free', messages: [{ role: 'user', content: 'hi' }] }),
    });

    const response = await worker.fetch(request);

    expect(response.status).toBe(429);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('RateLimit-Reset')).toBe('1710000000');
    expect(await response.text()).toBe('{"error":"FreeUsageLimitError"}');
  });

  it('routes /go-prefixed model discovery to OpenCode Go models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const request = new Request('https://proxy.example/go/v1/models', {
      headers: { 'x-api-key': key },
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith('https://opencode.ai/zen/go/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'opencode-cowork-proxy/2.0' },
    });
  });

  it('routes /zen-prefixed model discovery to OpenCode Zen models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const request = new Request('https://proxy.example/zen/v1/models', {
      headers: { 'x-api-key': key },
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith('https://opencode.ai/zen/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'opencode-cowork-proxy/2.0' },
    });
  });

  it('overrides model from URL path segment with /go prefix', async () => {
    let capturedBody: any = null;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    const request = new Request('https://proxy.example/go/minimax-m2.5-free/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const response = await worker.fetch(request);
    expect(capturedBody.model).toBe('minimax-m2.5-free');
    expect(fetchMock).toHaveBeenCalledWith('https://opencode.ai/zen/go/v1/chat/completions', expect.anything());
  });

  it('overrides model from URL path segment with /zen prefix', async () => {
    let capturedBody: any = null;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    const request = new Request('https://proxy.example/zen/minimax-m2.5-free/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    await worker.fetch(request);
    expect(capturedBody.model).toBe('minimax-m2.5-free');
    expect(fetchMock).toHaveBeenCalledWith('https://opencode.ai/zen/v1/chat/completions', expect.anything());
  });

  it('returns original model name in response body when model override is active', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = new Request('https://proxy.example/go/minimax-m2.5-free/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const response = await worker.fetch(request);
    const body = await response.json();
    expect(body.model).toBe('claude-sonnet-4-5-20250514');
  });

  it('does not override model when no model segment in path', async () => {
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    const request = new Request('https://proxy.example/go/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    await worker.fetch(request);
    expect(capturedBody.model).toBe('deepseek-v4-pro');
  });

  it('overrides model to qwen3.6-plus when image attachments are present on the go path', async () => {
    let capturedBody: any = null;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    const request = new Request('https://proxy.example/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
          ],
        }],
        max_tokens: 1024,
      }),
    });

    await worker.fetch(request);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedBody.model).toBe('qwen3.6-plus');
    expect(Array.isArray(capturedBody.messages[0].content)).toBe(true);
    expect(capturedBody.messages[0].content).toEqual([
      { type: 'text', text: 'What is in this image?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
    ]);
  });

  it('overrides model to qwen3.6-plus when image attachments are present on the zen path', async () => {
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    const request = new Request('https://proxy.example/zen/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'mimo-v2.5-free',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
          ],
        }],
        max_tokens: 1024,
      }),
    });

    await worker.fetch(request);
    expect(capturedBody.model).toBe('qwen3.6-plus');
  });
  it('forwards a session id to OpenCode as x-opencode-session', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: {} }), { status: 200 })
    );
    const key = 'a'.repeat(32);
    const request = new Request('https://proxy.example/go/v1/messages', {
      method: 'POST',
      headers: { 'X-Api-Key': key, 'X-Claude-Code-Session-Id': 'sess-123', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await worker.fetch(request);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Opencode-Session']).toBe('sess-123');
    expect(headers['User-Agent']).toBe('opencode-cowork-proxy/2.0');
    fetchMock.mockRestore();
  });
  it('passes /opencode/* through to Zen unchanged, keeping client headers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: x\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    const request = new Request('https://proxy.example/opencode/v1/responses?x=1', {
      method: 'POST',
      headers: { Authorization: 'Bearer k', 'User-Agent': 'opencode/1.18.25', 'x-opencode-session': 's1', 'cf-connecting-ip': '1.2.3.4', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'big-pickle', input: 'hi' }),
    });
    const res = await worker.fetch(request);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://opencode.ai/inference/openai/v1/responses?x=1');
    const h = init.headers as Headers;
    expect(h.get('user-agent')).toBe('opencode/1.18.25');
    expect(h.get('x-opencode-session')).toBe('s1');
    expect(h.get('authorization')).toBe('Bearer k');
    expect(h.get('cf-connecting-ip')).toBeNull();
    expect(h.get('x-forwarded-for')).toBe('1.2.3.4');
    expect(h.get('x-real-ip')).toBe('1.2.3.4');
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    fetchMock.mockRestore();
  });
  it('routes OpenCode requests to the right inference family', () => {
    expect(upstreamFor('/v1/chat/completions')).toBe('https://opencode.ai/inference/openai/v1/chat/completions');
    expect(upstreamFor('/v1/responses')).toBe('https://opencode.ai/inference/openai/v1/responses');
    expect(upstreamFor('/v1/models')).toBe('https://opencode.ai/inference/openai/v1/models');
    expect(upstreamFor('/v1/messages')).toBe('https://opencode.ai/inference/anthropic/v1/messages');
    expect(upstreamFor('/v1/messages/count_tokens')).toBe('https://opencode.ai/inference/anthropic/v1/messages/count_tokens');
    expect(upstreamFor('/v1/models/gemini-4-argon:streamGenerateContent')).toBe('https://opencode.ai/inference/google/v1beta/models/gemini-4-argon:streamGenerateContent');
    expect(upstreamFor('/go/v1/chat/completions')).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
    expect(upstreamFor('/go/v1/messages')).toBe('https://opencode.ai/inference/go/anthropic/v1/messages');
    expect(upstreamFor('/go/v1/models/gemini-4-argon:streamGenerateContent')).toBe('https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:streamGenerateContent');
    expect(upstreamFor('/go/v1beta/models/gemini-4-argon:generateContent')).toBe('https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:generateContent');
    expect(upstreamFor('/something')).toBe('https://opencode.ai/zen/something');
  });
});
