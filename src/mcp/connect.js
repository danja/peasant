// Connecting every configured MCP server, and surviving the ones that fail.
//
// A server that will not start must not stop peasant starting: they are other
// people's processes and other people's hosts, and one being broken is a normal
// Tuesday.

import { McpClient } from './Client.js';
import { loadServers } from './config.js';
import { adaptAll } from './adapt.js';

export async function connectServers({ env = process.env, cwd = process.cwd(), signal, onProgress = () => {} } = {}) {
  const { servers, problems } = loadServers({ env, cwd });
  const clients = [];
  const failed = [...problems.map((p) => ({ name: '(config)', error: p }))];

  for (const [name, config] of servers) {
    try {
      onProgress(`connecting to ${name}`);
      const client = McpClient.fromConfig(name, config, { cwd });
      await client.connect({ signal });
      clients.push(client);
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      failed.push({ name, error: e.message });
    }
  }

  const { tools, alwaysAllow } = adaptAll(clients, { config: servers });
  return { clients, failed, tools, alwaysAllow };
}

export async function closeServers(clients) {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
}
