import { defineProfile } from './generic.js';

// UNVERIFIED: `peasant ask` answered through it on 2026-09-12 (see
// docs/providers.md, "Local models"), but no response was captured under
// docs/raw/, so the claim has nothing behind it that a test can check.
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

  // Ollama's OpenAI-compatible endpoint has no field for the context size, and
  // past it the server drops the *start* of the conversation without a word --
  // system prompt and tool schemas first. The default is 4,096 tokens on a
  // machine without a large GPU, which is about four turns here. The server
  // reads OLLAMA_CONTEXT_LENGTH at startup; setting the same variable here
  // tells the budget what that is, so compaction happens before truncation.
  contextWindowVar: 'OLLAMA_CONTEXT_LENGTH',
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
