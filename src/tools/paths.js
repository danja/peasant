// Keeping the agent inside the workspace.
//
// Every tool that touches the filesystem resolves its path through here. The
// model is free to ask for anything; what it gets is confined to the directory
// peasant was started in, because "summarise ~/.ssh/id_rsa" should fail rather
// than work.
//
// Confinement is checked after resolution, so `../` and a symlink both meet the
// same test: does the real path live under the root?

import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from './Tool.js';

export function workspaceRoot(cwd = process.cwd()) {
  return fs.realpathSync(cwd);
}

// Resolves `relative` against the workspace and refuses anything outside it.
// `mustExist: false` is for a file about to be created -- the *parent* is then
// what has to be inside and real.
export function resolveInside(root, relative, { mustExist = true } = {}) {
  if (typeof relative !== 'string' || relative === '') {
    throw new ToolError('path must be a non-empty string');
  }

  const candidate = path.resolve(root, relative);

  // realpath resolves symlinks, which is the point: a link pointing out of the
  // workspace must not be a way through it.
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch (e) {
    if (e.code !== 'ENOENT') throw new ToolError(`cannot resolve ${relative}: ${e.message}`);
    if (mustExist) throw new ToolError(`${relative} does not exist`);

    // The file does not exist yet, and nor may its directory: `write` creates
    // intermediate directories, so `src/new/deep/a.js` is a legitimate target.
    // Walk up to the deepest ancestor that *does* exist, resolve that (which is
    // where a symlink could redirect us), check containment there, and rebuild
    // the rest. Checking only the immediate parent would refuse every nested
    // create; checking nothing would let a symlinked ancestor out.
    const missing = [];
    let ancestor = candidate;
    for (;;) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new ToolError(`cannot resolve ${relative}`);
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
      try {
        const realAncestor = fs.realpathSync(ancestor);
        assertInside(root, realAncestor, relative);
        return path.join(realAncestor, ...missing);
      } catch (err) {
        if (err instanceof ToolError) throw err;
        if (err.code !== 'ENOENT') throw new ToolError(`cannot resolve ${relative}: ${err.message}`);
      }
    }
  }

  assertInside(root, real, relative);
  return real;
}

function assertInside(root, real, shownAs) {
  const rel = path.relative(root, real);
  if (rel === '') return;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ToolError(
      `${shownAs} is outside the workspace. peasant only reads and writes under ${root}.`,
      { recoverable: true },
    );
  }
}

// How a path is shown to the model and the user: relative to the workspace, so
// transcripts are portable and do not leak a home directory name.
export function display(root, absolute) {
  const rel = path.relative(root, absolute);
  return rel === '' ? '.' : rel;
}

// Directories never worth walking. Skipping them is not only faster -- a glob
// that returns ten thousand node_modules paths costs a minute of token budget.
export const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.svn', '.hg', 'dist', 'build', 'coverage',
  '.next', '.cache', '.venv', 'venv', '__pycache__', 'target', 'vendor',
]);

export function isBinary(buffer) {
  // A NUL in the first few KB is the standard heuristic, and good enough: the
  // cost of being wrong is refusing to read a file, not corrupting one.
  const n = Math.min(buffer.length, 8000);
  for (let i = 0; i < n; i++) if (buffer[i] === 0) return true;
  return false;
}
