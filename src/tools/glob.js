import fs from 'node:fs';
import path from 'node:path';
import { defineTool } from './Tool.js';
import { resolveInside, display, SKIP_DIRS } from './paths.js';

const MAX_RESULTS = 200;

// Pure JavaScript, no dependency and no bundled binary: a prebuilt binary is
// banned outright here, and the target CPU is the reason.
export default defineTool({
  name: 'glob',
  description:
    'Find files by name pattern. Supports * (within a path segment), ** (across segments) and ?. '
    + 'Build directories such as node_modules and .git are never searched.',
  mutates: false,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      pattern: { type: 'string', minLength: 1, description: 'For example src/**/*.js or **/*.test.js' },
      path: { type: 'string', default: '.', description: 'Directory to search from, relative to the workspace root.' },
    },
    required: ['pattern'],
  },

  run({ pattern, path: relative }, { root }) {
    const from = resolveInside(root, relative);
    const re = globToRegExp(pattern);
    const found = [];

    walk(from, from, re, found);
    if (found.length === 0) return `no files match ${pattern}`;

    found.sort();
    const shown = found.slice(0, MAX_RESULTS);
    const more = found.length > shown.length ? `\n[${found.length - shown.length} more not shown]` : '';
    return `${found.length} file${found.length === 1 ? '' : 's'} matching ${pattern}\n${shown.join('\n')}${more}`;
  },
});

function walk(base, dir, re, found) {
  if (found.length > MAX_RESULTS * 4) return; // stop early; the caller reports the cap
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(base, path.join(dir, e.name), re, found);
    } else if (e.isFile()) {
      const rel = path.relative(base, path.join(dir, e.name));
      if (re.test(rel)) found.push(rel);
    }
  }
}

// Translates a glob to a regular expression. ** crosses separators, * does not,
// ? is a single character. Everything else is escaped, so a pattern containing
// a dot or a bracket matches literally rather than becoming a regex by accident.
export function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` should also match zero directories, so `src/**/*.js` finds
        // `src/a.js` as well as `src/deep/a.js`.
        if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}
