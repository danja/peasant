// Estimating token counts without a tokeniser.
//
// peasant cannot use one: `tiktoken` is a WASM blob plus BPE tables, both
// banned, and every provider tokenises differently anyway. So this estimates --
// and an estimate is only worth having if its error is known and its bias is
// the safe way round. Underestimating costs a 429 and a cooldown;
// overestimating costs a short wait.
//
// Every constant below was measured, not chosen. See bin/probe-tokens.js and
// docs/raw/<date>_tokens.json; the figures are from Groq's gpt-oss-20b on
// 2026-09-12, and tests/unit/token-estimator.test.js checks the estimator
// against those recordings.

// Tokens per character, measured across 200, 800 and 3200 character samples.
// Consistent to within 2% at every size.
//
// Code is nearly twice as dense as prose -- 0.42 against 0.214 -- which is why
// a single "characters over four" constant is not good enough: at 0.25 it would
// underestimate a file read by forty per cent, in the direction that causes 429s.
const RATE = Object.freeze({
  prose: 0.215,
  code: 0.425,
  // JSON full of English descriptions packs *better* than prose: the tool
  // schemas measured 738 tokens for 4,098 characters, or 0.18. Classifying it
  // as code -- which the symbol density otherwise does -- overestimated by
  // thirty per cent, and an estimator that refuses requests which would have
  // fitted is its own kind of broken.
  json: 0.185,
});

// A request costs this much before any content: the chat template, the role
// scaffolding, the closing turn marker.
const REQUEST_OVERHEAD = 72;

// And each message costs a little on top of its text.
const MESSAGE_OVERHEAD = 6;

// Estimates are for refusing a request before it is sent, so they lean high.
// Ten per cent covers the spread between providers' tokenisers.
// Increased from 1.1 to 1.2 to be more conservative and avoid 429 errors
const SAFETY = 1.2;

// Structured data, which is checked first because JSON is symbol-dense enough
// to look like code and does not tokenise like it.
export function looksLikeJson(text) {
  const t = text.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  return /"\s*:/.test(t.slice(0, 2000));
}

// Is this text code? Not a parser -- a density question. Code is dense in
// punctuation and structure; prose is dense in spaces and letters.
export function looksLikeCode(text) {
  const sample = text.slice(0, 4000);
  if (sample.length === 0) return false;

  const symbols = (sample.match(/[{}()[\];=<>+*/\\|&^%$#@~`_-]/g) ?? []).length;
  const words = (sample.match(/[A-Za-z]{2,}/g) ?? []).length;
  const newlines = (sample.match(/\n/g) ?? []).length;
  const indented = (sample.match(/\n[ \t]+/g) ?? []).length;

  const symbolRatio = symbols / sample.length;
  const indentRatio = newlines === 0 ? 0 : indented / newlines;

  // Any one of these alone is weak; together they are reliable enough for a
  // decision whose cost is a slightly wrong estimate.
  return symbolRatio > 0.05 || indentRatio > 0.3 || (words > 0 && symbols / words > 0.6);
}

// Tokens for a piece of text, with no message scaffolding.
export function classify(text) {
  if (looksLikeJson(text)) return 'json';
  return looksLikeCode(text) ? 'code' : 'prose';
}

export function estimateText(text) {
  const s = String(text ?? '');
  if (s === '') return 0;
  return Math.ceil(s.length * RATE[classify(s)] * SAFETY);
}

// Tokens for one message, including its scaffolding. Tool calls are counted
// through their serialised arguments, which is what actually goes on the wire.
export function estimateMessage(message) {
  let chars = String(message.content ?? '').length;
  let tokens = estimateText(message.content ?? '');

  for (const call of message.tool_calls ?? []) {
    const serialised = `${call.function?.name ?? ''}${call.function?.arguments ?? ''}`;
    tokens += estimateText(serialised);
    chars += serialised.length;
  }
  return tokens + MESSAGE_OVERHEAD;
}

// Tokens for a whole request: messages, plus the tool schemas, plus the fixed
// per-request cost.
//
// The tool schemas are the largest single item and the easiest to forget --
// measured at 738 tokens for seven tools, which is more than nine per cent of
// Groq's entire per-minute budget, spent again on every turn.
export function estimateRequest({ messages = [], tools = [] } = {}) {
  const content = messages.reduce((n, m) => n + estimateMessage(m), 0);
  const toolTokens = tools.length === 0 ? 0 : estimateText(JSON.stringify(tools));
  return REQUEST_OVERHEAD + content + toolTokens;
}

// What the estimator believes, for `peasant doctor` and for the budget display.
export const CONSTANTS = Object.freeze({
  ...RATE, requestOverhead: REQUEST_OVERHEAD, messageOverhead: MESSAGE_OVERHEAD, safety: SAFETY,
});

// A calibrating estimator.
//
// The constants above were measured against one model on one day. Every
// provider tokenises differently, and every response tells us exactly how wrong
// we were -- `usage.prompt_tokens` against what we predicted. Ignoring that
// would be choosing to stay wrong when the answer is handed to us on every
// single turn.
//
// One of these per provider, because the correction is a property of the
// tokeniser, not of the conversation.
export class TokenEstimator {
  #ratio = 1;
  #observations = 0;

  // How far off the raw estimate has been, as a multiplier. 1 means the
  // constants fit this provider exactly.
  get correction() { return this.#ratio; }
  get observations() { return this.#observations; }

  estimate(request) {
    return Math.ceil(estimateRequest(request) * this.#ratio);
  }

  // Feed back what a request actually cost. `predicted` is what estimate()
  // said before the request went out.
  observe({ predicted, actual }) {
    if (!Number.isFinite(predicted) || !Number.isFinite(actual)) return;
    if (predicted <= 0 || actual <= 0) return;

    // The raw estimate is what the correction multiplies, so recover it.
    const raw = predicted / this.#ratio;
    const sample = actual / raw;

    // A running mean over the last several observations rather than the whole
    // session: a conversation's character changes as it goes -- prose at the
    // start, file contents later -- and an average over everything lags it.
    const weight = Math.min(this.#observations, 9) + 1;
    this.#ratio = (this.#ratio * weight + sample) / (weight + 1);

    // Never trust a correction far from 1: a single odd response (a cached
    // prompt, a provider counting images) must not make every later estimate
    // absurd.
    this.#ratio = Math.min(2, Math.max(0.5, this.#ratio));
    this.#observations++;
  }
}
