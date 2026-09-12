// MCP over Streamable HTTP.
//
// Every message is a POST. The reply is either a single JSON object or an SSE
// stream carrying one or more -- the server chooses, by content type, and a
// client that only handles one of them works against half the servers it meets.
//
// The SSE half reuses src/provider/SseParser.js. It was written for streamed
// completions and the framing problem is identical: a `data:` line can split
// across chunks, and across a UTF-8 sequence.

import { SseParser } from '../provider/SseParser.js';

export class HttpTransport {
  #url;
  #headers;
  #sessionId = null;
  #onMessage = () => {};
  #onClose = () => {};
  #fetch;
  #closed = false;

  constructor({ url, headers = {}, fetch: fetchImpl = globalThis.fetch }) {
    const parsed = new URL(url);
    // The same rule as a provider endpoint: a token must not cross a network in
    // plaintext, and loopback is exempt because it does not.
    if (parsed.protocol !== 'https:') {
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
      if (!loopback) {
        throw new Error(`refusing to talk to an MCP server over ${parsed.protocol}// at ${parsed.hostname}. Use https, or loopback.`);
      }
    }
    this.#url = url;
    this.#headers = headers;
    this.#fetch = fetchImpl;
  }

  get sessionId() { return this.#sessionId; }

  async start() { return this; }

  onMessage(fn) { this.#onMessage = fn; }
  onClose(fn) { this.#onClose = fn; }

  async send(text) {
    if (this.#closed) throw new Error('the connection is closed');

    const res = await this.#fetch(this.#url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Both, because the server picks which it will answer with.
        accept: 'application/json, text/event-stream',
        ...(this.#sessionId ? { 'mcp-session-id': this.#sessionId } : {}),
        ...this.#headers,
      },
      body: text,
    });

    // The server assigns a session on initialize and expects it echoed back on
    // everything after. Missing it produces a puzzling "not initialised".
    const assigned = res.headers.get('mcp-session-id');
    if (assigned) this.#sessionId = assigned;

    // A notification is answered with 202 and no body, which is correct and
    // must not be treated as an empty reply to a request.
    if (res.status === 202) return;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`MCP server returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }

    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      await this.#readStream(res);
      return;
    }

    const body = await res.text();
    if (body.trim() !== '') this.#onMessage(body);
  }

  async #readStream(res) {
    if (!res.body) return;
    const parser = new SseParser();
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of parser.push(value)) {
          if (ev.data !== '') this.#onMessage(ev.data);
        }
      }
      for (const ev of parser.end()) {
        if (ev.data !== '') this.#onMessage(ev.data);
      }
    } finally {
      reader.releaseLock?.();
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    // Politely ends the session where the server supports it; a server that
    // does not is not a problem worth reporting.
    if (this.#sessionId) {
      try {
        await this.#fetch(this.#url, {
          method: 'DELETE',
          headers: { 'mcp-session-id': this.#sessionId, ...this.#headers },
        });
      } catch { /* the session ends when we stop talking either way */ }
    }
    this.#onClose();
  }
}
