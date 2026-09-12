import { defineProfile, NON_CHAT } from './generic.js';

// Measured 2026-09-12; see docs/providers.md and
// docs/raw/2026-09-12_providers/. Every header name below was read off a
// response, not documentation -- the documentation says 6,000 tokens/minute and
// the account says 8,000.
export default defineProfile({
  name: 'groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  keyVar: 'GROQ_API_KEY',
  baseUrlVar: 'GROQ_BASE_URL',
  modelVar: 'GROQ_MODEL',
  verified: true,

  rateLimit: {
    limitTokens: 'x-ratelimit-limit-tokens',
    remainingTokens: 'x-ratelimit-remaining-tokens',
    resetTokens: 'x-ratelimit-reset-tokens',
    limitRequests: 'x-ratelimit-limit-requests',
    remainingRequests: 'x-ratelimit-remaining-requests',
    resetRequests: 'x-ratelimit-reset-requests',

    // "1m26.4s", "644ms" -- a duration string, not seconds and not a timestamp.
    resetFormat: 'duration',
  },

  // gpt-oss models stream delta.reasoning with channel:"analysis", separate
  // from delta.content. It is never assistant output, and it is most of the
  // completion: 22 of 24 tokens in the probe.
  reasoningFields: ['reasoning', 'reasoning_content'],

  // Catalogue as listed 2026-09-12 (14 entries). Kimi K2 and Qwen3-Coder are
  // not among them, whatever the 2026 write-ups say.
  prefer: [/^openai\/gpt-oss-20b$/, /^qwen\/qwen3\.\d+-27b$/, /^openai\/gpt-oss-120b$/],

  // groq/compound and groq/compound-mini appear to be agent wrappers with their
  // own tool loop, which would fight ours. Excluded until that is settled --
  // see TODO.md.
  nonChat: [...NON_CHAT, /^groq\/compound/],
});
