import { defineProfile, NON_CHAT } from './generic.js';

// Measured 2026-09-15 against a live key; see docs/providers.md and
// docs/raw/2026-09-15_providers/. Before that date this profile was a guess
// from the OpenAI convention, and two of the guesses were wrong -- see the
// `prefer` and `unavailableWhen` notes below.
//
// NVIDIA gives free *credits* rather than a free tier, so it runs out. Worth
// having configured as a last resort rather than early in PEASANT_PROVIDERS.
export default defineProfile({
  name: 'nvidia',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  keyVar: 'NVIDIA_API_KEY',
  baseUrlVar: 'NVIDIA_BASE_URL',
  modelVar: 'NVIDIA_MODEL',
  verified: true,

  // autoEnable stays false. Credits run out, and a provider that works until it
  // abruptly does not belongs where someone chose to put it, not in everyone's
  // default rotation.
  autoEnable: false,

  // No `*-ratelimit-*` header appeared on any response, streamed or not. So
  // this names none and the budget is discovered from 429s alone, as it is for
  // most of the hosted providers. Copying header names out of documentation
  // would be exactly the guess this project refuses.
  rateLimit: {},

  // The catalogue lists 81 models and this account can call very few of them.
  // Four of the seven candidates tried answered 404 with
  //
  //   {"status":404,"title":"Not Found","detail":"Function '<uuid>':
  //    Not found for account '<id>'"}
  //
  // which is a statement about the account, not about our request -- the same
  // shape as Anthropic's credit-balance 400. classify() maps 404 to
  // `bad-request`, which is not retryable, so without this the router would
  // stop dead rather than rotate to a provider that would have answered.
  unavailableWhen: [/not found for account/i],

  // Anchored on the two models measured answering, best first. Not patterns:
  // the previous list had /llama-3\.[13]/i, which matched
  // `nvidia/llama-3.1-nemoguard-8b-content-safety` -- a safety classifier -- and
  // selected it as the chat model. A loose pattern over this catalogue is how
  // you end up talking to a guardrail.
  //
  //   openai/gpt-oss-20b                 2.9 s, tool args across 10 deltas
  //   nvidia/nemotron-3-super-120b-a12b  2.7 s, tool args whole in one delta
  //
  // Both honour stream_options.include_usage and both returned valid JSON
  // arguments. gpt-oss-20b is first for the same reason it is on Groq: it is
  // the smaller of the two and a harness makes hundreds of small turns.
  prefer: [/^openai\/gpt-oss-20b$/, /^nvidia\/nemotron-3-super-120b-a12b$/],

  // gpt-oss-20b streams delta.reasoning_content separately from delta.content,
  // as it does on Groq.
  reasoningFields: ['reasoning', 'reasoning_content'],

  // NVIDIA's catalogue is a model *zoo*, not a chat catalogue: guardrails,
  // reward models, document parsers, translators and a deepfake detector all
  // sit alongside the chat models under the same /v1/models listing. These keep
  // them out of the "set NVIDIA_MODEL to one of:" message, which is worthless
  // if two thirds of what it offers cannot hold a conversation.
  nonChat: [
    ...NON_CHAT,
    /guard/i,           // nemoguard, llama-guard-4, nemotron-safety-guard
    /safety/i,          // nemotron-3.5-content-safety
    /topic-control/i,
    /reward/i,          // nemotron-4-340b-reward
    /nemotron-parse/i,  // document parsing, not chat
    /riva-translate/i,
    /detector/i,        // ai-synthetic-video-detector
    /nvclip/i,
    /deplot/i,
  ],
});
