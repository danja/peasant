import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from '../../src/mcp/Client.js';
import { HttpTransport } from '../../src/mcp/HttpTransport.js';
import { loadServers, configFiles } from '../../src/mcp/config.js';
import { sanitise, mutatesFor, adaptAll } from '../../src/mcp/adapt.js';
import { connectServers, closeServers } from '../../src/mcp/connect.js';
import { FakeMcpHttp } from './lib/FakeMcpHttp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER = path.join(HERE, 'lib', 'fake-mcp-stdio.js');

// --- stdio -----------------------------------------------------------------

async function stdioClient(t) {
  const client = McpClient.fromConfig('demo', {
    command: process.execPath,
    args: [STDIO_SERVER],
  });
  t.after(() => client.close());
  await client.connect();
  return client;
}

test('connects over stdio and completes the handshake', async (t) => {
  const client = await stdioClient(t);
  assert.equal(client.serverInfo.name, 'fake-stdio');
});

test('a server that logs to stderr is not confused with the protocol', async (t) => {
  // Many real servers log there, and a log line parsed as a message is a
  // confusing way to fail.
  const client = await stdioClient(t);
  assert.ok(client.tools.length > 0);
  assert.match(client.transport.stderr, /fake mcp server starting/);
});

test('every page of tools is read, not just the first', async (t) => {
  // A server with many tools does paginate, and a client that stops at the
  // first page silently loses the rest.
  const client = await stdioClient(t);
  assert.deepEqual(client.tools.map((x) => x.name).sort(), ['Write.Thing', 'echo-text']);
});

test('a tool can be called and its text comes back', async (t) => {
  const client = await stdioClient(t);
  const result = await client.callTool('echo-text', { text: 'hello' });
  assert.equal(result.isError, false);
  assert.equal(result.text, 'echo: hello');
});

test("a tool's own failure is a result, not a protocol error", async (t) => {
  // The call succeeded; the tool did not. The model can usually work around one.
  const client = await stdioClient(t);
  const result = await client.callTool('boom', {});
  assert.equal(result.isError, true);
  assert.match(result.text, /the tool failed/);
});

test('a protocol error is thrown', async (t) => {
  const client = await stdioClient(t);
  await assert.rejects(() => client.callTool('nonexistent', {}), /no tool called nonexistent/);
});

test('a command that does not exist fails with its name', async () => {
  const client = McpClient.fromConfig('broken', { command: '/nonexistent/server', args: [] });
  await assert.rejects(() => client.connect({ timeoutMs: 2000 }));
  await client.close();
});

// --- http ------------------------------------------------------------------

for (const mode of ['json', 'sse']) {
  test(`connects over http and answers with ${mode}`, async (t) => {
    // The specification lets a server choose, and a client that handles only
    // one of them works against half the servers it meets.
    const server = await new FakeMcpHttp({ mode }).start();
    const client = McpClient.fromConfig('remote', { url: server.url });
    t.after(async () => { await client.close(); await server.stop(); });

    await client.connect();
    assert.equal(client.serverInfo.name, 'fake-http');
    assert.deepEqual(client.tools.map((x) => x.name), ['remote_lookup']);

    const result = await client.callTool('remote_lookup', { query: 'a thing' });
    assert.equal(result.text, 'found a thing');
  });
}

test('the session id is echoed back on every request after initialize', async (t) => {
  // Missing it produces a puzzling "not initialised" from a server that had
  // just finished initialising.
  const server = await new FakeMcpHttp().start();
  const client = McpClient.fromConfig('remote', { url: server.url });
  t.after(async () => { await client.close(); await server.stop(); });

  await client.connect();
  const after = server.requests.slice(1);
  assert.ok(after.length > 0);
  for (const r of after) {
    assert.equal(r.headers['mcp-session-id'], server.sessionId, `${r.message.method} did not echo the session`);
  }
});

test('the initialized notification is sent, or the server refuses everything', async (t) => {
  const server = await new FakeMcpHttp().start();
  const client = McpClient.fromConfig('remote', { url: server.url });
  t.after(async () => { await client.close(); await server.stop(); });
  await client.connect();
  assert.ok(server.requests.some((r) => r.message.method === 'notifications/initialized'));
});

test('custom headers are sent, for a server behind a token', async (t) => {
  const server = await new FakeMcpHttp().start();
  const client = McpClient.fromConfig('remote', { url: server.url, headers: { authorization: 'Bearer t' } });
  t.after(async () => { await client.close(); await server.stop(); });
  await client.connect();
  assert.equal(server.requests[0].headers.authorization, 'Bearer t');
});

test('plaintext to a remote host is refused, loopback allowed', () => {
  // A token must not cross a network in plaintext. Loopback does not.
  assert.throws(() => new HttpTransport({ url: 'http://example.com/mcp' }), /refusing to talk to an MCP server over http/);
  assert.doesNotThrow(() => new HttpTransport({ url: 'http://127.0.0.1:9000/mcp' }));
  assert.doesNotThrow(() => new HttpTransport({ url: 'https://example.com/mcp' }));
});

// --- configuration ---------------------------------------------------------

test('a server needs exactly one of command or url', () => {
  assert.throws(() => McpClient.fromConfig('x', {}), /needs either command \(stdio\) or url \(http\)/);
  assert.throws(() => McpClient.fromConfig('x', { command: 'a', url: 'https://b' }), /only be one/);
});

test('config is layered like .env, project over user', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-mcp-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-mcp-cwd-'));
  try {
    fs.mkdirSync(path.join(home, '.config', 'peasant'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'peasant', 'mcp.json'), JSON.stringify({
      mcpServers: { shared: { command: 'a' }, replaced: { command: 'old' } },
    }));
    fs.mkdirSync(path.join(cwd, '.peasant'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.peasant', 'mcp.json'), JSON.stringify({
      mcpServers: { replaced: { command: 'new' }, local: { url: 'https://x/mcp' } },
    }));

    const { servers } = loadServers({ env: {}, cwd, home });
    assert.deepEqual([...servers.keys()].sort(), ['local', 'replaced', 'shared']);
    assert.equal(servers.get('replaced').command, 'new', 'a repository may replace a global server');
    assert.equal(servers.get('shared').command, 'a');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a disabled server is removed rather than started', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-mcp-'));
  try {
    const file = path.join(dir, 'mcp.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { off: { command: 'a', disabled: true } } }));
    const { servers } = loadServers({ files: [file] });
    assert.equal(servers.size, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a malformed config is named, not silently skipped', () => {
  // Otherwise a server simply never appears and nothing says why.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-mcp-'));
  try {
    const file = path.join(dir, 'mcp.json');
    fs.writeFileSync(file, '{ not json');
    const { servers, problems } = loadServers({ files: [file] });
    assert.equal(servers.size, 0);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not valid JSON/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('config files are looked for in the conventional places', () => {
  const files = configFiles({ env: {}, cwd: '/work', home: '/home/x' });
  assert.deepEqual(files, ['/home/x/.config/peasant/mcp.json', '/work/.peasant/mcp.json']);
});

// --- adaptation ------------------------------------------------------------

test('names are made safe without losing which server they came from', () => {
  assert.equal(sanitise('demo', 'echo-text'), 'mcp_demo_echo_text');
  assert.equal(sanitise('My Server', 'Write.Thing'), 'mcp_my_server_write_thing');
  assert.match(sanitise('9server', 'x'), /^[a-z][a-z0-9_]*$/);
});

test('anything not declared read-only is treated as mutating', () => {
  // MCP makes readOnlyHint optional. The cost of being wrong this way is an
  // extra prompt; the other way it is a server deleting something unasked.
  assert.equal(mutatesFor({ annotations: { readOnlyHint: true } }), false);
  assert.equal(mutatesFor({ annotations: { readOnlyHint: false } }), true);
  assert.equal(mutatesFor({ annotations: {} }), true);
  assert.equal(mutatesFor({}), true);
  assert.equal(mutatesFor(null), true);
});

test('an adapted tool behaves exactly like a built-in one', async (t) => {
  const client = await stdioClient(t);
  const [tool] = adaptAll([client]).filter((x) => x.name.endsWith('echo_text'));

  assert.equal(tool.mutates, false, 'declared read-only by the server');
  assert.match(tool.description, /^\[demo\]/, 'the server is named, so the model knows where it goes');
  assert.equal(tool.spec.function.parameters, tool.parameters, 'same object, like every other tool');

  const out = await tool.invoke({ text: 'hi' }, {});
  assert.equal(out, 'echo: hi');
});

test('an adapted tool validates its arguments against the server schema', async (t) => {
  const client = await stdioClient(t);
  const [tool] = adaptAll([client]).filter((x) => x.name.endsWith('echo_text'));
  await assert.rejects(() => tool.invoke({}, {}), /text is required/);
});

test('a mutating server tool is marked as such', async (t) => {
  const client = await stdioClient(t);
  const [tool] = adaptAll([client]).filter((x) => x.name.endsWith('write_thing'));
  assert.equal(tool.mutates, true, 'it says nothing about being read-only');
});

test('colliding names are kept apart rather than overwriting', async (t) => {
  // A silent overwrite means calls going to the wrong server, which is very
  // hard to notice and very annoying to diagnose.
  const a = await stdioClient(t);
  const b = await stdioClient(t);
  // Both clients are named 'demo', so every name collides.
  const tools = adaptAll([a, b]);
  assert.equal(tools.length, 4);
  assert.equal(new Set(tools.map((x) => x.name)).size, 4);
});

// --- connecting ------------------------------------------------------------

test('a broken server does not stop the working ones', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({
    mcpServers: {
      good: { command: process.execPath, args: [STDIO_SERVER] },
      bad: { command: '/nonexistent/thing' },
      alsobad: {},
    },
  }));

  const { clients, failed, tools } = await connectServers({
    env: { PEASANT_HOME: dir }, cwd: dir,
  });
  t.after(() => closeServers(clients));

  assert.equal(clients.length, 1);
  assert.equal(clients[0].name, 'good');
  assert.equal(tools.length, 2);
  assert.deepEqual(failed.map((f) => f.name).sort(), ['alsobad', 'bad']);
});

test('no configuration at all is not an error', async () => {
  const { clients, failed, tools } = await connectServers({
    env: { PEASANT_HOME: '/nonexistent' }, cwd: '/nonexistent',
  });
  assert.deepEqual(clients, []);
  assert.deepEqual(tools, []);
  assert.deepEqual(failed, []);
});
