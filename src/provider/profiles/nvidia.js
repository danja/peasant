import { defineProfile } from './generic.js';

// UNVERIFIED. Probed 2026-09-12: GET /v1/models answers 200, but no completion
// has been inspected because there is no key here. Every field below other than
// the base URL is an assumption from the OpenAI convention.
//
// NVIDIA gives free *credits* rather than a free tier, so it runs out. Worth
// having configured as a last resort rather than early in PEASANT_PROVIDERS.
export default defineProfile({
  name: 'nvidia',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  keyVar: 'NVIDIA_API_KEY',
  baseUrlVar: 'NVIDIA_BASE_URL',
  modelVar: 'NVIDIA_MODEL',
  verified: false,
  autoEnable: false,
  prefer: [/qwen.*coder/i, /llama-3\.[13]/i, /nemotron/i],
});
