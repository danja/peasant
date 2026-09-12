import { defineTool, ToolError } from './Tool.js';
import { resolveInside } from './paths.js';
import { search, format } from './search/index.js';

// Returns matching *lines*, not matching files. At Groq's measured 8,000 tokens
// a minute, a tool that answers "it is in these twelve files" costs a second
// round trip and another read; answering with the line costs neither.
export default defineTool({
  name: 'grep',
  description:
    'Search file contents with a regular expression. Returns matching lines with their file and '
    + 'line number. Build directories such as node_modules and .git are never searched.',
  mutates: false,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      pattern: { type: 'string', minLength: 1, description: 'JavaScript regular expression.' },
      path: { type: 'string', default: '.', description: 'Directory to search, relative to the workspace root.' },
      include: { type: 'string', description: 'Only search files matching this glob, for example **/*.js' },
      ignoreCase: { type: 'boolean', default: false, description: 'Match case-insensitively.' },
    },
    required: ['pattern'],
  },

  async run({ pattern, path: relative, include, ignoreCase }, { root, signal }) {
    // Validated here rather than in an engine, so an invalid pattern is refused
    // the same way whichever engine would have run it.
    try {
      new RegExp(pattern);
    } catch (e) {
      throw new ToolError(`${pattern} is not a valid regular expression: ${e.message}`);
    }

    const from = resolveInside(root, relative);
    const result = await search({ root, from, pattern, ignoreCase, include, signal });
    return format(result, { pattern, path: relative });
  },
});
