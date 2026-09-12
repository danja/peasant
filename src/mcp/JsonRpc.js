// JSON-RPC 2.0, the part MCP needs.
//
// Written rather than depended on: it is a hundred lines, and a dependency that
// speaks to arbitrary external servers is the last one worth taking on trust.
//
// Transport-agnostic. A transport supplies `send(text)` and calls `receive(text)`
// for each complete message; this correlates ids, resolves promises, and times
// out requests that are never answered -- which matters more than usual here,
// because an MCP server is somebody else's process and may simply stop.

export class JsonRpcError extends Error {
  constructor(message, { code = null, data = null } = {}) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

export class JsonRpc {
  #transport;
  #pending = new Map();
  #nextId = 1;
  #timeoutMs;
  #closed = false;
  #onNotification;

  constructor({ transport, timeoutMs = 30_000, onNotification = () => {} }) {
    this.#transport = transport;
    this.#timeoutMs = timeoutMs;
    this.#onNotification = onNotification;
    transport.onMessage((text) => this.#receive(text));
    transport.onClose?.(() => this.#failAll(new JsonRpcError('the server closed the connection')));
  }

  async request(method, params, { timeoutMs = this.#timeoutMs, signal } = {}) {
    if (this.#closed) throw new JsonRpcError('the connection is closed');
    const id = this.#nextId++;

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new JsonRpcError(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(signal.reason ?? new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(v); },
        reject: (e) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(e); },
      });
    });

    await this.#transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return promise;
  }

  // A notification has no id and no reply, by definition.
  async notify(method, params) {
    if (this.#closed) return;
    await this.#transport.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  #receive(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      // A server that emits something that is not JSON has told us nothing
      // useful, and taking the session down over it would be worse.
      return;
    }

    // A batch is legal JSON-RPC and some servers use one.
    for (const m of Array.isArray(message) ? message : [message]) this.#dispatch(m);
  }

  #dispatch(m) {
    if (m === null || typeof m !== 'object') return;

    if (m.id === undefined || m.id === null) {
      if (m.method) this.#onNotification(m);
      return;
    }

    const waiting = this.#pending.get(m.id);
    if (!waiting) return; // a reply to something we gave up on
    this.#pending.delete(m.id);

    if (m.error) {
      waiting.reject(new JsonRpcError(m.error.message ?? 'request failed', {
        code: m.error.code ?? null,
        data: m.error.data ?? null,
      }));
      return;
    }
    waiting.resolve(m.result);
  }

  #failAll(error) {
    for (const waiting of this.#pending.values()) waiting.reject(error);
    this.#pending.clear();
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new JsonRpcError('the connection was closed'));
    await this.#transport.close?.();
  }
}
