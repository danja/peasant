// Refuse to start on a runtime that has not been shown to work.
//
// The failure this prevents is not a crash -- it is a crash forty seconds into
// a session, after a prompt has been typed and quota has been spent, with
// `Illegal instruction` and no further explanation. A SIGILL cannot be caught,
// so the only defence is to check the things that are checkable before any real
// work starts, and to say what to do about it.
//
// The supported floor is `engines.node` in package.json, and nowhere else.
// npm always ships package.json, so there is one copy at runtime;
// tests/guard/engines.test.js binds it to docs/runtime-baseline.md, which is
// where the measurement is recorded.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(fileURLToPath(import.meta.url), '../../../package.json');

export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Only the `>=x.y.z` form is supported, deliberately. A range expressive enough
// to be ambiguous is a range someone will get wrong, and the floor here is a
// measurement with one number in it.
export function satisfiesFloor(version, range) {
  const m = /^>=\s*v?(\d+)\.(\d+)\.(\d+)$/.exec(String(range).trim());
  if (!m) throw new Error(`engines.node must be of the form ">=x.y.z"; got ${JSON.stringify(range)}`);
  const have = parseVersion(version);
  if (!have) throw new Error(`cannot parse runtime version ${JSON.stringify(version)}`);
  return compareVersions(have, [Number(m[1]), Number(m[2]), Number(m[3])]) >= 0;
}

export function readFloor(pkgPath = PKG) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const range = pkg.engines?.node;
  if (!range) throw new Error('package.json declares no engines.node; there is no supported floor to check against');
  return range;
}

// Returns a list of problems rather than throwing, so a caller can decide
// whether to refuse or to warn, and so the tests can assert on the content.
export function check({ version = process.version, floor = readFloor(), platform = process.platform, arch = process.arch } = {}) {
  const problems = [];

  if (!satisfiesFloor(version, floor)) {
    problems.push({
      kind: 'node-version',
      detail: `Node ${version} is below the supported floor ${floor}.`,
      remedy: 'Install a newer Node, or run ./bin/probe-node-matrix.sh to find which majors work on this CPU and record the result in docs/runtime-baseline.md.',
    });
  }

  if (platform === 'win32') {
    problems.push({
      kind: 'platform',
      detail: 'Windows is not supported: the shell tool assumes a POSIX shell.',
      remedy: 'Run peasant inside WSL2, where a POSIX shell and the Node builds this project is tested against are both available.',
    });
  }

  if (!['x64', 'arm64', 'arm'].includes(arch)) {
    problems.push({
      kind: 'arch',
      detail: `Untested architecture: ${arch}.`,
      remedy: 'Run `node bin/probe-runtime.js` and add the result to docs/runtime-baseline.md.',
    });
  }

  return problems;
}

export function format(problems) {
  if (problems.length === 0) return '';
  const lines = ['peasant cannot start:', ''];
  for (const p of problems) {
    lines.push(`  ${p.detail}`);
    lines.push(`    -> ${p.remedy}`);
    lines.push('');
  }
  return lines.join('\n');
}

// The entry point calls this before anything else. It writes to stderr rather
// than through src/ui/Terminal.js on purpose: this runs before the UI exists,
// and a preflight failure that depends on the UI loading cleanly is no defence.
export function assertRunnable(options = {}) {
  const problems = check(options);
  if (problems.length > 0) {
    process.stderr.write(format(problems));
    process.exit(78); // EX_CONFIG
  }
}
