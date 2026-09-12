#!/usr/bin/env node
// A minimal MCP server over stdio, for tests.
//
// Also logs to stderr on purpose: many real servers do, and a client that mixes
// stderr into the protocol stream fails confusingly.

let buffer = '';
process.stderr.write('fake mcp server starting\n');

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i = buffer.indexOf('\n');
  while (i !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) handle(JSON.parse(line));
    i = buffer.indexOf('\n');
  }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

let initialised = false;

function handle(message) {
  const { id, method, params } = message;

  if (method === 'notifications/initialized') { initialised = true; return; }
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-stdio', version: '1.0.0' },
    });
  }

  if (!initialised) return fail(id, -32002, 'not initialised');

  if (method === 'tools/list') {
    // Paginated on purpose: a client that reads only the first page silently
    // loses the rest.
    if (!params?.cursor) {
      return reply(id, {
        tools: [{
          name: 'echo-text',
          description: 'Echo the text back.',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'What to echo.' } },
            required: ['text'],
          },
          annotations: { readOnlyHint: true },
        }],
        nextCursor: 'page2',
      });
    }
    return reply(id, {
      tools: [{
        name: 'Write.Thing',
        description: 'Something that changes state.',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      }],
    });
  }

  if (method === 'tools/call') {
    if (params.name === 'echo-text') {
      return reply(id, { content: [{ type: 'text', text: `echo: ${params.arguments.text}` }] });
    }
    if (params.name === 'Write.Thing') {
      return reply(id, { content: [{ type: 'text', text: 'wrote it' }] });
    }
    if (params.name === 'boom') {
      return reply(id, { isError: true, content: [{ type: 'text', text: 'the tool failed' }] });
    }
    return fail(id, -32602, `no tool called ${params.name}`);
  }

  return fail(id, -32601, `no method ${method}`);
}
