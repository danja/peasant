// Every tunable constant, in one place, each with the reason it has the value
// it has. Nothing in src/ may hardcode one of these.
//
// Note what is *not* here: rate limits and context windows. Those are never
// constants at all -- they are read from `x-ratelimit-*` response headers and
// the model catalogue, because every published figure for these free tiers
// turned out to be wrong (docs/providers.md). RateLimiter holds no limit values
// of its own and a profile holds only header *names*, so a hardcoded limit has
// nowhere to live rather than merely being discouraged.

export const DEFAULTS = Object.freeze({
  // Rotate to another provider when the preferred one is blocked?
  //
  // On by default, and it is most of the value of using free tiers: Groq allows
  // 8,000 tokens a minute and Mistral 625,000, so the difference between
  // stalling and not is usually just asking someone else. Turn it off to pin
  // every request to the first provider in PEASANT_PROVIDERS and wait however
  // long that takes -- useful when comparing models, or when one provider's
  // output is the only one you trust for a task.
  rotate: true,

  // How long to stall for a *preferred* provider before settling for a less
  // preferred one that is free now.
  //
  // The configured order is a decision the user made, so it is worth a short
  // wait; five seconds is not. Below this, wait; above it, rotate.
  maxWaitMs: 5_000,

  // How long to back off after a 429 that carries no `retry-after`.
  //
  // Mistral's 429 has an empty body and no retry-after (docs/providers.md), so
  // for most providers this is all we have. A tight retry loop against a free
  // tier is how an account earns a longer cooldown, so it is deliberately not
  // a second or two.
  backoffMs: 20_000,

  // Cap on a single tool result, in characters, before head/tail truncation.
  //
  // Deliberately small. At Groq's measured 8,000 tokens a minute, one careless
  // file read costs most of a minute of budget.
  maxToolResultChars: 8_000,

  // Fraction of the model's context window at which the conversation is
  // compacted. A fraction rather than a number of tokens, because the window
  // differs per model and is read from the catalogue.
  compactAt: 0.7,
});

// Environment variable for each, so everything tunable is tunable from .env.
const ENV_KEYS = Object.freeze({
  rotate: 'PEASANT_ROTATE',
  maxWaitMs: 'PEASANT_MAX_WAIT_MS',
  backoffMs: 'PEASANT_BACKOFF_MS',
  maxToolResultChars: 'PEASANT_MAX_TOOL_RESULT',
  compactAt: 'PEASANT_COMPACT_AT',
});

export const TUNABLE_ENV_VARS = Object.freeze(Object.values(ENV_KEYS));

const TRUE = ['1', 'true', 'yes', 'on'];
const FALSE = ['0', 'false', 'no', 'off'];

function readBoolean(raw, name) {
  const v = String(raw).trim().toLowerCase();
  if (TRUE.includes(v)) return true;
  if (FALSE.includes(v)) return false;
  throw new Error(`${name} must be one of ${[...TRUE, ...FALSE].join(', ')}; got ${JSON.stringify(raw)}`);
}

function readNumber(raw, name, { min, max, integer }) {
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number; got ${JSON.stringify(raw)}`);
  if (integer && !Number.isInteger(n)) throw new Error(`${name} must be a whole number; got ${JSON.stringify(raw)}`);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}; got ${n}`);
  return n;
}

// No inline fallbacks: a setting that cannot be parsed is an error naming the
// variable, not a silent reversion to the default. A typo in .env that halves
// your throughput and says nothing is the failure this prevents.
export function preferences(env = {}) {
  const out = { ...DEFAULTS };

  const set = (key, read) => {
    const raw = env[ENV_KEYS[key]];
    if (raw === undefined || raw === '') return;
    out[key] = read(raw, ENV_KEYS[key]);
  };

  set('rotate', readBoolean);
  set('maxWaitMs', (r, n) => readNumber(r, n, { min: 0, max: 600_000, integer: true }));
  set('backoffMs', (r, n) => readNumber(r, n, { min: 0, max: 3_600_000, integer: true }));
  set('maxToolResultChars', (r, n) => readNumber(r, n, { min: 100, max: 1_000_000, integer: true }));
  set('compactAt', (r, n) => readNumber(r, n, { min: 0.1, max: 0.95, integer: false }));

  return Object.freeze(out);
}
