// What MCP servers are configured, what they offer, and whether they work.

import { loadServers, configFiles } from '../mcp/config.js';
import { connectServers, closeServers } from '../mcp/connect.js';
import { workspaceRoot } from '../tools/paths.js';

export async function mcp(term, env, { signal } = {}) {
  const cwd = workspaceRoot();
  const { servers, problems } = loadServers({ env, cwd });

  term.line(term.paint('configuration', 'bold'));
  for (const file of configFiles({ env, cwd })) {
    const named = [...servers.values()].filter((s) => s.source === file).length;
    term.line(term.paint(`  ${named > 0 ? `${named} server(s)` : 'none      '}  ${file}`, 'grey'));
  }
  for (const p of problems) term.line(term.paint(`  ${p}`, 'yellow'));
  term.line('');

  if (servers.size === 0) {
    term.line(term.paint('no MCP servers configured.', 'grey'));
    term.line(term.paint('Write one of the files above, in the shape every MCP client uses:', 'grey'));
    term.line('');
    term.line(term.paint('  {"mcpServers": {', 'grey'));
    term.line(term.paint('    "files":  {"command": "npx", "args": ["-y", "some-mcp-server"]},', 'grey'));
    term.line(term.paint('    "remote": {"url": "https://example.com/mcp", "headers": {}}', 'grey'));
    term.line(term.paint('  }}', 'grey'));
    return 0;
  }

  term.line(term.paint('servers', 'bold'));
  const { clients, failed, tools, alwaysAllow } = await connectServers({
    env, cwd, signal,
    onProgress: (m) => term.status(term.paint(`  ${m}...`, 'grey')),
  });
  term.clearStatus();

  try {
    for (const client of clients) {
      const info = client.serverInfo;
      // padEnd only pads; a name longer than the column runs into what
      // follows, which is how "codebase-memory" and its version became one word.
      term.line(`${term.paint(client.name.padEnd(14), 'bold')} `
        + term.paint(`${info?.name ?? 'unknown'} ${info?.version ?? ''} · ${client.tools.length} tools`, 'grey'));
      for (const tool of client.tools) {
        const adapted = tools.find((x) => x.description.includes(`[${client.name}]`)
          && x.name.endsWith(tool.name.toLowerCase().replace(/[^a-z0-9_]+/g, '_')));
        const permitted = adapted && alwaysAllow.includes(adapted.name);
        const writes = adapted && adapted.mutates && !permitted
          ? term.paint(' (asks first)', 'yellow')
          : (permitted ? term.paint(' (alwaysAllow)', 'cyan') : '');
        term.line(term.paint(`  ${tool.name}`, 'cyan') + writes);
        if (tool.description) term.line(term.paint(`    ${firstLine(tool.description)}`, 'grey'));
      }
    }
    for (const f of failed) {
      term.line(`${term.paint(f.name.padEnd(14), 'yellow')} ${f.error}`);
    }
  } finally {
    await closeServers(clients);
  }

  term.line('');
  term.line(term.paint(
    `${tools.length} tool${tools.length === 1 ? '' : 's'} would be offered to the model, `
    + 'alongside the seven built in', 'grey'));
  return 0;
}

function firstLine(text) {
  const line = String(text).split('\n')[0].trim();
  return line.length > 90 ? `${line.slice(0, 90)}...` : line;
}
