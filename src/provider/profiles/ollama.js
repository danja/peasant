import { defineProfile } from './generic.js';

// UNVERIFIED: no local server has been probed from here, so no completion
// from it has been inspected.
//
// A local Ollama server. No key, no quota, no network, and no rate limit to
// discover -- the only provider here that cannot refuse you.
//
// Off unless named in PEASANT_PROVIDERS: probing a port nobody is listening on
// costs a connection refusal on every start.
//
// It will be slow on an Athlon II. That is a trade the user makes knowingly,
// and it is the only option that works with no network at all.
export default defineProfile({
  name: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  keyVar: 'OLLAMA_API_KEY',
  baseUrlVar: 'OLLAMA_BASE_URL',
  modelVar: 'OLLAMA_MODEL',
  requiresKey: false,
  autoEnable: false,
  verified: false,

  // Unlike a hosted catalogue, this list is whatever the user has pulled: small,
  // curated, and theirs. So a final catch-all is reasonable here where it would
  // be reckless on Groq -- the worst case is their own single model, not an
  // Arabic text-to-speech model chosen alphabetically. Embeddings are still
  // filtered out by NON_CHAT.
  prefer: [/coder/i, /qwen/i, /llama/i, /mistral/i, /devstral/i, /./],
});
