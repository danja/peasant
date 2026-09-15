// The repository-root `peasant` launcher.
//
// Every property checked here fails *silently on someone else's clone* while
// working perfectly on the machine where it was written, which is the class of
// failure this directory exists for: an ignored file is simply absent, a lost
// executable bit is "Permission denied", and a launcher pointing at a renamed
// entry point is "Cannot find module".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './lib/scan.js';

const LAUNCHER = path.join(REPO, 'peasant');
const source = fs.existsSync(LAUNCHER) ? fs.readFileSync(LAUNCHER, 'utf8') : null;

test('the launcher exists', () => {
  assert.ok(source !== null, 'peasant is missing from the repository root');
});

test('the launcher is executable', () => {
  // git records this bit. Committed without it, `./peasant` is Permission
  // denied for everyone who clones, and nobody who has it can reproduce that.
  const mode = fs.statSync(LAUNCHER).mode;
  assert.ok(mode & 0o111, 'peasant is not executable -- chmod +x peasant');
});

test('the launcher starts with a shebang', () => {
  assert.match(source.split('\n')[0], /^#!/);
});

test('the launcher points at the real entry point', () => {
  // Binds two files that must agree. Renaming bin/peasant.js while leaving this
  // alone is the exact failure CLAUDE.md's recurring-failure table is for, and
  // nothing else connects them.
  const target = /bin\/peasant\.js/.exec(source);
  assert.ok(target, 'the launcher does not mention bin/peasant.js');
  assert.ok(fs.existsSync(path.join(REPO, 'bin', 'peasant.js')),
    'the launcher points at bin/peasant.js, which does not exist');
});

test('the launcher never changes the working directory', () => {
  // The cwd is peasant's *workspace*, not its installation. A `cd` here would
  // silently point peasant at its own source tree instead of the user's
  // project -- it would appear to work, and edit the wrong repository.
  //
  // Resolution legitimately uses `cd` inside a command substitution, whose
  // effect dies with the subshell; a bare `cd` does not.
  const offenders = source.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /(^|[;&|]\s*)cd\s/.test(line.replace(/#.*$/, '')))
    .filter(([, line]) => !line.includes('$('));
  assert.deepEqual(offenders.map(([n]) => n), [],
    `peasant changes the working directory at line(s) ${offenders.map(([n]) => n).join(', ')}`);
});

test('the launcher is not gitignored', (t) => {
  const r = spawnSync('git', ['check-ignore', '-q', 'peasant'], { cwd: REPO });
  if (r.error) return t.skip('git not available to evaluate .gitignore');
  assert.notEqual(r.status, 0, '.gitignore excludes the launcher -- a clone would not have it');
});

test('the launcher quotes no Node version of its own', () => {
  // The floor lives in package.json's `engines` and is bound to
  // docs/runtime-baseline.md by engines.test.js. A number repeated in a shell
  // script is a third copy that nothing keeps honest.
  assert.ok(!/\b(1[0-9]|2[0-9])\b/.test(source.replace(/peasant\.js/g, '')),
    'the launcher names a Node version; point at package.json engines instead');
});
