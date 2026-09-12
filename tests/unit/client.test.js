import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatClient, ProviderError } from '../../src/provider/OpenAICompatClient.js';
import { defineProfile } from '../../src/provider/profiles/generic.js';
import groq from '../../src/provider/profiles/groq.js';
import { FakeProvider, textChunks, defaultCompletion } from './lib/FakeProvider.js';
import { readCapture } from './lib/fixtures.js';

const testProfile = defineProfile({
  name: 'fake',
  baseUrl: 'https://fake.invalid/v1',
  keyVar: 'FAKE_API_KEY', baseUrlVar: 'FAKE_BASE_URL', modelVar: 'FAKE_MODEL',
  rateLimit: {
    limitTokens: 'x-ratelimit-limit-tokens',
    remainingTokens: 'x-ratelimit-remaining-tokens',
    resetTokens: 'x-ratelimit-reset-tokens',
    resetFormat: 'duration',
  },
});

async function withProvider(t, fn, { profile = testProfile, model = 'test-model' } = {}) {
  const fake = await new FakeProvider().start();
  t.after(() => fake.stop());
  const client = new OpenAICompatClient({
    profile, name: profile.name, key: 'test-key',
    baseUrl: fake.baseUrl, model, extraHeaders: {},
  });
  return fn(client, fake);
}

const ask = { messages: [{ role: 'user', content: 'hi' }] };

// --- transport safety ------------------------------------------------------

test('refuses to send a key over plaintext to a remote host', () => {
  assert.throws(
    () => new OpenAICompatClient({ profile: testProfile, name: 'x', key: 'k', baseUrl: 'http://example.com/v1', extraHeaders: {} }),
    /refusing to send an API key over http/,
  );
});

test('allows plaintext to loopback, for a local model', () => {
  for (const host of ['127.0.0.1:11434', 'localhost:8080', '[::1]:8080']) {
    assert.doesNotThrow(() => new OpenAICompatClient({
      profile: testProfile, name: 'x', key: '', baseUrl: `http://${host}/v1`, extraHeaders: {},
    }));
  }
});

// --- request shape ---------------------------------------------------------

test('sends bearer auth and the configured model', async (t) => {
  await withProvider(t, async (client, fake) => {
    fake.respond({ json: defaultCompletion() });
    await client.complete(ask);
    assert.equal(fake.lastRequest.headers.authorization, 'Bearer test-key');
    assert.equal(fake.lastRequest.body.model, 'test-model');
  });
});

test('sends extra headers a profile supplies', async (t) => {
  const fake = await new FakeProvider().start();
  t.after(() => fake.stop());
  const client = new OpenAICompatClient({
    profile: testProfile, name: 'fake', key: 'k', baseUrl: fake.baseUrl,
    model: 'm', extraHeaders: { 'x-title': 'peasant' },
  });
  fake.respond({ json: defaultCompletion() });
  await client.complete(ask);
  assert.equal(fake.lastRequest.headers['x-title'], 'peasant');
});

test('refuses to send a request with no model rather than guessing one', async (t) => {
  await withProvider(t, async (client) => {
    await assert.rejects(() => client.complete(ask), /no model chosen. Set FAKE_MODEL/);
  }, { model: null });
});

test('requests usage with the stream, or the budgeter is blind', async (t) => {
  await withProvider(t, async (client, fake) => {
    fake.respond({ chunks: textChunks('hi') });
    for await (const _ of client.stream(ask)) { /* drain */ }
    assert.deepEqual(fake.lastRequest.body.stream_options, { include_usage: true });
  });
});

test('sends tools and tool_choice only when there are tools', async (t) => {
  await withProvider(t, async (client, fake) => {
    fake.respond({ json: defaultCompletion() });
    await client.complete(ask);
    assert.equal(fake.lastRequest.body.tools, undefined);
    assert.equal(fake.lastRequest.body.tool_choice, undefined);

    fake.respond({ json: defaultCompletion() });
    await client.complete({ ...ask, tools: [{ type: 'function', function: { name: 'f' } }] });
    assert.equal(fake.lastRequest.body.tools.length, 1);
    assert.equal(fake.lastRequest.body.tool_choice, 'auto');
  });
});

// --- responses -------------------------------------------------------------

test('completes without streaming', async (t) => {
  await withProvider(t, async (client, fake) => {
    fake.respond({ json: defaultCompletion('hello') });
    const r = await client.complete(ask);
    assert.equal(r.content, 'hello');
    assert.equal(r.finishReason, 'stop');
    assert.deepEqual(r.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  });
});

test('streams text and ends with a done event carrying the whole result', async (t) => {
  await withProvider(t, async (client, fake) => {
    fake.respond({ chunks: textChunks('hello', { usage: { total_tokens: 7 } }) });
    const events = [];
    for await (const ev of client.stream(ask)) events.push(ev);

    assert.equal(events.at(-1).type, 'done');
    assert.equal(events.at(-1).result.content, 'hello');
    assert.equal(events.at(-1).result.finishReason, 'stop');
    assert.equal(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'hello');
    assert.deepEqual(events.find((e) => e.type === 'usage').usage, { total_tokens: 7 });
  });
});

test('lists models', async (t) => {
  const fake = await new FakeProvider({ models: ['a', 'b'] }).start();
  t.after(() => fake.stop());
  const client = new OpenAICompatClient({
    profile: testProfile, name: 'fake', key: 'k', baseUrl: fake.baseUrl, model: 'a', extraHeaders: {},
  });
  assert.deepEqual(await client.listModels(), ['a', 'b']);
});

// --- the real captures, replayed ------------------------------------------

test('replays the captured Groq tool stream end to end', async (t) => {
  const fake = await new FakeProvider().start();
  t.after(() => fake.stop());
  const client = new OpenAICompatClient({
    profile: groq, name: 'groq', key: 'k', baseUrl: fake.baseUrl, model: 'm', extraHeaders: {},
  });
  fake.respond({ sse: readCapture('groq-tools.sse') });

  const events = [];
  for await (const ev of client.stream(ask)) events.push(ev);
  const { result } = events.at(-1);

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'get_weather');
  assert.equal(result.toolCalls[0].args.city, 'Paris');
  assert.equal(result.finishReason, 'tool_calls');
});

test('keeps Groq reasoning out of assistant content, but still counts it', async (t) => {
  // 22 of the 24 completion tokens in this capture were reasoning. Rendering
  // it would print the model's private working; ignoring its cost would make
  // the budgeter wrong by an order of magnitude.
  const fake = await new FakeProvider().start();
  t.after(() => fake.stop());
  const client = new OpenAICompatClient({
    profile: groq, name: 'groq', key: 'k', baseUrl: fake.baseUrl, model: 'm', extraHeaders: {},
  });
  fake.respond({ sse: readCapture('groq-tools.sse') });

  const events = [];
  for await (const ev of client.stream(ask)) events.push(ev);
  const { result } = events.at(-1);

  assert.ok(result.reasoning.length > 0, 'reasoning was captured');
  assert.ok(!result.content.includes(result.reasoning.slice(0, 20)), 'reasoning must not leak into content');
  assert.ok(events.some((e) => e.type === 'reasoning'), 'reasoning is reported as its own event type');
  assert.ok(result.usage.completion_tokens_details.reasoning_tokens > 0, 'reasoning tokens are visible to the budgeter');
});

test('replays the captured Mistral stream', async (t) => {
  const fake = await new FakeProvider().start();
  t.after(() => fake.stop());
  const client = new OpenAICompatClient({
    profile: testProfile, name: 'fake', key: 'k', baseUrl: fake.baseUrl, model: 'm', extraHeaders: {},
  });
  fake.respond({ sse: readCapture('mistral-stream.sse') });
  const events = [];
  for await (const ev of client.stream(ask)) events.push(ev);
  const { result } = events.at(-1);
  assert.ok(result.content.length > 0);
  assert.ok(result.usage.total_tokens > 0);
});

// --- errors and limits -----------------------------------------------------

test('a 429 raises a retryable error and blocks the limiter', async (t) => {
  await withProvider(t, async (client, fake) => {
    fake.respond({ status: 429, headers: { 'retry-after': '30' }, json: { error: { message: 'slow down' } } });
    const err = await client.complete(ask).catch((e) => e);
    assert.ok(err instanceof ProviderError);
    assert.equal(err.status, 429);
    assert.equal(err.retryable, true);
    assert.match(err.message, /retry in 30s/);
    assert.equal(client.limiter.check(1).allowed, false, 'the limiter must have learned from it');
  });
});

test('a 400 is not retryable -- it is our own fault', async (t) => {
  await withProvider(t, async (client, fake) => {
    fake.respond({ status: 400, json: { error: { message: 'bad model' } } });
    const err = await client.complete(ask).catch((e) => e);
    assert.equal(err.status, 400);
    assert.equal(err.kind, 'bad-request');
    assert.equal(err.retryable, false);
    assert.equal(err.permanent, false, 'the provider is fine; our request was not');
    assert.match(err.message, /bad model/, 'the provider\'s explanation must survive');
  });
});

test('a 402 means this provider will not serve us, not that the request is bad', async (t) => {
  // Cerebras returned 402 with an empty body on 2026-09-12. Treating it as a
  // bad request would take the whole session down over one account's billing.
  await withProvider(t, async (client, fake) => {
    fake.respond({ status: 402, json: {} });
    const err = await client.complete(ask).catch((e) => e);
    assert.equal(err.kind, 'provider-unavailable');
    assert.equal(err.retryable, true, 'another provider is very likely to answer');
    assert.equal(err.permanent, true, 'but this one will not, for the rest of the session');
  });
});

test('401 and 403 are classified the same way', async (t) => {
  await withProvider(t, async (client, fake) => {
    for (const status of [401, 403]) {
      fake.respond({ status, json: { error: { message: 'nope' } } });
      const err = await client.complete(ask).catch((e) => e);
      assert.equal(err.kind, 'provider-unavailable', `HTTP ${status}`);
    }
  });
});

test('a 500 is retryable', async (t) => {
  await withProvider(t, async (client, fake) => {
    fake.respond({ status: 503, json: { error: { message: 'overloaded' } } });
    const err = await client.complete(ask).catch((e) => e);
    assert.equal(err.kind, 'server-error');
    assert.equal(err.retryable, true);
    assert.equal(err.permanent, false);
  });
});

test('rate-limit headers are absorbed from a successful response', async (t) => {
  await withProvider(t, async (client, fake) => {
    fake.respond({
      headers: {
        'x-ratelimit-limit-tokens': '8000',
        'x-ratelimit-remaining-tokens': '20',
        'x-ratelimit-reset-tokens': '15s',
      },
      json: defaultCompletion(),
    });
    await client.complete(ask);
    const r = client.limiter.check(5000);
    assert.equal(r.allowed, false);
    // Real time passes between observing and checking, so this is a range.
    assert.ok(r.waitMs > 14_000 && r.waitMs <= 15_000, `waitMs was ${r.waitMs}`);
  });
});

test('an abort stops the stream and propagates', async (t) => {
  await withProvider(t, async (client, fake) => {
    fake.respond({ chunks: textChunks('a'.repeat(400)), chunkSize: 2 });
    const ac = new AbortController();
    const seen = [];
    await assert.rejects(async () => {
      for await (const ev of client.stream({ ...ask, signal: ac.signal })) {
        seen.push(ev);
        if (seen.length === 3) ac.abort();
      }
    }, (e) => e.name === 'AbortError');
    assert.ok(seen.length >= 3, 'it streamed before being stopped');
  });
});

test('a network failure is retryable, not a crash', async (t) => {
  const client = new OpenAICompatClient(
    { profile: testProfile, name: 'fake', key: 'k', baseUrl: 'https://fake.invalid/v1', model: 'm', extraHeaders: {} },
    { fetch: () => Promise.reject(new TypeError('fetch failed')) },
  );
  const err = await client.complete(ask).catch((e) => e);
  assert.ok(err instanceof ProviderError);
  assert.equal(err.retryable, true);
  assert.match(err.message, /request failed: fetch failed/);
});
