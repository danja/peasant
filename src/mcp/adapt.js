// Turning an MCP server's tools into peasant tools.
//
// The whole point is that nothing downstream can tell the difference: the agent
// loop, the permission policy and the token estimator all see a `Tool` and
// treat it exactly as they treat `read` or `bash`.

import { defineTool, ToolError } from '../tools/Tool.js';

// Tool names must be lower snake case here, and MCP servers use dashes, dots
// and capitals freely. The server's own name is kept for the actual call.
export function sanitise(serverName, toolName) {
  const clean = (s) => String(s).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const name = `mcp_${clean(serverName)}_${clean(toolName)}`;
  return /^[a-z]/.test(name) ? name : `mcp_${name}`;
}

// Whether a tool changes anything, which decides whether it needs permission.
//
// MCP has no required answer to this. `readOnlyHint` is a hint and optional, so
// **anything that does not say it is read-only is treated as mutating**. The
// cost of being wrong that way is an extra prompt; the cost of being wrong the
// other way is a server deleting something without asking.
export function mutatesFor(tool) {
  return tool?.annotations?.readOnlyHint === true ? false : true;
}

export function adaptTool(client, tool, { nameOverride = null } = {}) {
  const name = nameOverride ?? sanitise(client.name, tool.name);

  return defineTool({
    name,
    description: tool.description
      ? `[${client.name}] ${tool.description}`
      : `[${client.name}] ${tool.name}`,
    // Passed through as the server gave it: the server knows what it accepts.
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    mutates: mutatesFor(tool),
    external: true,

    async run(args, { signal }) {
      let result;
      try {
        result = await client.callTool(tool.name, args, { signal });
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw new ToolError(`${client.name} could not run ${tool.name}: ${e.message}`);
      }
      // A tool's own failure is reported to the model as text, exactly as a
      // built-in tool's failure is: it can usually work around one.
      if (result.isError) throw new ToolError(result.text || `${tool.name} failed`);
      return result.text === '' ? '(no output)' : result.text;
    },
  });
}

// Every tool from every connected server, with collisions resolved.
//
// Two servers can offer tools whose names sanitise to the same thing, and a
// silent overwrite would mean calls going to the wrong server -- which is very
// hard to notice and very annoying to diagnose.
//
// Also returns the peasant names of tools a server's configuration marks
// `alwaysAllow`. Many servers declare `readOnlyHint` on none of their tools --
// codebase-memory-mcp declares it on one of fifteen -- so peasant prompts
// before every graph query, which is correct and unusable. Naming them in
// configuration is a deliberate act by the person running the server, which is
// the right place for that decision.
export function adaptAll(clients, { config = new Map() } = {}) {
  const tools = [];
  const alwaysAllow = [];
  const taken = new Set();

  for (const client of clients) {
    const allowed = new Set(config.get(client.name)?.alwaysAllow ?? []);

    for (const tool of client.tools) {
      let name = sanitise(client.name, tool.name);
      if (taken.has(name)) {
        let n = 2;
        while (taken.has(`${name}_${n}`)) n++;
        name = `${name}_${n}`;
      }
      taken.add(name);
      tools.push(adaptTool(client, tool, { nameOverride: name }));
      // Matched on the server's own name, because that is what its
      // documentation calls it.
      if (allowed.has(tool.name) || allowed.has('*')) alwaysAllow.push(name);
    }
  }
  return { tools, alwaysAllow };
}
