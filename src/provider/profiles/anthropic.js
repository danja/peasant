import { defineProfile } from './generic.js';

// UNVERIFIED for inference: no completion from this endpoint has been captured.
// The key available on 2026-09-15 had no credit balance, so `/v1/messages`
// could not be exercised at all -- only `/v1/models`, which is free. The
// messages dialect therefore remains unproven against the real service. See
// MAINTAINER.md.
//
// Anthropic's own API, with an ordinary API key.
//
// Distinct from claude-code.js, which reaches the same Messages endpoint by
// borrowing the OAuth token Claude Code stores on this machine. Same wire
// format, different credential and different money: this one bills per token to
// an account at console.anthropic.com and carries none of the terms problem the
// subscription route does.
//
// **Not free, and therefore never in the default rotation.** Every provider that
// auto-enables here has a free tier; this one charges for every token. It is
// tried only when named in PEASANT_PROVIDERS, like NVIDIA and Together.
//
// Measured 2026-09-15 against a live key:
//
//   - `GET /v1/models` answers 200 to **`Authorization: Bearer`** as readily as
//     to `x-api-key`, so peasant's bearer-only client needs no new auth scheme.
//     It answers 400 without `anthropic-version`, which the messages dialect
//     sends from `apiVersion` below.
//   - The catalogue publishes `max_input_tokens` and `max_tokens` per model.
//     `connect.js` reads the first as the context window; without it nothing
//     would ever trigger compaction here.
export default defineProfile({
  name: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  dialect: 'messages',
  apiVersion: '2023-06-01',

  keyVar: 'ANTHROPIC_API_KEY',
  baseUrlVar: 'ANTHROPIC_BASE_URL',
  modelVar: 'ANTHROPIC_MODEL',

  requiresKey: true,
  autoEnable: false,
  verified: false,

  // Measured 2026-09-15: an unpaid account is refused with **400**, not 402.
  //
  //   {"type":"error","error":{"type":"invalid_request_error",
  //    "message":"Your credit balance is too low to access the Anthropic API..."}}
  //
  // Classified by status alone that is `bad-request`, which is not retryable
  // anywhere -- so the router would stop the whole session on a billing problem
  // instead of moving to a provider that would answer. Narrow on purpose: it
  // matches the account's balance and nothing else, so a genuinely malformed
  // request still fails everywhere as it should.
  unavailableWhen: [/credit balance is too low/i],

  // No rate-limit headers are named here, and that is a measurement rather than
  // an omission. The only responses obtained on 2026-09-15 were `/v1/models`
  // (200) and `/v1/messages` (400, no credit), and **neither carried a single
  // `*-ratelimit-*` header**. Names taken from documentation would be exactly
  // the guess this project refuses: RateLimiter would watch for headers that may
  // not arrive and report a budget nobody measured. Until a paid response is
  // captured the budget is discovered from 429s alone, as it is for five of the
  // six hosted providers already here.

  // The catalogue as listed 2026-09-15 (11 entries), so this list is measured
  // rather than remembered -- four of six preference lists written from
  // documentation turned out to be wrong (docs/providers.md).
  //
  // Sonnet first, and deliberately not the most capable model available. This
  // is a harness that runs hundreds of small tool-calling turns and bills every
  // one of them; Fable 5.1 costs five times Sonnet's rate per token. Anyone who
  // wants the top of the range sets ANTHROPIC_MODEL and knows what they are
  // choosing.
  prefer: [
    /^claude-sonnet-5$/,
    /^claude-haiku-4-5/,
    /^claude-sonnet-4-6$/,
    /^claude-opus-5$/,
  ],
});
