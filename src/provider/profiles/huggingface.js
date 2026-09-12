import { defineProfile } from './generic.js';

// Measured 2026-09-12; see docs/providers.md. Chat, streaming and tool calls
// all work on Qwen3-Coder-30B, which streams tool calls **incrementally** (five
// deltas), like OpenRouter and unlike Groq, Mistral and Google.
//
// Getting there took two attempts, and the first failure is the finding worth
// keeping: --
//
//   422 UNSUPPORTED_OPENAI_PARAMS
//   "The following parameters are not supported for this model: tools,
//    tool_choice"
//
// That is the finding worth carrying: on a router fronting many upstreams,
// **tool support is a property of the model, not of the provider**, and the
// only way to know is to ask. A coding harness without tool calls is useless,
// so the preferences below name models that do support them.
//
// 138 models listed. `peasant doctor` should verify tool support per provider
// rather than assuming it -- see TODO.md.
export default defineProfile({
  name: 'huggingface',
  baseUrl: 'https://router.huggingface.co/v1',
  keyVar: 'HF_TOKEN',
  baseUrlVar: 'HF_BASE_URL',
  modelVar: 'HF_MODEL',
  verified: true,
  prefer: [
    /^Qwen\/Qwen3-Coder-30B-A3B-Instruct$/,
    /^Qwen\/Qwen3-Coder-480B-A35B-Instruct$/,
    /^moonshotai\/Kimi-K2-Instruct-0905$/,
    /^meta-llama\/Llama-3\.3-70B-Instruct$/,
  ],
});
