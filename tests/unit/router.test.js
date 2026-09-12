import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router, NoProviderError } from '../../src/provider/Router.js';
import { OpenAICompatClient, ProviderError } from '../../src/provider/OpenAICompatClient.js';
import { defineProfile } from '../../src/provider/profiles/generic.js';
import { FakeProvider, textChunks, defaultCompletion } from './lib/FakeProvider.js';

const profileFor = (name) => defineProfile({
  name,
  baseUrl: 'https://x.invalid/v1',
  keyVar: `${name.toUpperCase()}_API_KEY`,
  baseUrlVar: `${name.toUpperCase()}_BASE_URL`,
  modelVar: `${name.toUpperCase()}_MODEL`,
  rateLimit: {
    limitTokens: 'x-ratelimit-limit-tokens',
    remainingTokens: 'x-ratelimit-remaining-tokens',
    resetTokens: 'x-ratelimit-reset-tokens',
    resetFormat: 'duration',
  },
});

async function providerPair(t) {
  const a = await new FakeProvider().start();
  const b = await new FakeProvider().start();
  t.after(() => Promise.all([a.stop(), b.stop()]));
  const mk = (name, fake) => new OpenAICompatClient({
    profile: profileFor(name), name, key: 'k', baseUrl: fake.baseUrl, model: 'm', extraHeaders: {},
  });
  return { a, b, clientA: mk('alpha', a), clientB: mk('beta', b) };
}

const ask = { messages: [{ role: 'user', content: 'hi' }] };
const noSleep = async () => {};

test('refuses to exist with no usable providers, and says what to do', () => {
  assert.throws(() => new Router([]), /Set at least one API key -- see example\.env/);
});

test('uses the first provider when it can serve', async (t) => {
  const { a, b, clientA, clientB } = await providerPair(t);
  a.respond({ json: defaultCompletion('from alpha') });
  const r = await new Router([clientA, clientB], { sleep: noSleep }).complete(ask);
  assert.equal(r.content, 'from alpha');
  assert.equal(b.requests.length, 0, 'the second provider must not be touched');
});

test('rotates to the next provider on a 429', async (t) => {
  const { a, b, clientA, clientB } = await providerPair(t);
  a.respond({ status: 429, headers: { 'retry-after': '600' }, json: { error: { message: 'slow down' } } });
  b.respond({ json: defaultCompletion('from beta') });
  const r = await new Router([clientA, clientB], { sleep: noSleep }).complete(ask);
  assert.equal(r.content, 'from beta');
});

test('rotates on a 5xx', async (t) => {
  const { a, b, clientA, clientB } = await providerPair(t);
  a.respond({ status: 503, json: { error: { message: 'overloaded' } } });
  b.respond({ json: defaultCompletion('from beta') });
  assert.equal((await new Router([clientA, clientB], { sleep: noSleep }).complete(ask)).content, 'from beta');
});

test('does not rotate on a 400 -- another provider would say the same', async (t) => {
  const { b, a, clientA, clientB } = await providerPair(t);
  a.respond({ status: 400, json: { error: { message: 'bad request' } } });
  const err = await new Router([clientA, clientB], { sleep: noSleep }).complete(ask).catch((e) => e);
  assert.ok(err instanceof ProviderError);
  assert.equal(err.status, 400);
  assert.equal(b.requests.length, 0, 'retrying our own mistake elsewhere just wastes quota');
});

test('reports every attempt when all providers fail', async (t) => {
  const { a, b, clientA, clientB } = await providerPair(t);
  a.respond({ status: 503, json: { error: { message: 'alpha down' } } });
  b.respond({ status: 503, json: { error: { message: 'beta down' } } });
  const err = await new Router([clientA, clientB], { sleep: noSleep }).complete(ask).catch((e) => e);
  assert.ok(err instanceof NoProviderError);
  assert.equal(err.attempts.length, 2);
  assert.match(err.message, /alpha down/);
  assert.match(err.message, /beta down/);
});

test('prefers a free provider over waiting for the preferred one', async (t) => {
  const { a, b, clientA, clientB } = await providerPair(t);
  // alpha has almost nothing left, and a long wait; beta is untouched.
  clientA.limiter.observe({
    'x-ratelimit-limit-tokens': '8000',
    'x-ratelimit-remaining-tokens': '5',
    'x-ratelimit-reset-tokens': '55s',
  });
  b.respond({ json: defaultCompletion('from beta') });
  const r = await new Router([clientA, clientB], { maxWaitMs: 5000, sleep: noSleep }).complete(ask, { estimatedTokens: 3000 });
  assert.equal(r.content, 'from beta');
  assert.equal(a.requests.length, 0, 'alpha was never asked');
});

test('waits for the preferred provider when the wait is short', async (t) => {
  const { a, clientA, clientB } = await providerPair(t);
  clientA.limiter.observe({
    'x-ratelimit-limit-tokens': '8000',
    'x-ratelimit-remaining-tokens': '5',
    'x-ratelimit-reset-tokens': '1s',
  });
  a.respond({ json: defaultCompletion('from alpha') });
  let slept = 0;
  const router = new Router([clientA, clientB], { maxWaitMs: 5000, sleep: async (ms) => { slept += ms; } });
  const r = await router.complete(ask, { estimatedTokens: 3000 });
  assert.equal(r.content, 'from alpha');
  assert.ok(slept > 0 && slept <= 1000, `slept ${slept}ms`);
});

test('refuses when the request can never fit anywhere, rather than waiting forever', async (t) => {
  const { clientA, clientB } = await providerPair(t);
  for (const c of [clientA, clientB]) {
    c.limiter.observe({
      'x-ratelimit-limit-tokens': '8000',
      'x-ratelimit-remaining-tokens': '8000',
      'x-ratelimit-reset-tokens': '1s',
    });
  }
  const err = await new Router([clientA, clientB], { sleep: noSleep })
    .complete(ask, { estimatedTokens: 50_000 }).catch((e) => e);
  assert.ok(err instanceof NoProviderError);
  assert.match(err.message, /no provider can serve a request of about 50000 tokens/);
  assert.match(err.message, /the whole tokens limit is 8000/);
});

test('plan reports what each provider would do', async (t) => {
  const { clientA, clientB } = await providerPair(t);
  clientA.limiter.observe({
    'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '10', 'x-ratelimit-reset-tokens': '30s',
  });
  const plan = new Router([clientA, clientB]).plan(5000);
  assert.deepEqual(plan.map((p) => p.name), ['alpha', 'beta']);
  assert.equal(plan[0].allowed, false);
  assert.equal(plan[1].allowed, true);
  assert.equal(plan[1].headroom, null, 'beta has told us nothing yet, which is not the same as empty');
});

test('rotates past a provider that will not serve us, and stops asking it', async (t) => {
  const { a, b, clientA, clientB } = await providerPair(t);
  a.respond({ status: 402, json: {} });
  b.respond({ json: defaultCompletion('from beta') });
  const router = new Router([clientA, clientB], { sleep: noSleep });

  assert.equal((await router.complete(ask)).content, 'from beta');
  assert.ok(router.retired.has('alpha'), 'a billing failure will not fix itself in a second');

  // The second request must not pay the latency of alpha refusing again.
  b.respond({ json: defaultCompletion('beta again') });
  assert.equal((await router.complete(ask)).content, 'beta again');
  assert.equal(a.requests.length, 1, 'alpha was asked once, not twice');
});

test('a retired provider does not count against the pool being empty', async (t) => {
  const { a, clientA } = await providerPair(t);
  a.respond({ status: 402, json: {} });
  const router = new Router([clientA], { sleep: noSleep });
  await router.complete(ask).catch(() => {});
  const err = await router.complete(ask).catch((e) => e);
  assert.ok(err instanceof NoProviderError, 'with everyone retired there is nobody left');
});

// --- rotation, on and off --------------------------------------------------

test('rotation off pins every request to the first provider and waits', async (t) => {
  const { a, b, clientA, clientB } = await providerPair(t);
  clientA.limiter.observe({
    'x-ratelimit-limit-tokens': '8000',
    'x-ratelimit-remaining-tokens': '5',
    'x-ratelimit-reset-tokens': '90s',
  });
  a.respond({ json: defaultCompletion('from alpha') });

  let slept = 0;
  const router = new Router([clientA, clientB], { rotate: false, sleep: async (ms) => { slept += ms; } });
  const r = await router.complete(ask, { estimatedTokens: 3000 });

  assert.equal(r.content, 'from alpha', 'pinned to the preferred provider');
  assert.equal(b.requests.length, 0, 'beta was free, and deliberately not used');
  assert.ok(slept >= 89_000, `waited for the window instead of rotating (slept ${slept}ms)`);
});

test('rotation off still surfaces a failure rather than pretending', async (t) => {
  // Pinning means "do not prefer someone else", not "ignore errors".
  const { a, b, clientA, clientB } = await providerPair(t);
  a.respond({ status: 503, json: { error: { message: 'alpha down' } } });
  const router = new Router([clientA, clientB], { rotate: false, sleep: noSleep });
  const err = await router.complete(ask).catch((e) => e);
  assert.ok(err instanceof NoProviderError);
  assert.match(err.message, /alpha down/);
  assert.equal(b.requests.length, 0);
});

test('rotation on is the default', async (t) => {
  const { a, b, clientA, clientB } = await providerPair(t);
  a.respond({ status: 429, headers: { 'retry-after': '600' }, json: {} });
  b.respond({ json: defaultCompletion('from beta') });
  const r = await new Router([clientA, clientB], { sleep: noSleep }).complete(ask);
  assert.equal(r.content, 'from beta');
});

// --- streaming -------------------------------------------------------------

test('announces which provider answered, before any content', async (t) => {
  const { a, clientA, clientB } = await providerPair(t);
  a.respond({ chunks: textChunks('hi') });
  const events = [];
  for await (const ev of new Router([clientA, clientB], { sleep: noSleep }).stream(ask)) events.push(ev);
  assert.deepEqual(events[0], { type: 'provider', name: 'alpha' });
  assert.equal(events.at(-1).result.content, 'hi');
});

test('rotates a stream that fails before the first token', async (t) => {
  const { a, b, clientA, clientB } = await providerPair(t);
  a.respond({ status: 429, headers: { 'retry-after': '600' }, json: { error: { message: 'slow down' } } });
  b.respond({ chunks: textChunks('from beta') });
  const events = [];
  for await (const ev of new Router([clientA, clientB], { sleep: noSleep }).stream(ask)) events.push(ev);
  assert.equal(events[0].name, 'beta');
  assert.equal(events.at(-1).result.content, 'from beta');
});

test('does not rotate once a stream has produced output', async (t) => {
  // The user has already seen tokens. Restarting elsewhere would duplicate or
  // contradict what is on screen, which is worse than an error.
  const { a, b, clientA, clientB } = await providerPair(t);
  a.respond({ sse: 'data: {"choices":[{"delta":{"content":"par"}}]}\n\ndata: {oh dear\n\n', status: 200 });
  b.respond({ chunks: textChunks('whole') });

  const events = [];
  for await (const ev of new Router([clientA, clientB], { sleep: noSleep }).stream(ask)) events.push(ev);
  // Malformed mid-stream JSON is skipped rather than fatal, so this completes
  // on alpha with partial content -- and beta is never consulted.
  assert.equal(events[0].name, 'alpha');
  assert.equal(events.at(-1).result.content, 'par');
  assert.equal(b.requests.length, 0);
});

test('an abort propagates rather than rotating', async (t) => {
  const { a, b, clientA, clientB } = await providerPair(t);
  a.respond({ chunks: textChunks('a'.repeat(300)), chunkSize: 2 });
  const ac = new AbortController();
  let n = 0;
  await assert.rejects(async () => {
    for await (const _ of new Router([clientA, clientB], { sleep: noSleep }).stream({ ...ask, signal: ac.signal })) {
      if (++n === 3) ac.abort();
    }
  }, (e) => e.name === 'AbortError');
  assert.equal(b.requests.length, 0, 'a deliberate stop is not a provider failure');
});
