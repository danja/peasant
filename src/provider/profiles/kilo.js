import { defineProfile, NON_CHAT } from './generic.js';

// UNVERIFIED: no response from this endpoint has been captured or inspected.
// Written 2026-09-28 from Kilo's gateway documentation; api.kilo.ai was
// unreachable from the session that wrote it.
//
// Kilo's AI gateway, OpenAI-compatible. Its `:free` models need **no key at
// all**: anonymous requests are limited by IP to 200 an hour, four times what
// OpenRouter allows a day on its free models without a purchase. A key raises
// nothing for free models, so KILO_API_KEY is only for anyone who pays.
//
// The free pool changes often and overlaps OpenRouter's. Kilo's documentation
// warns that free requests may go to providers that log prompts and outputs,
// and NVIDIA's free endpoints carry NVIDIA's own "trial use only, logged"
// condition.
export default defineProfile({
  name: 'kilo',
  baseUrl: 'https://api.kilo.ai/api/gateway',
  keyVar: 'KILO_API_KEY',
  baseUrlVar: 'KILO_BASE_URL',
  modelVar: 'KILO_MODEL',

  // Anonymous is the free tier, not a degraded mode of it. The client sends no
  // Authorization header at all when the key is empty.
  requiresKey: false,

  verified: false,
  autoEnable: false,
  rateLimit: {},

  // Free models only, named: the catalogue is mostly paid models, and an
  // unanchored pattern would select one and answer 401 or 402 on first use.
  // Coding models first, as for OpenRouter, then the large general ones.
  prefer: [
    /^poolside\/laguna-s-2\.1:free$/,
    /^cohere\/north-mini-code:free$/,
    /^nvidia\/nemotron-3-super-120b-a12b:free$/,
    /^nvidia\/nemotron-3-ultra-550b-a55b:free$/,
  ],

  nonChat: [...NON_CHAT, /content-safety/, /-guard/],
});
