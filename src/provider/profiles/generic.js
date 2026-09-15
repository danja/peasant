// The shape every provider profile takes, and the defaults an OpenAI-compatible
// endpoint gets when it says nothing more.
//
// A profile is data. It describes how one provider differs from the OpenAI
// shape; it does not contain logic, and nothing outside this directory may
// branch on a provider's name. When a provider needs behaviour rather than a
// value, that is a new field here -- so every provider gains it at once and the
// loop stays ignorant of who it is talking to.

import { DEFAULT_DIALECT, byName as dialectByName } from '../dialects/index.js';

// Model ids that are not chat models. Groq lists whisper and prompt-guard
// entries, Mistral lists embedding, OCR and audio models; selecting one produces
// a confusing failure several layers away from the cause.
export const NON_CHAT = [
  /embed/i, /\bocr\b/i, /voxtral/i, /whisper/i, /orpheus/i,
  /moderation/i, /prompt-guard/i, /\btts\b/i, /transcribe/i, /rerank/i,
];

export const GENERIC = {
  name: 'generic',

  // Set by a concrete profile.
  baseUrl: null,
  keyVar: null,
  baseUrlVar: null,
  modelVar: null,

  // A local server has no account and no key. Its keyVar still exists, because
  // some local front-ends accept one, but an empty value is not a reason to
  // consider the provider unusable.
  requiresKey: true,

  // Whether to include this provider when PEASANT_PROVIDERS is unset. Local
  // servers are off by default: probing a port nobody is listening on costs a
  // connection refusal on every start, for a provider most people do not run.
  autoEnable: true,

  // Has a real response from this provider been captured and inspected?
  // tests/guard/profile-coverage.test.js requires a capture for any profile
  // claiming true, so this cannot drift into wishful thinking.
  verified: false,

  // Where the key goes. 'bearer' is Authorization: Bearer <key>.
  auth: 'bearer',

  // Which wire format this endpoint speaks. Named after the format rather than
  // the vendor, because more than one provider speaks each: see dialects/.
  dialect: DEFAULT_DIALECT,

  // The format's version, where it has one and sends it as a header. null for
  // the formats that do not.
  apiVersion: null,

  // A catalogue for an endpoint that publishes none, which is the only reason
  // to set it. Worse than asking the provider -- a hardcoded list goes stale
  // silently -- so it stays empty for everyone that can be asked.
  models: [],

  // Where a credential comes from when it is not an API key in the
  // environment: another tool's login, already on this machine. Data, so that
  // reading it stays one implementation in Credentials.js. See claude-code.js.
  credentialFile: null,

  // Extra headers, as a function of config so a profile can read env values.
  headers: () => ({}),

  // Rate-limit header names. Every one is optional: a provider that publishes
  // nothing leaves the limiter to infer from 429s alone.
  rateLimit: {
    limitTokens: null,
    remainingTokens: null,
    resetTokens: null,
    limitRequests: null,
    remainingRequests: null,
    resetRequests: null,
    queryCost: null,

    // How a reset value is written: 'duration' ("1m26.4s", "644ms"),
    // 'seconds', 'epoch-seconds', or null when there is no reset header.
    resetFormat: null,

    // Window length in ms when the provider states no reset and the window is
    // implied by the header name. null means "derive it from resetFormat".
    impliedWindowMs: null,
  },

  // Does the provider honour stream_options.include_usage? Without it a
  // streamed response reports no token count and the budgeter is blind.
  includeUsage: true,

  // Fields in a streaming delta that carry the model's private reasoning. They
  // cost tokens and must never be rendered as assistant content.
  reasoningFields: ['reasoning', 'reasoning_content'],

  // Ordered preferences for picking a default model from /models.
  prefer: [],

  nonChat: NON_CHAT,
};

const REQUIRED = ['name', 'baseUrl', 'keyVar', 'baseUrlVar', 'modelVar'];

export function defineProfile(profile) {
  // Required fields are checked against the *input*, before the defaults are
  // merged in. Checking afterwards would let a profile with no name inherit
  // GENERIC's, quietly registering itself as "generic" -- which is worse than
  // failing, because it looks like it worked.
  for (const field of REQUIRED) {
    if (!profile[field]) {
      throw new Error(`profile ${profile.name ?? '?'}: ${field} is required`);
    }
  }

  const merged = {
    ...GENERIC,
    ...profile,
    rateLimit: { ...GENERIC.rateLimit, ...(profile.rateLimit ?? {}) },
  };
  validate(merged);
  return Object.freeze(merged);
}

// No inline fallbacks: a profile missing something structural is a bug to fix
// here, not a runtime surprise at the first request.
function validate(p) {
  // Throws on an unknown name, which is the point: a typo here would otherwise
  // surface as a request sent in the wrong format.
  dialectByName(p.dialect);

  // https everywhere, except a loopback address -- a local model server has no
  // TLS and needs none, because the key never leaves the machine.
  if (!/^https:\/\//.test(p.baseUrl)) {
    const loopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(p.baseUrl);
    if (!loopback) throw new Error(`profile ${p.name}: baseUrl must be https unless it is loopback, got ${p.baseUrl}`);
    if (p.requiresKey) {
      throw new Error(`profile ${p.name}: a plaintext loopback provider must set requiresKey: false`);
    }
  }
  if (p.baseUrl.endsWith('/')) {
    throw new Error(`profile ${p.name}: baseUrl must not end in a slash (paths are appended)`);
  }
  const rl = p.rateLimit;
  const hasReset = rl.resetTokens || rl.resetRequests;
  if (hasReset && !rl.resetFormat) {
    throw new Error(`profile ${p.name}: names a reset header but no resetFormat`);
  }
  if (!hasReset && rl.limitTokens && !rl.impliedWindowMs) {
    throw new Error(
      `profile ${p.name}: publishes a token limit but no reset header, so impliedWindowMs is required -- ` +
      'the limiter cannot guess when the window rolls',
    );
  }
  if (rl.resetFormat && !['duration', 'seconds', 'epoch-seconds'].includes(rl.resetFormat)) {
    throw new Error(`profile ${p.name}: unknown resetFormat ${rl.resetFormat}`);
  }
}
