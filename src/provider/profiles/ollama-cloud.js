import { defineProfile, NON_CHAT } from './generic.js';

// UNVERIFIED: no response from this endpoint has been captured or inspected.
// Written 2026-09-28 from third-party lists; ollama.com was unreachable from
// the session that wrote it. Nothing in docs/raw/ stands behind any of it.
//
// Ollama's hosted models: the large open-weight ones (DeepSeek V4, Kimi K3,
// Qwen 3.5 397B, gpt-oss 120b) run on Ollama's machines, reached over its
// OpenAI-compatible endpoint. Free with an account and no card, metered by
// session limits that reset every five hours and weekly ones that reset every
// seven days, neither published as a number.
//
// The same models are reachable through a *local* Ollama signed in with
// `ollama signin` -- pull a `:cloud` tag and the local server forwards it. That
// route goes through the `ollama` profile; this one needs no local server at
// all, which on a machine whose Ollama build is in question is the point.
export default defineProfile({
  name: 'ollama-cloud',
  baseUrl: 'https://ollama.com/v1',

  // Not OLLAMA_API_KEY: the local profile already reads that, for front-ends
  // that want one, and one variable meaning two keys is a leak waiting.
  keyVar: 'OLLAMA_CLOUD_API_KEY',
  baseUrlVar: 'OLLAMA_CLOUD_BASE_URL',
  modelVar: 'OLLAMA_CLOUD_MODEL',

  verified: false,
  autoEnable: false,

  // Limits are unpublished; the limiter learns from 429s.
  rateLimit: {},

  // Written from lists, not the catalogue, so anchored rather than loose: a
  // miss makes selectModel refuse and name what *is* listed, which is a one-line
  // fix. Coding and agentic models first.
  prefer: [/^deepseek-v4-flash\b/, /^kimi-k3\b/, /^qwen3\.5:397b\b/, /^gpt-oss:120b\b/, /^gpt-oss:20b\b/],

  nonChat: NON_CHAT,
});
