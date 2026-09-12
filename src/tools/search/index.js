// Choosing a search engine, and making the choice invisible.
//
// ripgrep when the machine has one, JavaScript otherwise -- and the result must
// be identical either way, or the same query gives two people different answers
// depending on what they happen to have installed.
// tests/unit/search-parity.test.js is what makes that true.
//
// peasant does not bundle ripgrep and never will: a prebuilt binary is banned
// here and the target CPU is why. Using one already on the PATH is different --
// it was built for that machine.

import { spawnSync } from 'node:child_process';
import * as js from './js.js';
import * as rg from './rg.js';

const MAX_MATCHES = 100;
const MAX_LINE = 400;

// How many matches an engine may collect before giving up. Results are sorted
// and then cut to MAX_MATCHES, so which 100 you see does not depend on the
// order a particular engine happened to walk the tree in. Below this ceiling
// the two engines agree exactly; above it they may have collected different
// sets, and the output says it was truncated.
const CEILING = 2000;

let cached = null;

// Detected once. `rg --version` on every grep would cost a process spawn per
// search for an answer that cannot change mid-session.
export function detect({ force = false } = {}) {
  if (cached !== null && !force) return cached;
  const probe = spawnSync('rg', ['--version'], { encoding: 'utf8', timeout: 5000 });
  cached = probe.error || probe.status !== 0
    ? { engine: js, version: null }
    : { engine: rg, version: (probe.stdout ?? '').split('\n')[0].trim() };
  return cached;
}

export function engineName() {
  const { engine, version } = detect();
  return engine === rg ? version ?? 'ripgrep' : 'javascript';
}

export async function search(options) {
  const request = { ...options, ceiling: CEILING };
  const { engine } = detect();

  let result;
  try {
    result = await engine.search(request);
  } catch (e) {
    if (e instanceof rg.UnsupportedPattern) {
      // Rust's regex crate has no lookaround or backreferences, and the
      // JavaScript engine does. Falling back keeps a valid pattern working
      // rather than making the answer depend on what is installed.
      result = await js.search(request);
    } else {
      throw e;
    }
  }

  // Sorting, line truncation and the match cap all happen here, once, so they
  // cannot differ between engines. Sorting is what makes the *choice* of which
  // matches to show independent of walk order.
  const sorted = [...result.matches].sort(
    (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line),
  );
  const truncated = result.truncated || sorted.length > MAX_MATCHES;

  return {
    truncated,
    matches: sorted.slice(0, MAX_MATCHES).map((m) => ({
      ...m,
      text: m.text.length > MAX_LINE ? `${m.text.slice(0, MAX_LINE)}...` : m.text,
    })),
  };
}

// The one place a search result becomes text for the model.
export function format(result, { pattern, path: searchPath }) {
  if (result.matches.length === 0) {
    return `no matches for ${pattern}${searchPath === '.' ? '' : ` under ${searchPath}`}`;
  }
  const lines = result.matches.map((m) => `${m.file}:${m.line}:${m.text.trim()}`);
  const n = result.matches.length;
  const note = result.truncated
    ? `\n[stopped at ${MAX_MATCHES} matches; narrow the pattern or use include]`
    : '';
  return `${n} match${n === 1 ? '' : 'es'}\n${lines.join('\n')}${note}`;
}
