import { defineProfile } from './generic.js';

// Measured 2026-09-12; see docs/providers.md. Chat, streaming and tool calls
// all work on gemini-3.8-flash, with the whole tool call in one delta.
//
// It publishes no rate-limit headers. And its usage accounting does not add up:
// prompt_tokens 8 + completion_tokens 0 against total_tokens 13, because
// thinking tokens are counted in the total and reported nowhere else.
// **total_tokens is the only figure to trust here.**
export default defineProfile({
  name: 'google',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  keyVar: 'GEMINI_API_KEY',
  baseUrlVar: 'GOOGLE_BASE_URL',
  modelVar: 'GEMINI_MODEL',
  verified: true,
  prefer: [
    /^models\/gemini-3\.8-flash$/,
    /^models\/gemini-3\.5-flash$/,
    /^models\/gemini-3\.5-flash-lite$/,
    /^models\/gemini-3\.\d+-flash$/,
  ],
});
