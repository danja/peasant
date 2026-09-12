import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, parseDuration, parseReset, parseRetryAfter } from '../../src/provider/RateLimiter.js';
import groq from '../../src/provider/profiles/groq.js';
import mistral from '../../src/provider/profiles/mistral.js';

// --- parsing Groq's duration strings --------------------------------------

test('parses the exact forms Groq returned', () => {
  // Both observed on 2026-09-12; see docs/raw/2026-09-12_providers/.
  assert.equal(parseDuration('644ms'), 644);
  assert.equal(parseDuration('1m26.4s'), 86_400);
});

test('parses the rest of the duration vocabulary', () => {
  assert.equal(parseDuration('0s'), 0);
  assert.equal(parseDuration('7.66s'), 7660);
  assert.equal(parseDuration('2m'), 120_000);
  assert.equal(parseDuration('1h2m3s'), 3_723_000);
  assert.equal(parseDuration('1d'), 86_400_000);
});

test('does not confuse m with ms', () => {
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('5ms'), 5);
});

test('refuses a string it only partly understands', () => {
  // The bug this pins: a regex that matches "1m" out of "1m26.4s" and silently
  // returns 60000 instead of 86400 -- a wait 26 seconds too short, every time.
  assert.throws(() => parseDuration('1m26.4'), /unexpected characters/);
  assert.throws(() => parseDuration('about a minute'), /cannot parse/);
  assert.throws(() => parseDuration('60'), /cannot parse/);
  assert.throws(() => parseDuration(''), /empty value/);
});

test('parseReset handles each declared format', () => {
  assert.equal(parseReset('644ms', 'duration'), 644);
  assert.equal(parseReset('30', 'seconds'), 30_000);
  // epoch 1_000_060 s is 60 s after a `now` of 1_000_000_000 ms.
  assert.equal(parseReset(String(1_000_000 + 60), 'epoch-seconds', 1_000_000_000), 60_000);
  assert.equal(parseReset(null, 'duration'), null);
  assert.equal(parseReset('', 'duration'), null);
});

test('parseRetryAfter accepts seconds and an HTTP date', () => {
  assert.equal(parseRetryAfter('12'), 12_000);
  const now = Date.parse('2026-09-12T12:00:00Z');
  assert.equal(parseRetryAfter('Sat, 12 Sep 2026 12:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('nonsense'), null);
});

// --- the limiter ----------------------------------------------------------

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t, advance(ms) { c.t += ms; } };
  return c;
}

// The exact headers Groq returned on 2026-09-12.
const GROQ_HEADERS = {
  'x-ratelimit-limit-requests': '1000',
  'x-ratelimit-limit-tokens': '8000',
  'x-ratelimit-remaining-requests': '999',
  'x-ratelimit-remaining-tokens': '7914',
  'x-ratelimit-reset-requests': '1m26.4s',
  'x-ratelimit-reset-tokens': '644ms',
};

// The exact headers Mistral returned on 2026-09-12.
const MISTRAL_HEADERS = {
  'x-ratelimit-limit-req-minute': '125',
  'x-ratelimit-limit-tokens-minute': '625000',
  'x-ratelimit-remaining-req-minute': '124',
  'x-ratelimit-remaining-tokens-minute': '624988',
  'x-ratelimit-tokens-query-cost': '12',
};

test('knows nothing before it has seen a response', () => {
  const rl = new RateLimiter(groq);
  assert.equal(rl.state.tokens.remaining, null, 'null means unknown, not empty');
  assert.equal(rl.headroom(), null, 'an unmeasured provider is not an exhausted one');
  assert.deepEqual(rl.check(5000), { allowed: true, waitMs: 0, reason: null });
});

test('reads the real Groq headers', () => {
  const c = clock();
  const rl = new RateLimiter(groq, { now: c.now });
  rl.observe(GROQ_HEADERS);
  const s = rl.state;
  assert.equal(s.tokens.limit, 8000);
  assert.equal(s.tokens.remaining, 7914);
  assert.equal(s.tokens.resetAt, c.t + 644, 'reset is a duration from now, not a timestamp');
  assert.equal(s.requests.resetAt, c.t + 86_400);
});

test('reads the real Mistral headers, including the query cost', () => {
  const c = clock();
  const rl = new RateLimiter(mistral, { now: c.now });
  rl.observe(MISTRAL_HEADERS);
  const s = rl.state;
  assert.equal(s.tokens.limit, 625_000);
  assert.equal(s.tokens.remaining, 624_988);
  assert.equal(s.lastQueryCost, 12);
  assert.equal(s.tokens.resetAt, c.t + 60_000, 'no reset header, so the window is inferred from the name');
});

test('a fetch Headers object works as well as a plain object', () => {
  const rl = new RateLimiter(groq);
  rl.observe(new Headers(GROQ_HEADERS));
  assert.equal(rl.state.tokens.remaining, 7914);
});

test('allows a request that fits', () => {
  const rl = new RateLimiter(groq);
  rl.observe(GROQ_HEADERS);
  assert.equal(rl.check(1000).allowed, true);
});

test('refuses a request that does not fit, and says how long to wait', () => {
  const c = clock();
  const rl = new RateLimiter(groq, { now: c.now });
  rl.observe({ ...GROQ_HEADERS, 'x-ratelimit-remaining-tokens': '100', 'x-ratelimit-reset-tokens': '30s' });
  const r = rl.check(5000);
  assert.equal(r.allowed, false);
  assert.equal(r.waitMs, 30_000);
  assert.match(r.reason, /100 tokens left, need 5000/);
});

test('waiting past the reset makes the request allowed again', () => {
  const c = clock();
  const rl = new RateLimiter(groq, { now: c.now });
  rl.observe({ ...GROQ_HEADERS, 'x-ratelimit-remaining-tokens': '10', 'x-ratelimit-reset-tokens': '5s' });
  assert.equal(rl.check(5000).allowed, false);
  c.advance(5001);
  assert.equal(rl.check(5000).allowed, true, 'the window has rolled');
});

test('a rolled window restores the budget but does not forget the limit', () => {
  // The bug this pins: an expired window made check() skip the limit
  // altogether, so a request larger than the provider's *whole* budget was
  // sent again and again. Groq reports `reset-tokens: 1ms` on the very
  // response that states the limit, so the window had almost always rolled by
  // the time anyone asked.
  const c = clock();
  const rl = new RateLimiter(groq, { now: c.now });
  rl.observe({ ...GROQ_HEADERS, 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '8000', 'x-ratelimit-reset-tokens': '1ms' });
  c.advance(50);

  const big = rl.check(13_266);
  assert.equal(big.allowed, false, 'it can never fit, whatever the window says');
  assert.equal(big.waitMs, Infinity);
  assert.match(big.reason, /the whole tokens limit is 8000/);

  assert.equal(rl.check(1000).allowed, true, 'and the restored budget is usable');
});

test('a request larger than the whole limit can never be allowed', () => {
  // Waiting does not help; the caller has to send less. Saying "wait 30s"
  // here would loop forever.
  const rl = new RateLimiter(groq);
  rl.observe(GROQ_HEADERS);
  const r = rl.check(20_000);
  assert.equal(r.allowed, false);
  assert.equal(r.waitMs, Infinity);
  assert.match(r.reason, /the whole tokens limit is 8000/);
});

test('a limit of zero is exhausted now, not impossible forever', () => {
  // Mistral returned x-ratelimit-limit-req-minute: 0 on 2026-09-12. Reading
  // that as "no request can ever fit" would drop the provider from the pool
  // permanently over what may be a momentary condition.
  const c = clock();
  const rl = new RateLimiter(mistral, { now: c.now });
  rl.observe({ 'x-ratelimit-limit-req-minute': '0', 'x-ratelimit-remaining-req-minute': '0' });
  const r = rl.check(10);
  assert.equal(r.allowed, false);
  assert.ok(Number.isFinite(r.waitMs), 'waiting must be able to help');
  c.advance(60_001);
  assert.equal(rl.check(10).allowed, true,
    'the window rolls, and a zero limit is a symptom rather than a fact to carry forward');
});

test('the request budget is checked too, not only tokens', () => {
  const c = clock();
  const rl = new RateLimiter(groq, { now: c.now });
  rl.observe({ ...GROQ_HEADERS, 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '10s' });
  const r = rl.check(1);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /0 requests left/);
});

test('a 429 blocks for retry-after and overrides the headers', () => {
  const c = clock();
  const rl = new RateLimiter(groq, { now: c.now });
  const wait = rl.note429({ ...GROQ_HEADERS, 'retry-after': '45' });
  assert.equal(wait, 45_000);
  const r = rl.check(1);
  assert.equal(r.allowed, false, 'plenty of tokens remaining, but a 429 is authoritative');
  assert.match(r.reason, /429/);
  c.advance(45_001);
  assert.equal(rl.check(1).allowed, true);
});

test('a 429 with no retry-after still backs off substantially', () => {
  // A tight retry loop against a free tier earns a longer cooldown.
  const rl = new RateLimiter(groq, { now: clock().now });
  assert.equal(rl.note429({}), 20_000);
});

test('headroom is a fraction, and unknown stays unknown', () => {
  const rl = new RateLimiter(groq);
  assert.equal(rl.headroom(), null);
  rl.observe(GROQ_HEADERS);
  assert.equal(Math.round(rl.headroom() * 1000) / 1000, 0.989);
});

test('headroom reports full once the window has rolled', () => {
  const c = clock();
  const rl = new RateLimiter(groq, { now: c.now });
  rl.observe({ ...GROQ_HEADERS, 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '1s' });
  assert.equal(rl.headroom(), 0);
  c.advance(1001);
  assert.equal(rl.headroom(), 1);
});

test('Mistral has vastly more headroom than Groq, as measured', () => {
  // The finding that reordered the provider list. If this ever inverts,
  // example.env's default order should be revisited.
  const g = new RateLimiter(groq); g.observe(GROQ_HEADERS);
  const m = new RateLimiter(mistral); m.observe(MISTRAL_HEADERS);
  assert.ok(m.state.tokens.limit / g.state.tokens.limit > 70,
    'Mistral was measured at 78x Groq token headroom');
});

test('headers the profile does not name are ignored', () => {
  // Mistral publishes no reset header. A Groq-shaped reset arriving on a
  // Mistral response must not be read: the profile is the only authority on
  // what a header name means here.
  const c = clock();
  const rl = new RateLimiter(mistral, { now: c.now });
  rl.observe({ ...MISTRAL_HEADERS, 'x-ratelimit-reset-tokens': '1m26.4s' });
  assert.equal(rl.state.tokens.resetAt, c.t + 60_000,
    'the window must come from impliedWindowMs, not from a header this profile does not name');
});
