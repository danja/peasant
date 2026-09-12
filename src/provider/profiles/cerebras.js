import { defineProfile } from './generic.js';

// UNVERIFIED, with a key. Probed 2026-09-12: /models answers 200 and lists
// three chat models, but /chat/completions returns **402 Payment Required**
// with an empty body and no headers -- so no completion has ever been seen and
// there is nothing to base a dialect on. It also publishes no rate-limit
// headers on any response.
//
// The account needs attention before this provider can be used at all; see
// docs/danja-todo.md. Re-run `node bin/probe-providers.js` afterwards, and this
// becomes verified only once there is an SSE capture behind it --
// tests/guard/profile-coverage.test.js enforces that.
export default defineProfile({
  name: 'cerebras',
  baseUrl: 'https://api.cerebras.ai/v1',
  keyVar: 'CEREBRAS_API_KEY',
  baseUrlVar: 'CEREBRAS_BASE_URL',
  modelVar: 'CEREBRAS_MODEL',
  verified: false,
  // Catalogue as listed 2026-09-12: qwen-3.8-27b, gpt-oss-120b, gemma-4-31b.
  // The earlier list here was written from documentation and matched none of
  // them -- selectModel refused rather than guessing, which is the point.
  prefer: [/^qwen-3\.\d+-27b$/, /^gpt-oss-120b$/, /^gemma-/],
});
