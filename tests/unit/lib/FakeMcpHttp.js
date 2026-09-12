// A minimal MCP server over Streamable HTTP, for tests.
//
// It can answer either with a single JSON object or with an SSE stream, because
// the specification lets a server choose and a client that handles only one
// works against half the servers it meets.

import http from 'node:http';

export class FakeMcpHttp {
  #server;
  #port;
  #mode;
  requests = [];
  sessionId = 'session-abc';

  constructor({ mode = 'json' } = {}) {
    this.#mode = mode; // 'json' | 'sse'
  }

  async start() {
    this.#server = http.createServer((req, res) => this.#handle(req, res));
    await new Promise((r) => this.#server.listen(0, '127.0.0.1', r));
    this.#port = this.#server.address().port;
    return this;
  }

  async stop() {
    if (!this.#server) return;
    await new Promise((r) => this.#server.close(r));
    this.#server = null;
  }

  get url() { return `http://127.0.0.1:${this.#port}/mcp`; }

  async #handle(req, res) {
    if (req.method === 'DELETE') { res.writeHead(200).end(); return; }

    const body = await new Promise((resolve) => {
      let d = '';
      req.on('data', (c) => { d += c; });
      req.on('end', () => resolve(d));
    });

    const message = JSON.parse(body);
    this.requests.push({ headers: req.headers, message });

    // A notification gets 202 and no body.
    if (message.id === undefined) { res.writeHead(202).end(); return; }

    const result = respond(message);
    const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, ...result });
    const headers = { 'mcp-session-id': this.sessionId };

    if (this.#mode === 'sse') {
      res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
      // Written in small pieces: the client must survive chunk boundaries.
      const framed = `event: message\ndata: ${payload}\n\n`;
      for (let i = 0; i < framed.length; i += 7) res.write(framed.slice(i, i + 7));
      res.end();
      return;
    }

    res.writeHead(200, { ...headers, 'content-type': 'application/json' });
    res.end(payload);
  }
}

function respond({ method, params }) {
  switch (method) {
    case 'initialize':
      return {
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-http', version: '2.0.0' },
        },
      };
    case 'tools/list':
      return {
        result: {
          tools: [{
            name: 'remote_lookup',
            description: 'Look something up remotely.',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string', description: 'What to look up.' } },
              required: ['query'],
            },
            annotations: { readOnlyHint: true },
          }],
        },
      };
    case 'tools/call':
      if (params.name === 'remote_lookup') {
        return { result: { content: [{ type: 'text', text: `found ${params.arguments.query}` }] } };
      }
      return { error: { code: -32602, message: `no tool called ${params.name}` } };
    default:
      return { error: { code: -32601, message: `no method ${method}` } };
  }
}
