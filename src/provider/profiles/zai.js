import { defineProfile, NON_CHAT } from './generic.js';

// UNVERIFIED: no response from this endpoint has been captured or inspected.
// Written 2026-09-28 from third-party write-ups; api.z.ai was unreachable
// from the session that wrote it.
//
// Z.ai (Zhipu), the makers of GLM, on its international endpoint. GLM-4.7-Flash
// is free outright rather than trial credit: 200K context, streamed tool calls,
// no card. The limit is **one request at a time** (and reportedly one every
// three seconds) rather than a token budget -- a poor fit for anything
// parallel and a good one for a harness that makes one call per turn.
//
// Whether GET /models is served here is not known. If connecting fails at
// "listing models", set ZAI_MODEL=glm-4.7-flash and the catalogue is skipped.
export default defineProfile({
  name: 'zai',
  baseUrl: 'https://api.z.ai/api/paas/v4',
  keyVar: 'ZAI_API_KEY',
  baseUrlVar: 'ZAI_BASE_URL',
  modelVar: 'ZAI_MODEL',

  verified: false,
  autoEnable: false,
  rateLimit: {},

  // Only the free models. Every other GLM here is billed.
  prefer: [/^glm-4\.7-flash$/, /^glm-4\.5-flash$/],

  // GLM reasoning models stream their thinking as reasoning_content.
  reasoningFields: ['reasoning', 'reasoning_content'],

  nonChat: NON_CHAT,
});
