import fs from 'node:fs';
import { defineTool, ToolError } from './Tool.js';
import { resolveInside, display, isBinary } from './paths.js';

// Line numbers are worth their tokens: they are what `edit` and a person both
// refer to, and a model asked to change line 40 of an unnumbered file guesses.
const DEFAULT_LIMIT = 400;

export default defineTool({
  name: 'read',
  description:
    'Read a text file from the workspace, with line numbers. Returns at most a window of lines; '
    + 'use offset and limit to page through a large file rather than reading it whole.',
  mutates: false,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      offset: { type: 'integer', minimum: 1, default: 1, description: 'First line to read, 1-based.' },
      limit: {
        type: 'integer', minimum: 1, maximum: 2000, default: DEFAULT_LIMIT,
        description: `How many lines to read. Defaults to ${DEFAULT_LIMIT}.`,
      },
    },
    required: ['path'],
  },

  run({ path: relative, offset, limit }, { root }) {
    const file = resolveInside(root, relative);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) throw new ToolError(`${relative} is a directory; use ls`);

    const buffer = fs.readFileSync(file);
    if (isBinary(buffer)) throw new ToolError(`${display(root, file)} is a binary file`);

    const lines = buffer.toString('utf8').split('\n');
    // A trailing newline produces a final empty element that is not a line.
    if (lines.at(-1) === '') lines.pop();

    const start = Math.min(offset - 1, lines.length);
    const window = lines.slice(start, start + limit);
    const width = String(start + window.length).length;

    const body = window.map((line, i) => `${String(start + i + 1).padStart(width)}\t${line}`).join('\n');
    const shown = start + window.length;
    const more = shown < lines.length
      ? `\n\n[${lines.length - shown} more lines; read again with offset ${shown + 1}]`
      : '';

    if (window.length === 0) {
      return lines.length === 0
        ? `${display(root, file)} is empty`
        : `${display(root, file)} has ${lines.length} lines; offset ${offset} is past the end`;
    }
    return `${display(root, file)} (${lines.length} lines)\n${body}${more}`;
  },
});
