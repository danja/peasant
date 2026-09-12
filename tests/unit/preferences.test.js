import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preferences, DEFAULTS, TUNABLE_ENV_VARS } from '../../src/config/preferences.js';

test('defaults are frozen and complete', () => {
  const p = preferences({});
  assert.ok(Object.isFrozen(p));
  assert.deepEqual(Object.keys(p).sort(), Object.keys(DEFAULTS).sort());
});

test('rotation is on by default', () => {
  // It is most of the value of using free tiers at all.
  assert.equal(preferences({}).rotate, true);
});

test('rotation can be turned off in every conventional spelling', () => {
  for (const v of ['0', 'false', 'no', 'off', 'OFF', ' Off ']) {
    assert.equal(preferences({ PEASANT_ROTATE: v }).rotate, false, `PEASANT_ROTATE=${v}`);
  }
  for (const v of ['1', 'true', 'yes', 'on', 'ON']) {
    assert.equal(preferences({ PEASANT_ROTATE: v }).rotate, true, `PEASANT_ROTATE=${v}`);
  }
});

test('an unparseable setting is an error naming the variable', () => {
  // No inline fallbacks. A typo in .env that silently halves your throughput
  // and says nothing is exactly the failure this prevents.
  assert.throws(() => preferences({ PEASANT_ROTATE: 'maybe' }), /PEASANT_ROTATE must be one of/);
  assert.throws(() => preferences({ PEASANT_MAX_WAIT_MS: 'soon' }), /PEASANT_MAX_WAIT_MS must be a number/);
  assert.throws(() => preferences({ PEASANT_MAX_WAIT_MS: '1.5' }), /must be a whole number/);
  assert.throws(() => preferences({ PEASANT_BACKOFF_MS: '-1' }), /must be between 0 and/);
  assert.throws(() => preferences({ PEASANT_COMPACT_AT: '2' }), /must be between 0\.1 and 0\.95/);
});

test('an unset or empty variable leaves the default alone', () => {
  assert.equal(preferences({ PEASANT_MAX_WAIT_MS: '' }).maxWaitMs, DEFAULTS.maxWaitMs);
  assert.equal(preferences({}).maxWaitMs, DEFAULTS.maxWaitMs);
});

test('numbers are read', () => {
  const p = preferences({ PEASANT_MAX_WAIT_MS: '250', PEASANT_BACKOFF_MS: '60000', PEASANT_COMPACT_AT: '0.5' });
  assert.equal(p.maxWaitMs, 250);
  assert.equal(p.backoffMs, 60_000);
  assert.equal(p.compactAt, 0.5);
});

test('every tunable has an environment variable', () => {
  assert.equal(TUNABLE_ENV_VARS.length, Object.keys(DEFAULTS).length,
    'a tunable with no env var cannot be tuned from .env, which is where settings live');
  for (const v of TUNABLE_ENV_VARS) assert.match(v, /^PEASANT_/);
});
