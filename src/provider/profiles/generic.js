// The shape every provider profile takes, and the defaults an OpenAI-compatible
// endpoint gets when it says nothing more.
//
// A profile is data. It describes how one provider differs from the OpenAI
// shape; it does not contain logic, and nothing outside this directory may
// branch on a provider's name. When a provider needs behaviour rather than a
// value, that is a new field here -- so every provider gains it at once and the
// loop stays ignorant of who it is talking to.

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

  // Has a real response from this provider been captured and inspected?
  // tests/guard/profile-coverage.test.js requires a capture for any profile
  // claiming true, so this cannot drift into wishful thinking.
  verified: false,

  // Where the key goes. 'bearer' is Authorization: Bearer <key>.
  auth: 'bearer',

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
  if (!/^https:\/\//.test(p.baseUrl)) {
    throw new Error(`profile ${p.name}: baseUrl must be https, got ${p.baseUrl}`);
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
