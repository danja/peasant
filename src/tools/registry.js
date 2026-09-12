// The one list of tools.
//
// Everything that needs to know what tools exist reads it from here: the agent
// loop, the permission policy, and the guard test that binds each tool's
// advertised schema to the one that validates its arguments.

import read from './read.js';
import write from './write.js';
import edit from './edit.js';
import ls from './ls.js';
import glob from './glob.js';
import grep from './grep.js';
import bash from './bash.js';

export const TOOLS = Object.freeze([read, write, edit, ls, glob, grep, bash]);

export const TOOL_NAMES = Object.freeze(TOOLS.map((t) => t.name));

export function byName(name) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`unknown tool ${JSON.stringify(name)}. Known: ${TOOL_NAMES.join(', ')}`);
  return t;
}

// What goes into a provider request.
export function specs(tools = TOOLS) {
  return tools.map((t) => t.spec);
}
