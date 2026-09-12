import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineProfile, NON_CHAT } from '../../src/provider/profiles/generic.js';
import { PROFILES, DEFAULT_ORDER, byName, configure, resolveOrder, selectModel } from '../../src/provider/ProfileRegistry.js';
import groq from '../../src/provider/profiles/groq.js';
import mistral from '../../src/provider/profiles/mistral.js';

const minimal = {
  name: 'test', baseUrl: 'https://example.com/v1',
  keyVar: 'T_API_KEY', baseUrlVar: 'T_BASE_URL', modelVar: 'T_MODEL',
};

test('defineProfile fills defaults and freezes the result', () => {
  const p = defineProfile(minimal);
  assert.equal(p.auth, 'bearer');
  assert.equal(p.includeUsage, true);
  assert.ok(Object.isFrozen(p));
});

test('defineProfile refuses a profile missing something structural', () => {
  for (const field of ['name', 'baseUrl', 'keyVar', 'baseUrlVar', 'modelVar']) {
    const broken = { ...minimal };
    delete broken[field];
    assert.throws(() => defineProfile(broken), new RegExp(field));
  }
});

test('defineProfile refuses a non-https or trailing-slash base URL', () => {
  assert.throws(() => defineProfile({ ...minimal, baseUrl: 'http://example.com/v1' }), /must be https/);
  assert.throws(() => defineProfile({ ...minimal, baseUrl: 'https://example.com/v1/' }), /must not end in a slash/);
});

test('defineProfile refuses a reset header with no format', () => {
  assert.throws(
    () => defineProfile({ ...minimal, rateLimit: { resetTokens: 'x-reset' } }),
    /names a reset header but no resetFormat/,
  );
});

test('defineProfile refuses a token limit with neither reset nor implied window', () => {
  // This is the Mistral case. Without one or the other the limiter cannot know
  // when the window rolls, and would either stall forever or overrun.
  assert.throws(
    () => defineProfile({ ...minimal, rateLimit: { limitTokens: 'x-limit' } }),
    /impliedWindowMs is required/,
  );
  assert.doesNotThrow(
    () => defineProfile({ ...minimal, rateLimit: { limitTokens: 'x-limit', impliedWindowMs: 60_000 } }),
  );
});

test('defineProfile refuses an unknown reset format', () => {
  assert.throws(
    () => defineProfile({ ...minimal, rateLimit: { resetTokens: 'x', resetFormat: 'fortnights' } }),
    /unknown resetFormat/,
  );
});

test('the measured profiles carry the header names that were actually observed', () => {
  // If these drift from docs/providers.md the limiter reads nothing and
  // silently falls back to guessing.
  assert.equal(groq.rateLimit.limitTokens, 'x-ratelimit-limit-tokens');
  assert.equal(groq.rateLimit.resetFormat, 'duration');
  assert.equal(mistral.rateLimit.limitTokens, 'x-ratelimit-limit-tokens-minute');
  assert.equal(mistral.rateLimit.resetFormat, null);
  assert.equal(mistral.rateLimit.impliedWindowMs, 60_000);
  assert.equal(mistral.rateLimit.queryCost, 'x-ratelimit-tokens-query-cost');
});

test('groq keeps the generic non-chat filters as well as its own', () => {
  // The bug this pins: an earlier version built nonChat from a property that
  // did not exist, silently dropping every generic filter, so whisper and
  // prompt-guard models became selectable.
  for (const id of ['whisper-large-v3', 'meta-llama/llama-prompt-guard-2-22m', 'canopylabs/orpheus-v1-english']) {
    assert.ok(groq.nonChat.some((re) => re.test(id)), `${id} should be filtered out`);
  }
  assert.ok(groq.nonChat.some((re) => re.test('groq/compound')), 'groq/compound should be filtered out');
  assert.ok(NON_CHAT.every((re) => groq.nonChat.includes(re)), 'every generic filter must survive');
});

test('selectModel picks by preference from the real Groq catalogue', () => {
  const ids = [
    'allam-2-7b', 'canopylabs/orpheus-v1-english', 'groq/compound', 'groq/compound-mini',
    'meta-llama/llama-prompt-guard-2-22m', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b',
    'qwen/qwen3.6-27b', 'whisper-large-v3',
  ];
  assert.equal(selectModel(groq, ids), 'openai/gpt-oss-20b');
});

test('selectModel never returns a non-chat model', () => {
  const ids = ['whisper-large-v3', 'mistral-embed', 'mistral-ocr-latest', 'voxtral-mini-latest'];
  assert.throws(() => selectModel(mistral, ids), /no chat models in the catalogue at all/);
});

test('selectModel refuses rather than guessing when nothing matches', () => {
  // No inline fallbacks. Picking "the first one" would select a text-to-speech
  // model on Groq, and the failure would surface far from the cause.
  assert.throws(() => selectModel(groq, ['some-unknown-model']), /Set GROQ_MODEL to one of: some-unknown-model/);
});

test('selectModel honours an explicit override without second-guessing it', () => {
  assert.equal(selectModel(groq, ['a', 'b'], 'whisper-large-v3'), 'whisper-large-v3');
});

test('byName refuses an unknown provider and lists the known ones', () => {
  assert.equal(byName('groq').name, 'groq');
  assert.throws(() => byName('gorq'), /unknown provider "gorq"\. Known: groq, mistral/);
});

test('configure marks a provider without a key unusable', () => {
  assert.equal(configure(groq, {}).usable, false);
  assert.equal(configure(groq, { GROQ_API_KEY: 'k' }).usable, true);
});

test('configure lets env override the base URL and model', () => {
  const c = configure(groq, { GROQ_API_KEY: 'k', GROQ_BASE_URL: 'https://proxy/v1', GROQ_MODEL: 'm' });
  assert.equal(c.baseUrl, 'https://proxy/v1');
  assert.equal(c.model, 'm');
});

test('resolveOrder defaults to the hosted providers, not the local ones', () => {
  // Probing a port nobody is listening on costs a connection refusal on every
  // start, for a provider most people do not run. Naming one turns it on.
  assert.deepEqual(resolveOrder({}).map((c) => c.name), DEFAULT_ORDER);
  assert.ok(!DEFAULT_ORDER.includes('ollama'));
  assert.ok(PROFILES.some((p) => p.name === 'ollama'), 'but it still exists');
});

test('a local provider is usable without a key', () => {
  // It has no account. An empty key is not a reason to skip it.
  const [ollama] = resolveOrder({ PEASANT_PROVIDERS: 'ollama' });
  assert.equal(ollama.usable, true);
  assert.equal(ollama.key, '');
  assert.equal(ollama.baseUrl, 'http://127.0.0.1:11434/v1');
});

test('a hosted provider is still unusable without a key', () => {
  assert.equal(configure(byName('groq'), {}).usable, false);
});

test('plaintext is allowed for loopback and refused for anything else', () => {
  // The key never leaves the machine, so a local server needs no TLS. A remote
  // one over http would put it on the wire.
  assert.doesNotThrow(() => defineProfile({
    ...minimal, baseUrl: 'http://127.0.0.1:1234/v1', requiresKey: false,
  }));
  assert.throws(() => defineProfile({
    ...minimal, baseUrl: 'http://example.com/v1', requiresKey: false,
  }), /must be https unless it is loopback/);
});

test('a plaintext loopback provider must declare that it needs no key', () => {
  // Otherwise a key would be configured for a connection with no TLS, and
  // nothing would say so.
  assert.throws(() => defineProfile({ ...minimal, baseUrl: 'http://127.0.0.1:1234/v1' }),
    /must set requiresKey: false/);
});

test('resolveOrder respects the configured order', () => {
  assert.deepEqual(
    resolveOrder({ PEASANT_PROVIDERS: 'mistral, groq' }).map((c) => c.name),
    ['mistral', 'groq'],
  );
});

test('resolveOrder refuses a typo rather than silently shrinking the pool', () => {
  // The symptom of a silently dropped provider is "it stalls sometimes",
  // which is the most expensive kind of bug to chase.
  assert.throws(() => resolveOrder({ PEASANT_PROVIDERS: 'groq,mistrel' }), /unknown provider "mistrel"/);
});

test('resolveOrder refuses a duplicate', () => {
  assert.throws(() => resolveOrder({ PEASANT_PROVIDERS: 'groq,mistral,groq' }), /listed twice/);
});

test('openrouter sends attribution headers only when configured', () => {
  const or = byName('openrouter');
  assert.deepEqual(or.headers({}), {});
  assert.deepEqual(or.headers({ OPENROUTER_SITE_URL: 'https://x', OPENROUTER_SITE_NAME: 'p' }),
    { 'http-referer': 'https://x', 'x-title': 'p' });
});
