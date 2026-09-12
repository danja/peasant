// One HTTP client for every OpenAI-compatible endpoint.
//
// It knows the OpenAI request and response shape and nothing about any
// particular provider: where they differ, a profile supplies the difference.
// If this file ever needs to know a provider's name, the profile is missing a
// field.
//
// Streaming is the default path. The non-streaming path exists, gets less use
// and therefore fewer tests, so it must not be where the harness normally lives.

import { SseParser, parseData, DONE } from './SseParser.js';
import { ToolCallAssembler } from './ToolCallAssembler.js';
import { RateLimiter } from './RateLimiter.js';

export class ProviderError extends Error {
  constructor(message, { status = null, provider = null, headers = null, body = null, kind = 'unknown' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
    this.headers = headers;
    this.body = body;
    this.kind = kind;
  }

  // Would a different provider answer differently?
  get retryable() { return this.kind !== 'bad-request'; }

  // Is this provider worth asking again this session? A billing or credential
  // problem is not going to resolve itself in the next few seconds.
  get permanent() { return this.kind === 'provider-unavailable'; }
}

// Classifying a failure is the whole of the failover policy, and getting it
// wrong is expensive in both directions: rotating on a malformed request burns
// every provider's quota repeating our own mistake, while *not* rotating on one
// provider's billing problem takes the whole session down.
//
// The distinction that matters, and which a live run exposed: 400 means our
// request is wrong and everyone will say so. 401, 402 and 403 mean *this*
// provider will not serve *us* -- Cerebras returned 402 with an empty body --
// and another provider is very likely to.
export function classify(status) {
  if (status === 429) return 'rate-limit';
  if (status === 401 || status === 402 || status === 403) return 'provider-unavailable';
  if (status === 408 || (status >= 500 && status <= 599)) return 'server-error';
  return 'bad-request';
}

export class OpenAICompatClient {
  #config;
  #limiter;
  #fetch;

  // `config` is what ProfileRegistry.configure() returns.
  constructor(config, { fetch: fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    assertTransportIsSafe(config.baseUrl);
    this.#config = config;
    this.#fetch = fetchImpl;
    this.#limiter = new RateLimiter(config.profile, { now });
  }

  get name() { return this.#config.name; }
  get model() { return this.#config.model; }
  get profile() { return this.#config.profile; }
  get limiter() { return this.#limiter; }

  #headers() {
    const { profile, key, extraHeaders } = this.#config;
    if (profile.auth !== 'bearer') throw new Error(`unsupported auth scheme ${profile.auth}`);
    return {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json',
      ...extraHeaders,
    };
  }

  #body({ messages, model, tools, toolChoice, maxTokens, temperature, stream }) {
    const body = {
      model: model ?? this.#config.model,
      messages,
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      ...(temperature === undefined ? {} : { temperature }),
    };
    if (!body.model) {
      throw new Error(`${this.name}: no model chosen. Set ${this.profile.modelVar} or pass one.`);
    }
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = toolChoice ?? 'auto';
    }
    if (stream) {
      body.stream = true;
      // Without this a streamed response reports no token count and the
      // budgeter is blind. Both measured providers honour it.
      if (this.profile.includeUsage) body.stream_options = { include_usage: true };
    }
    return body;
  }

  async listModels({ signal } = {}) {
    const res = await this.#fetch(`${this.#config.baseUrl}/models`, {
      headers: this.#headers(),
      signal,
    });
    this.#limiter.observe(res.headers);
    const text = await res.text();
    if (!res.ok) throw this.#error('listing models failed', res, text);
    const parsed = JSON.parse(text);
    return (parsed.data ?? parsed.models ?? []).map((m) => m.id ?? m.name).filter(Boolean);
  }

  #error(what, res, body) {
    let message = `${this.name}: ${what} (HTTP ${res.status})`;
    try {
      const parsed = JSON.parse(body);
      const detail = parsed?.error?.message ?? parsed?.message;
      if (detail) message += `: ${detail}`;
    } catch { if (body) message += `: ${String(body).slice(0, 200)}`; }

    return new ProviderError(message, {
      status: res.status,
      provider: this.name,
      headers: res.headers,
      body,
      kind: classify(res.status),
    });
  }

  async #post(body, signal) {
    let res;
    try {
      res = await this.#fetch(`${this.#config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      // A DNS failure or dropped connection is worth another provider's
      // attention, exactly like a 503.
      throw new ProviderError(`${this.name}: request failed: ${e.message}`, {
        provider: this.name, kind: 'network',
      });
    }

    if (res.status === 429) {
      const waited = this.#limiter.note429(res.headers);
      const text = await res.text().catch(() => '');
      throw new ProviderError(`${this.name}: rate limited, retry in ${Math.ceil(waited / 1000)}s`, {
        status: 429, provider: this.name, headers: res.headers, body: text, kind: 'rate-limit',
      });
    }

    this.#limiter.observe(res.headers);
    return res;
  }

  // Non-streaming. Same result shape as stream(), so callers need not care.
  async complete(request) {
    const res = await this.#post(this.#body({ ...request, stream: false }), request.signal);
    const text = await res.text();
    if (!res.ok) throw this.#error('completion failed', res, text);

    const parsed = JSON.parse(text);
    const choice = parsed.choices?.[0] ?? {};
    const assembler = new ToolCallAssembler();
    assembler.push(choice.message?.tool_calls);

    return {
      provider: this.name,
      model: parsed.model ?? null,
      content: choice.message?.content ?? '',
      reasoning: this.#readReasoning(choice.message) ?? '',
      toolCalls: assembler.finish(),
      usage: parsed.usage ?? null,
      finishReason: choice.finish_reason ?? null,
    };
  }

  #readReasoning(obj) {
    if (!obj) return null;
    for (const field of this.profile.reasoningFields) {
      if (typeof obj[field] === 'string' && obj[field] !== '') return obj[field];
    }
    return null;
  }

  // Streaming. Yields:
  //   { type: 'text',      delta }
  //   { type: 'reasoning', delta }   -- never render this as assistant output
  //   { type: 'usage',     usage }
  //   { type: 'done',      result }  -- always last, same shape as complete()
  async *stream(request) {
    const res = await this.#post(this.#body({ ...request, stream: true }), request.signal);
    if (!res.ok) throw this.#error('stream failed', res, await res.text());
    if (!res.body) throw new ProviderError(`${this.name}: streaming response had no body`, {
      status: res.status, provider: this.name, kind: 'server-error',
    });

    const parser = new SseParser();
    const assembler = new ToolCallAssembler();
    const reader = res.body.getReader();

    let content = '';
    let reasoning = '';
    let usage = null;
    let finishReason = null;
    let model = null;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of parser.push(value)) {
          const out = this.#handleEvent(ev, assembler);
          if (!out) continue;
          if (out.model) model = out.model;
          if (out.usage) { usage = out.usage; yield { type: 'usage', usage }; }
          if (out.finishReason) finishReason = out.finishReason;
          if (out.text) { content += out.text; yield { type: 'text', delta: out.text }; }
          if (out.reasoning) { reasoning += out.reasoning; yield { type: 'reasoning', delta: out.reasoning }; }
        }
      }
      for (const ev of parser.end()) {
        const out = this.#handleEvent(ev, assembler);
        if (out?.usage) { usage = out.usage; yield { type: 'usage', usage }; }
        if (out?.finishReason) finishReason = out.finishReason;
        if (out?.text) { content += out.text; yield { type: 'text', delta: out.text }; }
      }
    } finally {
      reader.releaseLock?.();
    }

    yield {
      type: 'done',
      result: {
        provider: this.name,
        model,
        content,
        reasoning,
        toolCalls: assembler.finish(),
        usage,
        finishReason,
      },
    };
  }

  #handleEvent(ev, assembler) {
    if (ev.data === '') return null;
    let chunk;
    try {
      chunk = parseData(ev.data);
    } catch {
      // A provider that emits something that is not JSON has told us nothing
      // useful, but taking the turn down over it would be worse.
      return null;
    }
    if (chunk === DONE) return null;

    const choice = chunk.choices?.[0];
    const delta = choice?.delta ?? {};
    assembler.push(delta.tool_calls);

    return {
      model: chunk.model ?? null,
      usage: chunk.usage ?? null,
      finishReason: choice?.finish_reason ?? null,
      text: typeof delta.content === 'string' ? delta.content : '',
      reasoning: this.#readReasoning(delta) ?? '',
    };
  }
}

// A key must not cross a network in plaintext. Loopback is exempt because a
// local Ollama or llama.cpp has no TLS and needs none.
function assertTransportIsSafe(baseUrl) {
  const u = new URL(baseUrl);
  if (u.protocol === 'https:') return;
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'];
  if (u.protocol === 'http:' && loopback.includes(u.hostname)) return;
  throw new Error(
    `refusing to send an API key over ${u.protocol}// to ${u.hostname}. ` +
    'Use https, or loopback for a local model.',
  );
}
