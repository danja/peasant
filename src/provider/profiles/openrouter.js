import { defineProfile, NON_CHAT } from './generic.js';

// Measured 2026-09-12; see docs/providers.md. 445 models, 19 carrying ":free".
//
// Two things worth knowing. It publishes **no rate-limit headers at all**, so
// the limiter has nothing to steer by and its budget is discovered only from
// 429s. And it is the one provider captured so far that streams tool calls
// *incrementally* -- id and name in the first delta with empty arguments, the
// arguments in a second -- which is the OpenAI shape rather than the
// whole-in-one-delta shape Groq and Mistral use.
export default defineProfile({
  name: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  keyVar: 'OPENROUTER_API_KEY',
  baseUrlVar: 'OPENROUTER_BASE_URL',
  modelVar: 'OPENROUTER_MODEL',
  verified: true,

  // OpenRouter attributes traffic by these; they are optional and affect
  // nothing but its public leaderboards, so they are sent only when set.
  headers: (env) => ({
    ...(env.OPENROUTER_SITE_URL ? { 'http-referer': env.OPENROUTER_SITE_URL } : {}),
    ...(env.OPENROUTER_SITE_NAME ? { 'x-title': env.OPENROUTER_SITE_NAME } : {}),
  }),

  // A bare /:free$/ is too loose: the 19 free models sort alphabetically and
  // the first is a vision-language model, which is a poor choice for a coding
  // harness. Named explicitly, coding models first, then large general ones.
  prefer: [
    /^cohere\/north-mini-code:free$/,
    /^poolside\/laguna-s-2\.1:free$/,
    /^nvidia\/nemotron-3-super-120b-a12b:free$/,
    /^nvidia\/nemotron-3-ultra-550b-a55b:free$/,
  ],

  // Safety classifiers are not chat models however they are labelled.
  nonChat: [...NON_CHAT, /content-safety/, /-guard/],
});
