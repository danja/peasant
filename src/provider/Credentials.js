// Borrowing a credential another tool already holds.
//
// Two providers here authenticate with an OAuth access token that lives in a
// file written by a different program -- Claude Code's and Codex's own logins.
// That makes this the one place in peasant that reads a file it does not own,
// and the rules follow from whose file it is:
//
//   - **It is never written.** Not to refresh a token, not to tidy a format.
//     Peasant is a guest in that file; corrupting another tool's login while
//     "helping" is not a failure anyone would forgive.
//   - **A problem is reported and skipped, never fatal.** The same rule
//     CLAUDE.md gives for a project's own `./.env`: refusing to start because
//     somebody else's file is missing would throw away every other provider's
//     key for no reason. One provider is unusable; the session is not.
//   - **The remedy is named.** "Expired" is not an error message; "expired, run
//     `claude` to sign in again" is.
//
// The field names are *candidates*, not a single known path, because these
// files belong to programs that may reorganise them without telling anyone. A
// file that matches none of them is reported with what was looked for and which
// keys it actually has, so the next person can fix the list in one edit rather
// than in an afternoon with a debugger.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class CredentialProblem extends Error {}

// Reads one credential file as described by a profile's `credentialFile`.
//
// Returns { token, expiresAt, headers } on success. On any failure it returns
// { problem } with a sentence fit to print -- callers must not throw on it.
export function readCredential(spec, { home = os.homedir(), now = () => Date.now(), readFile = fs.readFileSync } = {}) {
  const file = expandHome(spec.file, home);

  let text;
  try {
    text = readFile(file, 'utf8');
  } catch (e) {
    const why = e.code === 'ENOENT' ? 'no such file' : e.message;
    return { problem: `${file}: ${why}. ${spec.remedy}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { problem: `${file}: not JSON (${e.message}). ${spec.remedy}` };
  }

  const token = pick(parsed, spec.tokenPaths);
  if (typeof token !== 'string' || token === '') {
    return {
      problem: `${file}: no access token found. Looked for ${describe(spec.tokenPaths)}; ` +
        `the file has ${topLevelKeys(parsed)}. ${spec.remedy}`,
    };
  }

  // Expiry from the file if it states one, from the token itself otherwise. A
  // JWT carries its own `exp`, which is the more trustworthy of the two: it is
  // what the server will actually enforce.
  const stated = pick(parsed, spec.expiryPaths ?? []);
  const expiresAt = normaliseExpiry(stated) ?? jwtExpiry(token);

  if (expiresAt !== null && expiresAt <= now()) {
    const ago = Math.round((now() - expiresAt) / 60_000);
    return { problem: `${file}: the access token expired ${ago} minute${ago === 1 ? '' : 's'} ago. ${spec.remedy}` };
  }

  // Headers some endpoints require alongside the token, whose values also live
  // in the file -- an account id, say. Absent is not an error: only the
  // endpoint knows whether it needed one, and it will say so with a 401.
  const headers = {};
  for (const [name, paths] of Object.entries(spec.headerPaths ?? {})) {
    const value = pick(parsed, paths);
    if (typeof value === 'string' && value !== '') headers[name] = value;
  }

  return { token, expiresAt, headers };
}

// First path that resolves to something. A path is an array of keys.
function pick(root, paths) {
  for (const p of paths) {
    let node = root;
    for (const key of p) {
      if (node === null || typeof node !== 'object') { node = undefined; break; }
      node = node[key];
    }
    if (node !== undefined && node !== null) return node;
  }
  return undefined;
}

// Epoch milliseconds, from whichever of the three forms the file used. Seconds
// and milliseconds are told apart by magnitude: an epoch in seconds will not
// reach 10^12 until the year 33658.
function normaliseExpiry(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// The `exp` claim, when the token is a JWT. Decoding is not verifying: this
// reads a claim to decide whether it is worth making a request at all, and the
// server remains the only authority on whether the token is good.
function jwtExpiry(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function describe(paths) {
  return paths.map((p) => p.join('.')).join(' or ');
}

// Names only. The values are the thing being protected, and an error message is
// exactly the kind of place a secret escapes into a bug report.
function topLevelKeys(parsed) {
  if (parsed === null || typeof parsed !== 'object') return `a JSON ${typeof parsed}`;
  const keys = Object.keys(parsed);
  if (keys.length === 0) return 'no keys';
  return keys.slice(0, 12).join(', ') + (keys.length > 12 ? ', ...' : '');
}

function expandHome(p, home) {
  return p.startsWith('~') ? path.join(home, p.slice(1)) : p;
}
