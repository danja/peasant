import fs from 'node:fs';
import path from 'node:path';
import { defineTool, ToolError } from './Tool.js';
import { resolveInside, display, SKIP_DIRS } from './paths.js';

export default defineTool({
  name: 'ls',
  description: 'List the contents of a directory in the workspace. Directories are marked with a trailing slash.',
  mutates: false,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', default: '.', description: 'Directory relative to the workspace root.' },
    },
    required: [],
  },

  run({ path: relative }, { root }) {
    const dir = resolveInside(root, relative);
    if (!fs.statSync(dir).isDirectory()) throw new ToolError(`${relative} is not a directory; use read`);

    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') || e.name === '.env.example')
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));

    if (entries.length === 0) return `${display(root, dir)} is empty`;
    const dirs = entries.filter((e) => e.isDirectory()).length;

    const lines = entries.map((e) => {
      if (e.isDirectory()) return `${e.name}/${SKIP_DIRS.has(e.name) ? '  (not searched)' : ''}`;
      const size = fs.statSync(path.join(dir, e.name)).size;
      return `${e.name}  ${size}`;
    });
    // The count leads, because the first line is what a caller shows in a
    // one-line summary and "." says nothing.
    const summary = `${display(root, dir)}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`
      + `${dirs > 0 ? `, ${dirs} director${dirs === 1 ? 'y' : 'ies'}` : ''}`;
    return `${summary}\n${lines.join('\n')}`;
  },
});
