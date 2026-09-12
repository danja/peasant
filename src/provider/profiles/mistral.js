import { defineProfile } from './generic.js';

// Measured 2026-09-12; see docs/providers.md. 625,000 tokens/minute -- 78x
// Groq's headroom, and nothing like the "roughly 1 req/s" the write-ups give.
export default defineProfile({
  name: 'mistral',
  baseUrl: 'https://api.mistral.ai/v1',
  keyVar: 'MISTRAL_API_KEY',
  baseUrlVar: 'MISTRAL_BASE_URL',
  modelVar: 'MISTRAL_MODEL',
  verified: true,

  rateLimit: {
    limitTokens: 'x-ratelimit-limit-tokens-minute',
    remainingTokens: 'x-ratelimit-remaining-tokens-minute',
    limitRequests: 'x-ratelimit-limit-req-minute',
    remainingRequests: 'x-ratelimit-remaining-req-minute',
    queryCost: 'x-ratelimit-tokens-query-cost',

    // Mistral publishes no reset header at all. The window is stated only in
    // the header *name*, so the limiter has to infer it -- which is why this
    // budget is held more conservatively than Groq's despite being far larger.
    resetFormat: null,
    impliedWindowMs: 60_000,
  },

  // mistral-vibe-cli-with-tools and mistral-code-latest look purpose-built for
  // this job; not yet evaluated against each other, see TODO.md.
  prefer: [
    /^mistral-vibe-cli-with-tools$/,
    /^mistral-code-latest$/,
    /^codestral-latest$/,
    /^mistral-small-latest$/,
  ],
});
