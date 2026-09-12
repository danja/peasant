import fs from 'node:fs';
import path from 'node:path';
import { defineTool, ToolError } from './Tool.js';
import { resolveInside, display } from './paths.js';

export default defineTool({
  name: 'write',
  description:
    'Create a file, or replace one entirely. To change part of an existing file use edit instead, '
    + 'which is far cheaper and cannot lose the parts you did not mention.',
  mutates: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      content: { type: 'string', description: 'The complete new contents of the file.' },
    },
    required: ['path', 'content'],
  },

  run({ path: relative, content }, { root }) {
    const file = resolveInside(root, relative, { mustExist: false });

    let existed = false;
    try { existed = fs.statSync(file).isFile(); } catch { /* new file */ }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');

    const lines = content === '' ? 0 : content.split('\n').length;
    return `${existed ? 'replaced' : 'wrote'} ${display(root, file)} (${lines} lines, ${Buffer.byteLength(content)} bytes)`;
  },
});
