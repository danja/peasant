// The check that would have caught NVIDIA's guardrail.
//
// Every outcome is exercised against the fake provider, because the whole point
// of the check is what it says when a provider misbehaves, and a real provider
// cannot be asked to misbehave on demand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderClient } from '../../src/provider/Client.js';
import { defineProfile } from '../../src/provider/profiles/generic.js';
import { FakeProvider } from './lib/FakeProvider.js';
import { checkToolCall, CHECK_TOOL, OUTCOMES } from '../../src/provider/tool-check.js';
import { DEFAULTS } from '../../src/config/preferences.js';

const profile = defineProfile({
  name: 'fake',
  baseUrl: 'https://fake.invalid/v1',
  keyVar: 'FAKE_API_KEY', baseUrlVar: 'FAKE_BASE_URL', modelVar: 'FAKE_MODEL',
});

const timeoutMs = DEFAULTS.toolCheckTimeoutMs;

async function withProvider(t, fn) {
  const fake = await new FakeProvider().start();
  t.after(() => fake.stop());
  const client = new ProviderClient({
    profile, name: 'fake', key: 'k', baseUrl: fake.baseUrl, model: 'test-model', extraHeaders: {},
  });
  return fn(client, fake);
}

// A non-streaming completion carrying whatever tool call the test wants.
function completionWith(toolCalls, content = null) {
  return {
    id: 'c1', object: 'chat.completion', model: 'test-model',
    choices: [{
      index: 0,
      message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls ? 'tool_calls' : 'stop',
    }],
    usage: { prompt_tokens: 70, completion_tokens: 12, total_tokens: 82 },
  };
}

const goodCall = [{
  id: 'call_1', type: 'function',
  function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
}];

test('a model that calls the tool correctly passes', async (t) => {
  await withProvider(t, async (client, fake) => {
    fake.respond({ json: completionWith(goodCall) });
    const r = await checkToolCall(client, { timeoutMs });
    assert.equal(r.outcome, 'ok');
    assert.match(r.detail, /get_weather/);
    assert.equal(r.usage.total_tokens, 82, 'the cost is reported so doctor can total it');
  });
});

test('a model that answers without calling the tool fails, and says what it said instead', async (t) => {
  // The guardrail case: HTTP 200, a polite answer, and useless. "no tool call"
  // on its own would send the reader back to the provider to find out why.
  await withProvider(t, async (client, fake) => {
    fake.respond({ json: completionWith(null, 'I cannot help with that request.') });
    const r = await checkToolCall(client, { timeoutMs });
    assert.equal(r.outcome, 'noToolCall');
    assert.match(r.detail, /I cannot help with that request/);
  });
});

test('a model that answers with nothing at all still fails intelligibly', async (t) => {
  await withProvider(t, async (client, fake) => {
    fake.respond({ json: completionWith(null, '') });
    const r = await checkToolCall(client, { timeoutMs });
    assert.equal(r.outcome, 'noToolCall');
    assert.match(r.detail, /said nothing/);
  });
});

test('a tool call missing a required argument fails', async (t) => {
  // OpenRouter's free cohere/north-mini-code called get_weather({}) with `city`
  // required. Assembly was correct; the model was not, and a check that only
  // asked "was there a tool call" would have passed it.
  await withProvider(t, async (client, fake) => {
    fake.respond({ json: completionWith([{
      id: 'c', type: 'function', function: { name: 'get_weather', arguments: '{}' },
    }]) });
    const r = await checkToolCall(client, { timeoutMs });
    assert.equal(r.outcome, 'badArguments');
    assert.match(r.detail, /city/);
  });
});

test('a tool call with an out-of-enum argument fails', async (t) => {
  await withProvider(t, async (client, fake) => {
    fake.respond({ json: completionWith([{
      id: 'c', type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Paris","unit":"kelvin"}' },
    }]) });
    const r = await checkToolCall(client, { timeoutMs });
    assert.equal(r.outcome, 'badArguments');
    assert.match(r.detail, /unit/);
  });
});

test('arguments that are not JSON are reported as such, not as a missing field', async (t) => {
  // The assembler already separates "did not parse" from "parsed and does not
  // fit". Validating `args ?? {}` would have collapsed them and blamed `city`.
  await withProvider(t, async (client, fake) => {
    fake.respond({ json: completionWith([{
      id: 'c', type: 'function', function: { name: 'get_weather', arguments: '{"city":' },
    }]) });
    const r = await checkToolCall(client, { timeoutMs });
    assert.equal(r.outcome, 'badArguments');
    assert.match(r.detail, /not valid JSON/);
    assert.doesNotMatch(r.detail, /required/, 'must not blame a missing field for broken JSON');
  });
});

test('a 400 is reported as a refusal rather than a crash', async (t) => {
  // NVIDIA's content-safety model answers 400 when given `tools`. The check is
  // a diagnostic: every failure it can see is a result, never an exception.
  await withProvider(t, async (client, fake) => {
    fake.respond({ status: 400, json: { error: { message: 'tools not supported' } } });
    const r = await checkToolCall(client, { timeoutMs });
    assert.equal(r.outcome, 'refused');
    assert.match(r.detail, /400/);
  });
});

test('an unreachable provider is a result, not a thrown error', async (t) => {
  const fake = await new FakeProvider().start();
  const client = new ProviderClient({
    profile, name: 'fake', key: 'k', baseUrl: fake.baseUrl, model: 'm', extraHeaders: {},
  });
  await fake.stop();
  const r = await checkToolCall(client, { timeoutMs });
  assert.equal(r.outcome, 'failed');
});

test('a provider that never answers is given up on', async (t) => {
  // Two models in NVIDIA's catalogue returned nothing at 150 seconds. A
  // diagnostic that hangs is a bad diagnostic.
  await withProvider(t, async (client, fake) => {
    fake.respond({ hang: true });
    const r = await checkToolCall(client, { timeoutMs: 150 });
    assert.equal(r.outcome, 'failed');
    assert.match(r.detail, /no answer within 150 ms/);
  });
});

test('Ctrl-C is not recorded as a provider failure', async (t) => {
  // The user interrupting and the provider going quiet are different events and
  // an AbortError alone cannot tell them apart. Reporting an interrupt as
  // "nvidia FAIL" would be a lie about a provider.
  await withProvider(t, async (client, fake) => {
    fake.respond({ hang: true });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(() => checkToolCall(client, { signal: ac.signal, timeoutMs: 30_000 }));
  });
});

test('the check refuses to run without a timeout budget', async (t) => {
  // No inline fallback: the caller that forgets is the caller that hangs.
  await withProvider(t, async (client) => {
    await assert.rejects(() => checkToolCall(client), /timeoutMs/);
  });
});

test('the advertised tool is a schema the validator accepts', () => {
  // The check validates the model's arguments against this schema, so a schema
  // the project's own validator could not read would make every call "invalid".
  assert.equal(CHECK_TOOL.function.parameters.type, 'object');
  assert.deepEqual(CHECK_TOOL.function.parameters.required, ['city']);
});

test('every outcome the check can return has a sentence explaining it', () => {
  // doctor prints OUTCOMES[outcome]; one missing would print `undefined` at
  // exactly the moment someone needed to know what went wrong.
  const returned = ['ok', 'noToolCall', 'badArguments', 'refused', 'failed'];
  for (const o of returned) {
    assert.equal(typeof OUTCOMES[o], 'string', `${o} has no explanation`);
  }
  assert.deepEqual(Object.keys(OUTCOMES).sort(), [...returned].sort(),
    'OUTCOMES and the outcomes the code returns have drifted apart');
});
