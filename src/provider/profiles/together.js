import { defineProfile } from './generic.js';

// UNVERIFIED. Probed 2026-09-12: GET /v1/models answers 401, so the endpoint is
// live and wants a Bearer key, but nothing beyond that has been seen.
//
// A handful of free endpoints alongside a paid catalogue, so the preference
// list names the free ones. Off unless asked for, since most of what it offers
// is not free.
export default defineProfile({
  name: 'together',
  baseUrl: 'https://api.together.xyz/v1',
  keyVar: 'TOGETHER_API_KEY',
  baseUrlVar: 'TOGETHER_BASE_URL',
  modelVar: 'TOGETHER_MODEL',
  verified: false,
  autoEnable: false,
  prefer: [/free/i, /qwen.*coder/i, /llama-3\.[13]/i],
});
