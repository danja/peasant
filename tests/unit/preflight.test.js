import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions, satisfiesFloor, readFloor, check, format }
  from '../../src/compat/Preflight.js';

test('parses the version forms Node reports', () => {
  assert.deepEqual(parseVersion('v18.20.8'), [18, 20, 8]);
  assert.deepEqual(parseVersion('25.2.1'), [25, 2, 1]);
  assert.deepEqual(parseVersion('v20.0.0-nightly20240101'), [20, 0, 0]);
  assert.equal(parseVersion('not a version'), null);
});

test('compares versions numerically, not lexically', () => {
  // The bug this pins: '9' > '10' as strings.
  assert.equal(compareVersions([9, 0, 0], [10, 0, 0]), -1);
  assert.equal(compareVersions([18, 20, 8], [18, 9, 0]), 1);
  assert.equal(compareVersions([22, 1, 0], [22, 1, 0]), 0);
});

test('satisfiesFloor accepts at or above, refuses below', () => {
  assert.ok(satisfiesFloor('v18.0.0', '>=18.0.0'));
  assert.ok(satisfiesFloor('v25.2.1', '>=18.0.0'));
  assert.ok(!satisfiesFloor('v16.20.2', '>=18.0.0'));
  assert.ok(!satisfiesFloor('v17.9.0', '>=18.0.0'));
});

test('satisfiesFloor refuses a range it cannot evaluate rather than guessing', () => {
  // No inline fallbacks: an unparseable floor is an error to fix, not a
  // permissive default that lets an unsupported runtime through.
  for (const bad of ['^18.0.0', '18.x', '>=18', 'latest', '']) {
    assert.throws(() => satisfiesFloor('v20.0.0', bad), /engines\.node/);
  }
});

test('readFloor reads the real package.json', () => {
  assert.match(readFloor(), /^>=\d+\.\d+\.\d+$/);
});

test('the running Node satisfies the declared floor', () => {
  // If this fails, the suite is being run on a runtime the project claims not
  // to support -- which makes every other result here untrustworthy.
  assert.deepEqual(check().filter((p) => p.kind === 'node-version'), []);
});

test('reports a below-floor runtime with a remedy', () => {
  const problems = check({ version: 'v16.20.2', floor: '>=18.0.0' });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'node-version');
  assert.match(problems[0].detail, /v16\.20\.2/);
  assert.match(problems[0].remedy, /probe-node-matrix/);
});

test('every problem names a remedy, not just a complaint', () => {
  // Where a failure has one cause, the error message should name the cure.
  const problems = check({ version: 'v16.0.0', floor: '>=18.0.0', platform: 'win32', arch: 'mips' });
  assert.equal(problems.length, 3);
  for (const p of problems) {
    assert.ok(p.remedy && p.remedy.length > 10, `${p.kind} has no usable remedy`);
  }
});

test('format produces empty output when there is nothing wrong', () => {
  assert.equal(format([]), '');
});

test('format includes both the problem and the remedy', () => {
  const out = format(check({ version: 'v16.0.0', floor: '>=18.0.0' }));
  assert.match(out, /below the supported floor/);
  assert.match(out, /->/);
});
