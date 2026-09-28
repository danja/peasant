import { defineProfile } from './generic.js';

// UNVERIFIED: no response from this endpoint has been captured or inspected.
// Written 2026-09-28 from third-party write-ups and opencode's issue tracker,
// not measured. Nothing in docs/raw/ stands behind any of it.
//
// OpenCode Zen, the model gateway run by the OpenCode project. It is here for
// one model, `muse-spark-1.3-contributor-free`: free, 1M context, and free
// because the prompts and completions are handed over as training data. That
// is the price. Everything sent -- file contents included -- leaves under that
// arrangement, so it is off unless named in PEASANT_PROVIDERS.
//
// The "contributor-free" Muse models are reported to be Responses-only: the
// chat-completions path answers a bare HTTP 500 for them (anomalyco/opencode
// #45744, #47192). Hence `dialect: 'responses'`, which also means no
// catalogue is fetched -- that dialect has no models path -- so the one model
// is named below. A stale list here fails as a 404 on the first request; set
// OPENCODE_MODEL to override it.
export default defineProfile({
  name: 'opencode',
  baseUrl: 'https://opencode.ai/zen/v1',
  dialect: 'responses',

  keyVar: 'OPENCODE_API_KEY',
  baseUrlVar: 'OPENCODE_BASE_URL',
  modelVar: 'OPENCODE_MODEL',

  verified: false,
  autoEnable: false,

  // Rate-limit headers unknown until a response is captured; the limiter
  // learns from 429s alone until then.
  rateLimit: {},

  models: ['muse-spark-1.3-contributor-free'],
  prefer: [/^muse-spark-1\.3-contributor-free$/],
});
