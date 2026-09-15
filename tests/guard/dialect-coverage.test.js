// The dialect list and the dialects/ directory must agree.
//
// The same failure profile-coverage.test.js guards against, one level down: a
// file nobody imports is a format nobody can reach, and it looks exactly like a
// format that works until somebody sets it in a profile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './lib/scan.js';
import { DIALECTS, DIALECT_NAMES } from '../../src/provider/dialects/index.js';
import { PROFILES } from '../../src/provider/ProfileRegistry.js';

const DIR = path.join(REPO, 'src', 'provider', 'dialects');

test('every file in dialects/ is registered', () => {
  const files = fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .map((f) => f.replace(/\.js$/, ''));
  const unregistered = files.filter((f) => !DIALECT_NAMES.includes(f));
  assert.deepEqual(unregistered, [],
    `dialects/ contains files no one can reach: ${unregistered.join(', ')}`);
});

test('every registered dialect has a file of its own name', () => {
  const missing = DIALECT_NAMES.filter((n) => !fs.existsSync(path.join(DIR, `${n}.js`)));
  assert.deepEqual(missing, []);
});

test('every dialect is spoken by at least one profile', () => {
  // A format with no provider is untested by every other suite here, because
  // nothing in normal use constructs it.
  const spoken = new Set(PROFILES.map((p) => p.dialect));
  const orphans = DIALECT_NAMES.filter((n) => !spoken.has(n));
  assert.deepEqual(orphans, [], `no profile speaks: ${orphans.join(', ')}`);
});

test('the scan found dialects to check', () => {
  assert.ok(DIALECTS.length >= 2, 'fewer than two dialects -- this guard is blind');
});
