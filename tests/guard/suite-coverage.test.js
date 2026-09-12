// Every test directory must be run by some npm script.
//
// "Added a test directory / forgot the include list / tests written, never run"
// happened twice in the sibling project before anyone noticed. The cost is not
// a failing suite -- it is a passing one that proves nothing.
//
// It also keeps the suites disjoint: tests/live talks to real providers on a
// metered free tier and must never be swept up by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './lib/scan.js';

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const TESTS = path.join(REPO, 'tests');

const suiteDirs = fs.readdirSync(TESTS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('_') && e.name !== 'lib')
  .map((e) => e.name);

const scripts = Object.entries(pkg.scripts).filter(([name]) => name.startsWith('test'));

function dirsNamedBy(command) {
  return [...command.matchAll(/tests\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
}

test('every tests/ subdirectory is named by a test script', () => {
  const covered = new Set(scripts.flatMap(([, cmd]) => dirsNamedBy(cmd)));
  const orphans = suiteDirs.filter((d) => !covered.has(d));
  assert.deepEqual(orphans, [],
    `these test directories exist but no npm script runs them: ${orphans.join(', ')}`);
});

test('every directory a test script names actually exists', () => {
  const missing = [];
  for (const [name, cmd] of scripts) {
    for (const d of dirsNamedBy(cmd)) {
      if (!fs.existsSync(path.join(TESTS, d))) missing.push(`${name} -> tests/${d}`);
    }
  }
  assert.deepEqual(missing, [], `test scripts point at directories that do not exist: ${missing.join(', ')}`);
});

test('the suites are disjoint -- no directory is run by two scripts', () => {
  const seen = new Map();
  const clashes = [];
  for (const [name, cmd] of scripts) {
    for (const d of dirsNamedBy(cmd)) {
      if (seen.has(d)) clashes.push(`tests/${d} is run by both ${seen.get(d)} and ${name}`);
      else seen.set(d, name);
    }
  }
  assert.deepEqual(clashes, [], clashes.join('; '));
});

test('the live suite is not part of the default sweep', () => {
  // tests/live spends a metered free-tier quota. `npm test` must never touch it.
  assert.ok(!dirsNamedBy(pkg.scripts.test).includes('live'),
    '`npm test` must not run tests/live -- it costs real quota');
});

test('the scan found suites to check', () => {
  assert.ok(suiteDirs.length > 0, 'no test directories found -- this guard is blind');
});
