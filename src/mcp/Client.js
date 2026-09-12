// An MCP client: handshake, list what a server offers, call it.
//
// Deliberately small. peasant wants tools; resources and prompts are not
// implemented rather than half-implemented, so nothing pretends to support
// them.

import { JsonRpc, JsonRpcError } from './JsonRpc.js';
import { StdioTransport } from './StdioTransport.js';
import { HttpTransport } from './HttpTransport.js';

const PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
  #name;
  #transport;
  #rpc = null;
  #serverInfo = null;
  #tools = [];

  constructor({ name, transport }) {
    this.#name = name;
    this.#transport = transport;
  }

  // One entry from mcp.json becomes one client. `command` means stdio, `url`
  // means HTTP; declaring both is a configuration error rather than a
  // preference to guess at.
  static fromConfig(name, config, { cwd = process.cwd(), fetch: fetchImpl } = {}) {
    const hasCommand = Boolean(config.command);
    const hasUrl = Boolean(config.url);

    if (hasCommand && hasUrl) {
      throw new Error(`mcp server ${name}: declares both command and url; it can only be one`);
    }
    if (!hasCommand && !hasUrl) {
      throw new Error(`mcp server ${name}: needs either command (stdio) or url (http)`);
    }

    const transport = hasCommand
      ? new StdioTransport({ command: config.command, args: config.args ?? [], env: config.env ?? {}, cwd })
      : new HttpTransport({ url: config.url, headers: config.headers ?? {}, fetch: fetchImpl });

    return new McpClient({ name, transport });
  }

  get name() { return this.#name; }
  get serverInfo() { return this.#serverInfo; }
  get tools() { return this.#tools; }
  get transport() { return this.#transport; }

  async connect({ signal, timeoutMs = 20_000 } = {}) {
    await this.#transport.start();
    this.#rpc = new JsonRpc({ transport: this.#transport, timeoutMs });

    const result = await this.#rpc.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'peasant', version: '0.0.0' },
    }, { signal, timeoutMs });

    this.#serverInfo = result?.serverInfo ?? null;

    // Required by the specification, and servers do enforce it: without the
    // notification the server considers the handshake unfinished and refuses
    // everything after.
    await this.#rpc.notify('notifications/initialized', {});

    this.#tools = await this.#listTools({ signal, timeoutMs });
    return this;
  }

  async #listTools({ signal, timeoutMs }) {
    const collected = [];
    let cursor;

    // Paginated, and a server with many tools does paginate. A client that
    // reads the first page only silently loses the rest.
    do {
      const page = await this.#rpc.request('tools/list', cursor ? { cursor } : {}, { signal, timeoutMs });
      for (const tool of page?.tools ?? []) collected.push(tool);
      cursor = page?.nextCursor;
    } while (cursor && collected.length < 500);

    return collected;
  }

  async callTool(name, args, { signal, timeoutMs = 120_000 } = {}) {
    const result = await this.#rpc.request('tools/call', {
      name,
      arguments: args ?? {},
    }, { signal, timeoutMs });

    // MCP reports a tool's own failure in the result rather than as a protocol
    // error, which is right: the call succeeded, the tool did not.
    return {
      isError: Boolean(result?.isError),
      text: renderContent(result?.content ?? []),
      structured: result?.structuredContent ?? null,
    };
  }

  async close() {
    await this.#rpc?.close();
  }
}

// MCP content is a list of typed blocks. Only text is rendered: an image or an
// embedded resource has no useful representation in a terminal transcript, and
// saying so is better than silently dropping it.
function renderContent(blocks) {
  const parts = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'resource' && block.resource?.text) parts.push(block.resource.text);
    else if (block?.type) parts.push(`[${block.type} content, not shown]`);
  }
  return parts.join('\n');
}

export { JsonRpcError };
