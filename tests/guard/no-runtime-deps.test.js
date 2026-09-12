// Peasant ships with no runtime dependencies. Not by discipline -- by this.
//
// Every dependency is a chance to pull in a prebuilt binary compiled for a
// newer CPU baseline, which is the exact failure this project exists to avoid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, listFiles, extractImports, isPermitted } from './lib/scan.js';

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

test('package.json declares no dependencies', () => {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies']) {
    const v = pkg[field];
    assert.ok(v === undefined || Object.keys(v).length === 0,
      `package.json must not declare ${field}; found ${JSON.stringify(v)}`);
  }
});

test('package.json declares no devDependencies either', () => {
  // node:test is the runner and `node --check` is the linter. If this ever has
  // to change, it is a decision worth making explicitly rather than by install.
  const v = pkg.devDependencies;
  assert.ok(v === undefined || Object.keys(v).length === 0,
    `package.json must not declare devDependencies; found ${JSON.stringify(v)}`);
});

test('no shipped file imports anything but node: builtins and relative paths', () => {
  const offenders = [];
  for (const file of listFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    for (const spec of extractImports(src)) {
      if (!isPermitted(spec)) offenders.push(`${path.relative(REPO, file)}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, [],
    `shipped code may only import node: builtins and relative paths:\n  ${offenders.join('\n  ')}`);
});

test('the scan actually looked at something', () => {
  // A guard that silently scans zero files passes forever. Bind it to a count.
  assert.ok(listFiles().length > 0, 'listFiles() found no shipped source -- the guard is blind');
});
