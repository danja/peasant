// A local OpenAI-compatible server, on node:http.
//
// This is the deliberate exception to testing against live services, and it
// follows from the specification: the tightest tier we hold is 8,000 tokens a
// minute, which a test suite would exhaust in seconds. Everything that is not
// the provider is tested for real.
//
// It replays the captured SSE bytes wherever it can, so the client is tested
// against what Groq and Mistral actually sent rather than what I imagined.

import http from 'node:http';

const COMPLETION_PATHS = ['/chat/completions', '/messages', '/responses'];

export class FakeProvider {
  // Responses deliberately left unanswered, so stop() can free them.
  #hung = [];

  #server;
  #port;

  // Every request it received, for assertions.
  requests = [];

  // Queued responses, consumed in order. When empty, `defaults` applies.
  #queue = [];

  constructor({ models = ['test-model'] } = {}) {
    this.models = models;
  }

  // Queue one response for the next /chat/completions request.
  //   { status, headers, json }              -- a non-streaming body
  //   { status, headers, sse }               -- raw SSE bytes or string
  //   { status, headers, chunks }            -- objects, framed as SSE for you
  //   { hang: true }                         -- accept the request and never answer
  respond(spec) { this.#queue.push(spec); return this; }

  async start() {
    this.#server = http.createServer((req, res) => this.#handle(req, res));
    await new Promise((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    this.#port = this.#server.address().port;
    return this;
  }

  async stop() {
    if (!this.#server) return;
    for (const res of this.#hung) res.destroy();
    this.#hung.length = 0;
    await new Promise((resolve) => this.#server.close(resolve));
    this.#server = null;
  }

  get baseUrl() { return `http://127.0.0.1:${this.#port}/v1`; }

  get lastRequest() { return this.requests.at(-1); }

  async #handle(req, res) {
    const body = await readBody(req);
    const record = {
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: body ? safeJson(body) : null,
      raw: body,
    };
    this.requests.push(record);

    if (req.url.endsWith('/models')) {
      return json(res, 200, {}, { object: 'list', data: this.models.map((id) => ({ id, object: 'model' })) });
    }

    // The three completion paths the three dialects post to. Anything else is
    // a 404, so a dialect posting to the wrong path fails loudly here rather
    // than being quietly answered.
    if (!COMPLETION_PATHS.some((suffix) => req.url.endsWith(suffix))) {
      return json(res, 404, {}, { error: { message: 'not found' } });
    }

    const spec = this.#queue.shift() ?? { json: defaultCompletion() };
    const status = spec.status ?? 200;
    const headers = spec.headers ?? {};

    // A provider that accepts the request and then says nothing. Two models in
    // NVIDIA's catalogue behave exactly like this, and it is the case a caller
    // with no timeout waits out forever. The socket is held open and tracked so
    // stop() can close it; leaving it dangling would hang the test runner
    // instead of the test, which is a worse version of the same bug.
    if (spec.hang) {
      this.#hung.push(res);
      return;
    }

    if (spec.sse !== undefined || spec.chunks !== undefined) {
      const payload = spec.sse !== undefined ? spec.sse : frameChunks(spec.chunks);
      res.writeHead(status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers });
      // Written in small pieces on purpose: the client must survive arbitrary
      // chunk boundaries, and a single write would never exercise that.
      const buf = Buffer.from(payload);
      const step = spec.chunkSize ?? 17;
      for (let i = 0; i < buf.length; i += step) res.write(buf.subarray(i, i + step));
      return res.end();
    }

    return json(res, status, headers, spec.json ?? { error: { message: 'no body queued' } });
  }
}

function json(res, status, headers, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// SSE with a named `event:` line per frame, which is how both the Anthropic
// Messages and the OpenAI Responses streams are framed. The chat-completions
// stream is the odd one out in having no event names and a [DONE] terminator,
// which is why frameChunks and this are two functions rather than one with a
// flag.
export function frameEvents(events) {
  return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

export function frameChunks(chunks) {
  return [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join('');
}

export function textChunks(text, { usage = null, finishReason = 'stop' } = {}) {
  const out = [...text].map((ch) => ({ choices: [{ index: 0, delta: { content: ch }, finish_reason: null }] }));
  out.push({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
  if (usage) out.push({ choices: [], usage });
  return out;
}

export function defaultCompletion(content = 'ok') {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}
