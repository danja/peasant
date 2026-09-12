import fs from 'node:fs';
import { defineTool, ToolError } from './Tool.js';
import { resolveInside, display, isBinary } from './paths.js';

// Exact-string replacement rather than diff-apply.
//
// It is much cheaper in tokens than a diff -- which matters more here than
// usual -- and it fails loudly rather than plausibly: a diff that does not
// apply cleanly can still be forced somewhere wrong, whereas a string that is
// not unique simply is not unique. See docs/prior-art.md.
export default defineTool({
  name: 'edit',
  description:
    'Replace an exact string in a file. The string must appear exactly once, so include enough '
    + 'surrounding context to make it unique. Much cheaper than rewriting the file with write.',
  mutates: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      old: { type: 'string', minLength: 1, description: 'The exact text to replace, including indentation.' },
      new: { type: 'string', description: 'The replacement text. Empty to delete.' },
      all: {
        type: 'boolean', default: false,
        description: 'Replace every occurrence instead of requiring exactly one.',
      },
    },
    required: ['path', 'old', 'new'],
  },

  run({ path: relative, old, new: replacement, all }, { root }) {
    const file = resolveInside(root, relative);
    const buffer = fs.readFileSync(file);
    if (isBinary(buffer)) throw new ToolError(`${display(root, file)} is a binary file`);

    const before = buffer.toString('utf8');
    const count = countOccurrences(before, old);

    if (count === 0) {
      throw new ToolError(
        `that exact text does not appear in ${display(root, file)}. `
        + 'Read the file again -- whitespace and indentation must match exactly.',
      );
    }
    if (count > 1 && !all) {
      throw new ToolError(
        `that text appears ${count} times in ${display(root, file)}. `
        + 'Include more surrounding context to make it unique, or set all to true.',
      );
    }
    if (old === replacement) throw new ToolError('old and new are identical; nothing to do');

    const after = all ? before.split(old).join(replacement) : before.replace(old, replacement);
    fs.writeFileSync(file, after, 'utf8');

    return `edited ${display(root, file)} (${count} replacement${count === 1 ? '' : 's'})`;
  },
});

function countOccurrences(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) { n++; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}
