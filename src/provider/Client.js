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
import { byName as dialectByName } from './dialects/index.js';
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

  // Would the *same* request, sent again unchanged, ever succeed here? A size
  // refusal says no, however long you wait.
  get tooLarge() { return this.kind === 'too-large'; }

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
  // 413 is "this request is too big for me", and it is emphatically not our
  // request being malformed: Groq answers a per-minute overflow with
  //
  //   413  Request too large for model ... on tokens per minute (TPM):
  //        Limit 8000, Requested 13266
  //
  // which is a provider with 8,000 tokens a minute declining something a
  // provider with 625,000 would answer without noticing. Classified as
  // bad-request it stopped the router rotating and surfaced to the user, which
  // is the one outcome that helps nobody.
  //
  // Distinct from rate-limit because it is a size problem rather than a timing
  // one: waiting does not help, asking someone larger does, and there is no
  // reason to put this provider in a cooldown it did not ask for.
  if (status === 413) return 'too-large';
  return 'bad-request';
}

export class ProviderClient {
  #config;
  #limiter;
  #fetch;
  #dialect;

  // `config` is what ProfileRegistry.configure() returns.
  constructor(config, { fetch: fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    assertTransportIsSafe(config.baseUrl);
    this.#config = config;
    this.#fetch = fetchImpl;
    this.#limiter = new RateLimiter(config.profile, { now });
    // The wire format, chosen by the profile. Everything below this line is
    // transport, budget and failure classification -- none of which differ
    // between formats, which is why there is still only one client.
    this.#dialect = dialectByName(config.profile.dialect);
  }

  get name() { return this.#config.name; }
  get model() { return this.#config.model; }

  // Tokens the selected model can hold, where the provider's catalogue says.
  // Most do not, and null means unknown rather than zero.
  get contextWindow() { return this.#config.contextWindow ?? null; }
  get profile() { return this.#config.profile; }
  get limiter() { return this.#limiter; }
  get dialect() { return this.#dialect; }

  #headers() {
    const { profile, key, extraHeaders } = this.#config;
    if (profile.auth !== 'bearer') throw new Error(`unsupported auth scheme ${profile.auth}`);
    return {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json',
      ...this.#dialect.headers({ profile }),
      ...extraHeaders,
    };
  }

  #body(request) {
    const model = request.model ?? this.#config.model;
    if (!model) {
      throw new Error(`${this.name}: no model chosen. Set ${this.profile.modelVar} or pass one.`);
    }

    // A format that will not accept a request without an output ceiling gets
    // one from preferences, never from a number written here. No inline
    // fallback: if neither the caller nor the configuration supplies it, that
    // is a misconfiguration to name rather than to paper over.
    let maxTokens = request.maxTokens;
    if (this.#dialect.requiresMaxTokens && maxTokens === undefined) {
      maxTokens = this.#config.maxOutputTokens;
      if (!maxTokens) {
        throw new Error(
          `${this.name}: the ${this.#dialect.name} format requires an output limit, and none is set. ` +
          'Set PEASANT_MAX_OUTPUT_TOKENS (see example.env).',
        );
      }
    }

    return this.#dialect.buildBody({ ...request, model, maxTokens }, { profile: this.profile });
  }

  async listModels({ signal } = {}) {
    const details = await this.listModelDetails({ signal });
    return details.map((m) => m.id ?? m.name).filter(Boolean);
  }

  // The full catalogue entries, for the fields beyond the id. Kept separate
  // from listModels so the common case stays a list of strings.
  //
  // Not every endpoint publishes a catalogue. Where none exists the profile
  // carries the list instead -- which is a worse source, because it goes stale
  // silently, and is why `models` is empty for every provider that can be
  // asked.
  async listModelDetails({ signal } = {}) {
    if (this.#dialect.modelsPath === null) {
      if (this.profile.models.length === 0) {
        throw new Error(
          `${this.name}: publishes no model catalogue and its profile lists none. ` +
          `Set ${this.profile.modelVar} to the model to use.`,
        );
      }
      return this.profile.models.map((m) => (typeof m === 'string' ? { id: m } : m));
    }

    const res = await this.#fetch(`${this.#config.baseUrl}${this.#dialect.modelsPath}`, {
      headers: this.#headers(),
      signal,
    });
    this.#limiter.observe(res.headers);
    const text = await res.text();
    if (!res.ok) throw this.#error('listing models failed', res, text);
    return this.#dialect.parseModels(JSON.parse(text));
  }

  #error(what, res, body) {
    let message = `${this.name}: ${what} (HTTP ${res.status})`;
    let detail = null;
    try {
      detail = this.#dialect.errorDetail(JSON.parse(body));
      if (detail) message += `: ${detail}`;
    } catch { if (body) message += `: ${String(body).slice(0, 200)}`; }

    return new ProviderError(message, {
      status: res.status,
      provider: this.name,
      headers: res.headers,
      body,
      kind: this.#classify(res.status, detail),
    });
  }

  // Status first, then the one thing a status cannot say.
  //
  // `classify` treats 400 as "our request is wrong and everyone will say so",
  // which is right almost always and was measured to be wrong for at least one
  // provider: Anthropic answers an *unpaid account* with 400 and
  //
  //   Your credit balance is too low to access the Anthropic API.
  //
  // That is the 402 case wearing a 400, and the comment on `classify` names the
  // cost exactly -- "not rotating on one provider's billing problem takes the
  // whole session down". A profile may therefore name the refusals that are
  // really about the account rather than the request. Data in a profile, not a
  // branch here, and empty for everyone who has not measured one.
  #classify(status, detail) {
    const kind = classify(status);
    if (kind !== 'bad-request' || !detail) return kind;
    return this.profile.unavailableWhen.some((re) => re.test(detail))
      ? 'provider-unavailable'
      : kind;
  }

  async #post(body, signal) {
    let res;
    try {
      res = await this.#fetch(`${this.#config.baseUrl}${this.#dialect.completionPath}`, {
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

    const out = this.#dialect.parseComplete(JSON.parse(text), { profile: this.profile });
    const assembler = new ToolCallAssembler();
    assembler.push(out.toolCallDeltas);

    return {
      provider: this.name,
      model: out.model,
      content: out.content,
      reasoning: out.reasoning,
      toolCalls: assembler.finish(),
      usage: out.usage,
      finishReason: out.finishReason,
    };
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

    // Per-stream scratch space for the dialect. The formats that key their
    // deltas by content-block or item index need somewhere to remember the
    // mapping, and it must not outlive one response.
    const state = {};

    const acc = { content: '', reasoning: '', usage: null, finishReason: null, model: null };

    // One place where a parsed event becomes yielded events. It used to be two,
    // and the second -- the flush after the stream ended -- had quietly lost
    // `reasoning`: a provider whose last event carried reasoning would have had
    // it dropped from the result. Two copies of a rule is how that happens.
    const consume = (ev) => this.#handleEvent(ev, assembler, state, acc);

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of parser.push(value)) yield* consume(ev);
      }
      for (const ev of parser.end()) yield* consume(ev);
    } finally {
      reader.releaseLock?.();
    }

    yield {
      type: 'done',
      result: {
        provider: this.name,
        model: acc.model,
        content: acc.content,
        reasoning: acc.reasoning,
        toolCalls: assembler.finish(),
        usage: acc.usage,
        finishReason: acc.finishReason,
      },
    };
  }

  // Yields the events one SSE frame produced, and folds it into `acc`.
  *#handleEvent(ev, assembler, state, acc) {
    if (ev.data === '') return;
    let chunk;
    try {
      chunk = parseData(ev.data);
    } catch {
      // A provider that emits something that is not JSON has told us nothing
      // useful, but taking the turn down over it would be worse.
      return;
    }
    if (chunk === DONE) return;

    let out;
    try {
      out = this.#dialect.parseEvent({ chunk, name: ev.event }, { profile: this.profile }, state);
    } catch (e) {
      // A dialect throws only for an error *event* -- the provider saying the
      // response failed mid-stream. That is a provider failure like any other
      // and must be classified as one, or the router will not rotate off it.
      throw new ProviderError(`${this.name}: ${e.message}`, {
        provider: this.name, kind: 'server-error',
      });
    }
    if (!out) return;

    assembler.push(out.toolCallDeltas);

    if (out.model) acc.model = out.model;
    if (out.usage) { acc.usage = out.usage; yield { type: 'usage', usage: out.usage }; }
    if (out.finishReason) acc.finishReason = out.finishReason;
    if (out.text) { acc.content += out.text; yield { type: 'text', delta: out.text }; }
    if (out.reasoning) { acc.reasoning += out.reasoning; yield { type: 'reasoning', delta: out.reasoning }; }
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
