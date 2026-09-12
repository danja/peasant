// Content search through ripgrep, when the machine has one.
//
// It is not bundled and never will be: a prebuilt binary is banned here and the
// target CPU is why. But a ripgrep already on the PATH was built for that
// machine, and using it breaks no rule -- ripgrep 15.1.0 runs on the Athlon II,
// which is how we know.
//
// Every flag below exists to make this agree with the JavaScript engine:
// ripgrep's defaults respect .gitignore and skip hidden files, and neither is
// what `grep` means here.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { SKIP_DIRS } from '../paths.js';

export const name = 'ripgrep';

// Rust's regex crate has no lookaround and no backreferences. A pattern using
// either is valid JavaScript and invalid here, so the caller falls back.
export class UnsupportedPattern extends Error {}

export async function search({ root, from, pattern, ignoreCase, include, ceiling, signal }) {
  const args = [
    '--no-heading', '--line-number', '--color=never', '--no-messages',
    '--no-ignore',   // .gitignore is not a search preference
    '--sort', 'path',
    // Deliberately NOT --hidden. ripgrep's default skips dot-entries while
    // walking but still searches a dot-path given explicitly on the command
    // line, which is exactly what the JavaScript engine does. An earlier
    // version passed --hidden and excluded dotfiles with -g '!**/.*', plus
    // -g '**/.github/**' to re-include one -- and found nothing at all,
    // because in ripgrep *any* positive glob is a whitelist.
  ];
  // Order matters, and it is the opposite of the obvious one: in ripgrep the
  // *last* matching glob wins. The caller's include glob therefore goes first
  // and the exclusions after it, or `include: '**/*.js'` re-enables every
  // directory the exclusions just removed -- which the parity test caught
  // searching dist/, and would have meant grepping node_modules and spending a
  // minute of token budget on a dependency tree.
  if (include) args.push('-g', include);
  for (const dir of SKIP_DIRS) args.push('-g', `!**/${dir}/**`);
  if (ignoreCase) args.push('-i');
  args.push('-e', pattern, '--', from);

  const { code, stdout, stderr } = await run(args, { cwd: root, signal });

  // 0 = matches, 1 = none, 2 = error.
  if (code === 2) {
    if (/regex parse error|not supported|unrecognized/i.test(stderr)) {
      throw new UnsupportedPattern(stderr.trim().split('\n')[0] ?? 'pattern not supported by ripgrep');
    }
    throw new Error(`ripgrep failed: ${stderr.trim().split('\n')[0] ?? `exit ${code}`}`);
  }

  const matches = [];
  let truncated = false;

  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const parsed = parseLine(line, root);
    if (!parsed) continue;
    matches.push(parsed);
    if (matches.length >= ceiling) { truncated = true; break; }
  }

  return { matches, truncated };
}

// `path:line:text`, where text may itself contain colons.
function parseLine(line, root) {
  const first = line.indexOf(':');
  if (first === -1) return null;
  const second = line.indexOf(':', first + 1);
  if (second === -1) return null;

  const file = line.slice(0, first);
  const lineNumber = Number(line.slice(first + 1, second));
  if (!Number.isInteger(lineNumber)) return null;

  return {
    file: path.relative(root, path.resolve(root, file)),
    line: lineNumber,
    text: line.slice(second + 1),
  };
}

function run(args, { cwd, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr });
    });
  });
}
