// Content search in pure JavaScript.
//
// The reference implementation: always available, no dependency, no binary, and
// the definition of what `grep` means here. The ripgrep engine must agree with
// it exactly -- tests/unit/search-parity.test.js is what makes that true rather
// than hoped.

import fs from 'node:fs';
import path from 'node:path';
import { SKIP_DIRS, isBinary } from '../paths.js';
import { globToRegExp } from '../glob.js';

export const name = 'javascript';

export async function search({ root, from, pattern, ignoreCase, include, ceiling }) {
  const re = new RegExp(pattern, ignoreCase ? 'i' : '');
  const includeRe = include ? globToRegExp(include) : null;
  const matches = [];
  let truncated = false;

  const visit = (dir) => {
    if (truncated) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    // Code-unit order, not localeCompare: ripgrep sorts bytes, and a
    // locale-aware comparison would put 'a.js' before 'B.js' where ripgrep
    // puts it after.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const e of entries) {
      if (truncated) return;
      // Dot-entries are skipped while walking, exactly as ripgrep does by
      // default. A dot-directory given *explicitly* as the search path is
      // still searched, in both engines, because only entries found during the
      // walk are filtered -- `grep pattern .github` works.
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);

      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        visit(full);
        continue;
      }
      if (!e.isFile()) continue;

      const rel = path.relative(from, full);
      if (includeRe && !includeRe.test(rel)) continue;

      let buffer;
      try { buffer = fs.readFileSync(full); } catch { continue; }
      if (isBinary(buffer)) continue;

      const lines = buffer.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        matches.push({ file: path.relative(root, full), line: i + 1, text: lines[i] });
        if (matches.length >= ceiling) { truncated = true; return; }
      }
    }
  };

  visit(from);
  return { matches, truncated };
}
