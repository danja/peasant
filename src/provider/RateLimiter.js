// Budget, read from the provider rather than assumed.
//
// Every published figure for these free tiers turned out to be wrong (see
// docs/providers.md: Groq documents 6,000 tokens/minute and reports 8,000;
// Mistral reports 625,000 where the write-ups say "roughly 1 req/s"). So
// nothing here is a constant. The limiter knows only what a response told it,
// and what a profile said those header names mean.
//
// It is deliberately pessimistic. Overestimating a request costs a short wait;
// underestimating costs a 429, and on a free tier a 429 can carry a cooldown
// far longer than the wait would have been.

import { DEFAULTS } from '../config/preferences.js';

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

// Groq writes reset as a duration string -- "644ms", "1m26.4s", "2h3m4s" --
// not seconds and not a timestamp. Returns milliseconds.
export function parseDuration(value) {
  const s = String(value).trim();
  if (s === '') throw new Error('parseDuration: empty value');

  const parts = [...s.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
  if (parts.length === 0) throw new Error(`parseDuration: cannot parse ${JSON.stringify(value)}`);

  // Guard against a partial match silently dropping half the string: "1m26.4s"
  // must consume all seven characters, not just the "1m".
  const consumed = parts.reduce((n, p) => n + p[0].length, 0);
  if (consumed !== s.length) {
    throw new Error(`parseDuration: unexpected characters in ${JSON.stringify(value)}`);
  }

  return parts.reduce((ms, [, n, unit]) => ms + Number(n) * UNIT_MS[unit], 0);
}

// A reset field, in whichever form the profile says this provider uses.
export function parseReset(value, format, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null;
  switch (format) {
    case 'duration': return parseDuration(value);
    case 'seconds': return Math.max(0, Number(value) * 1000);
    case 'epoch-seconds': return Math.max(0, Number(value) * 1000 - now);
    default: throw new Error(`parseReset: unknown format ${format}`);
  }
}

// Retry-After is seconds or an HTTP date. Both appear in the wild.
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(value);
  return Number.isNaN(when) ? null : Math.max(0, when - now);
}

function headerNumber(headers, name) {
  if (!name) return null;
  const raw = headers.get?.(name) ?? headers[name];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function headerRaw(headers, name) {
  if (!name) return null;
  return headers.get?.(name) ?? headers[name] ?? null;
}

export class RateLimiter {
  #profile;
  #now;

  // Everything below is null until a response says otherwise. Null means "not
  // known", which is different from zero and must never be treated as it.
  #tokens = { limit: null, remaining: null, resetAt: null };
  #requests = { limit: null, remaining: null, resetAt: null };
  #lastQueryCost = null;
  #blockedUntil = null;
  #blockReason = null;

  constructor(profile, { now = () => Date.now() } = {}) {
    this.#profile = profile;
    this.#now = now;
  }

  get state() {
    return {
      tokens: { ...this.#tokens },
      requests: { ...this.#requests },
      lastQueryCost: this.#lastQueryCost,
      blockedUntil: this.#blockedUntil,
      blockReason: this.#blockReason,
    };
  }

  // Feed every response back, successful or not. This is the only way the
  // limiter learns anything.
  observe(headers) {
    const rl = this.#profile.rateLimit;
    const now = this.#now();

    const window = (kind, names) => {
      const limit = headerNumber(headers, names.limit);
      const remaining = headerNumber(headers, names.remaining);
      if (limit === null && remaining === null) return;

      let resetAt = null;
      if (names.reset && rl.resetFormat) {
        const ms = parseReset(headerRaw(headers, names.reset), rl.resetFormat, now);
        if (ms !== null) resetAt = now + ms;
      } else if (rl.impliedWindowMs) {
        // The provider states no reset, so the window is inferred from the
        // header name. Assuming it rolls a full window from now is the
        // conservative reading -- it can only make us wait too long.
        resetAt = now + rl.impliedWindowMs;
      }

      kind.limit = limit ?? kind.limit;
      kind.remaining = remaining;
      kind.resetAt = resetAt;
    };

    window(this.#tokens, { limit: rl.limitTokens, remaining: rl.remainingTokens, reset: rl.resetTokens });
    window(this.#requests, { limit: rl.limitRequests, remaining: rl.remainingRequests, reset: rl.resetRequests });

    const cost = headerNumber(headers, rl.queryCost);
    if (cost !== null) this.#lastQueryCost = cost;
  }

  // A 429 is authoritative and overrides everything the headers implied.
  note429(headers, { defaultBackoffMs = DEFAULTS.backoffMs } = {}) {
    const now = this.#now();
    const retry = parseRetryAfter(headerRaw(headers, 'retry-after'), now);
    this.observe(headers);
    // Where the provider says nothing, wait long enough to matter. A tight
    // retry loop against a free tier is how an account gets a longer cooldown.
    this.#blockedUntil = now + (retry ?? defaultBackoffMs);
    this.#blockReason = retry === null ? '429 (no retry-after)' : `429 (retry-after ${retry} ms)`;
    return this.#blockedUntil - now;
  }

  // May a request costing roughly `estimatedTokens` go now?
  // Returns { allowed, waitMs, reason }. waitMs is how long until it could.
  check(estimatedTokens) {
    const now = this.#now();

    if (this.#blockedUntil !== null) {
      if (now < this.#blockedUntil) {
        return { allowed: false, waitMs: this.#blockedUntil - now, reason: this.#blockReason };
      }
      this.#blockedUntil = null;
      this.#blockReason = null;
    }

    const expired = (w) => w.resetAt !== null && now >= w.resetAt;

    for (const [name, w, need] of [
      ['tokens', this.#tokens, estimatedTokens],
      ['requests', this.#requests, 1],
    ]) {
      // A rolled window restores `remaining` to `limit`; it does not make the
      // limit unknown. Skipping the check entirely when the window had expired
      // meant a request larger than the provider's *whole* budget was sent
      // again and again -- and Groq reports `reset-tokens: 1ms` on the very
      // response that states the limit, so the window had almost always rolled
      // by the time anyone asked.
      //
      // A limit of *zero* is the exception, and Mistral has sent one. It is a
      // symptom rather than a durable fact, so it does not survive the roll:
      // carrying it forward would pin the provider shut for the session on the
      // strength of one odd response.
      const available = expired(w) ? (w.limit > 0 ? w.limit : null) : w.remaining;
      if (available === null) continue; // nothing known
      if (available >= need) continue;

      // Not enough left. If the limit itself is smaller than this request, no
      // amount of waiting helps and the caller has to shrink the request.
      //
      // A limit of exactly zero is different, and Mistral returned one: it
      // means exhausted right now, not impossible forever. Treating it as
      // impossible would drop the provider from the pool permanently on what
      // may be a momentary condition.
      if (w.limit !== null && w.limit > 0 && w.limit < need) {
        return {
          allowed: false,
          waitMs: Infinity,
          reason: `request needs ${need} ${name} but the whole ${name} limit is ${w.limit}`,
        };
      }
      return {
        allowed: false,
        waitMs: w.resetAt === null ? 1000 : Math.max(0, w.resetAt - now),
        reason: `${available} ${name} left, need ${need}`,
      };
    }

    return { allowed: true, waitMs: 0, reason: null };
  }

  // How much headroom is left, as a fraction, for choosing between providers.
  // null when nothing is known -- an unmeasured provider is not "empty".
  headroom() {
    const t = this.#tokens;
    if (t.remaining === null || !t.limit) return null;
    if (t.resetAt !== null && this.#now() >= t.resetAt) return 1;
    return Math.max(0, Math.min(1, t.remaining / t.limit));
  }
}
