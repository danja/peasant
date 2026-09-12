// Where MCP servers are declared.
//
// The same layering as .env, and for the same reason: a server you always want
// belongs with peasant, and a server specific to one repository belongs with
// that repository.
//
//   ~/.config/peasant/mcp.json   (or $PEASANT_HOME/mcp.json)
//   ./.peasant/mcp.json
//
// The shape is the one every other MCP client uses, so a block can be copied
// from an existing configuration without translation:
//
//   { "mcpServers": {
//       "files":  { "command": "npx", "args": ["-y", "@x/server"], "env": {} },
//       "remote": { "url": "https://example.com/mcp", "headers": {} }
//   } }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configFiles({ env = process.env, cwd = process.cwd(), home = os.homedir() } = {}) {
  const userDir = env.PEASANT_HOME
    ? (env.PEASANT_HOME.startsWith('~') ? path.join(home, env.PEASANT_HOME.slice(1)) : env.PEASANT_HOME)
    : path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'peasant');

  return [path.join(userDir, 'mcp.json'), path.join(cwd, '.peasant', 'mcp.json')];
}

// Later files override earlier ones by server name, so a repository can replace
// a globally configured server without disabling it everywhere.
export function loadServers(options = {}) {
  const servers = new Map();
  const problems = [];

  for (const file of options.files ?? configFiles(options)) {
    if (!fs.existsSync(file)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      // Named, not skipped: a malformed config is a typo to fix, and silently
      // ignoring it means a server that simply never appears.
      problems.push(`${file}: not valid JSON (${e.message})`);
      continue;
    }

    const block = parsed.mcpServers ?? parsed.servers;
    if (!block || typeof block !== 'object') {
      problems.push(`${file}: no "mcpServers" object`);
      continue;
    }

    for (const [name, config] of Object.entries(block)) {
      if (config?.disabled === true) { servers.delete(name); continue; }
      servers.set(name, { ...config, source: file });
    }
  }

  return { servers, problems };
}
