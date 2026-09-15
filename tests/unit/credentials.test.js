// Reading a credential file that belongs to another program.
//
// Tested against real files in a real temporary directory, not a stubbed
// reader, because the half that matters is the filesystem behaviour: that a
// missing file is survivable, that an expired token is caught before a request
// is spent on it, and above all that peasant never writes to a file it does not
// own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCredential } from '../../src/provider/Credentials.js';
import { configure } from '../../src/provider/ProfileRegistry.js';
import claudeCode from '../../src/provider/profiles/claude-code.js';
import codex from '../../src/provider/profiles/codex.js';

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-cred-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A token shaped like the JWT these endpoints issue, so the `exp` claim can be
// read the way the real one is. Not a credential: the signature is the word
// "unsigned" and it is valid for nothing.
function jwt(expSeconds) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: expSeconds })}.unsigned`;
}

const SPEC = {
  file: null,
  tokenPaths: [['claudeAiOauth', 'accessToken'], ['accessToken']],
  expiryPaths: [['claudeAiOauth', 'expiresAt']],
  remedy: 'Run `the other tool` to sign in.',
};

function write(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return file;
}

// --- the happy path --------------------------------------------------------

test('a nested token is found and returned', (t) => {
  const file = write(sandbox(t), 'creds.json', {
    claudeAiOauth: { accessToken: 'tok-abc', expiresAt: Date.now() + 3_600_000 },
  });
  const got = readCredential({ ...SPEC, file });
  assert.equal(got.token, 'tok-abc');
  assert.equal(got.problem, undefined);
});

test('a token at a later candidate path is still found', (t) => {
  // The candidate list exists because these files are reorganised by programs
  // that owe peasant no notice.
  const file = write(sandbox(t), 'creds.json', { accessToken: 'tok-flat' });
  assert.equal(readCredential({ ...SPEC, file }).token, 'tok-flat');
});

test('extra headers named by the spec are read out of the file', (t) => {
  const file = write(sandbox(t), 'creds.json', {
    tokens: { access_token: 'tok', account_id: 'acct-77' },
  });
  const got = readCredential({
    file,
    tokenPaths: [['tokens', 'access_token']],
    headerPaths: { 'chatgpt-account-id': [['tokens', 'account_id']] },
    remedy: 'x',
  });
  assert.deepEqual(got.headers, { 'chatgpt-account-id': 'acct-77' });
});

// --- expiry ----------------------------------------------------------------

test('an expired token is refused before a request is spent on it', (t) => {
  const file = write(sandbox(t), 'creds.json', {
    claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() - 600_000 },
  });
  const got = readCredential({ ...SPEC, file });
  assert.equal(got.token, undefined);
  assert.match(got.problem, /expired 10 minutes ago/);
  assert.match(got.problem, /sign in/, 'the message must name the remedy');
});

test('expiry in seconds and in milliseconds are both understood', (t) => {
  const dir = sandbox(t);
  const soon = Date.now() + 3_600_000;
  const inSeconds = write(dir, 'a.json', { claudeAiOauth: { accessToken: 't', expiresAt: Math.floor(soon / 1000) } });
  const inMillis = write(dir, 'b.json', { claudeAiOauth: { accessToken: 't', expiresAt: soon } });

  for (const file of [inSeconds, inMillis]) {
    const got = readCredential({ ...SPEC, file });
    assert.equal(got.token, 't', `${file} was misread`);
    // Both land within a second of each other, so neither was scaled wrongly.
    assert.ok(Math.abs(got.expiresAt - soon) < 1000, `${file}: expiry off by ${got.expiresAt - soon}ms`);
  }
});

test("a token's own exp claim is used when the file states no expiry", (t) => {
  // The Codex file records when it last refreshed, not when the token dies.
  const file = write(sandbox(t), 'creds.json', {
    tokens: { access_token: jwt(Math.floor(Date.now() / 1000) - 60) },
    last_refresh: '2026-09-14T16:42:00Z',
  });
  const got = readCredential({ file, tokenPaths: [['tokens', 'access_token']], remedy: 'run it again' });
  assert.match(got.problem, /expired/);
  assert.match(got.problem, /run it again/);
});

test('a token whose exp claim is in the future is accepted', (t) => {
  const file = write(sandbox(t), 'creds.json', {
    tokens: { access_token: jwt(Math.floor(Date.now() / 1000) + 3600) },
  });
  const got = readCredential({ file, tokenPaths: [['tokens', 'access_token']], remedy: 'x' });
  assert.equal(got.problem, undefined);
});

test('a token with no expiry anywhere is used rather than refused', (t) => {
  // Unknown is not expired. The server remains the authority; refusing here
  // would make a working credential unusable on a guess.
  const file = write(sandbox(t), 'creds.json', { accessToken: 'opaque-token' });
  const got = readCredential({ ...SPEC, file });
  assert.equal(got.token, 'opaque-token');
  assert.equal(got.expiresAt, null);
});

// --- failures are reported, never thrown -----------------------------------

test('a missing file is a problem, not an exception', (t) => {
  const got = readCredential({ ...SPEC, file: path.join(sandbox(t), 'nope.json') });
  assert.match(got.problem, /no such file/);
  assert.match(got.problem, /sign in/);
});

test('a file that is not JSON is a problem, not an exception', (t) => {
  const file = write(sandbox(t), 'creds.json', 'this is not json');
  assert.match(readCredential({ ...SPEC, file }).problem, /not JSON/);
});

test('a file with no recognisable token says what it looked for and what it has', (t) => {
  // So the candidate list can be fixed in one edit rather than in an afternoon.
  const file = write(sandbox(t), 'creds.json', { somethingElse: { nested: 1 }, version: 2 });
  const problem = readCredential({ ...SPEC, file }).problem;
  assert.match(problem, /claudeAiOauth\.accessToken or accessToken/);
  assert.match(problem, /somethingElse, version/);
});

test('an error message never contains the token', (t) => {
  // An error message is exactly where a secret escapes into a bug report.
  const secret = 'sk-ant-oat-SUPERSECRET-DO-NOT-PRINT';
  const file = write(sandbox(t), 'creds.json', {
    claudeAiOauth: { accessToken: secret, expiresAt: Date.now() - 1000 },
  });
  const got = readCredential({ ...SPEC, file });
  assert.ok(got.problem, 'expected a problem');
  assert.ok(!got.problem.includes(secret), 'the token reached the error message');
  assert.ok(!got.problem.includes('SUPERSECRET'));
});

// --- the rule that matters most --------------------------------------------

test('the credential file is never written, whatever state it is in', (t) => {
  const dir = sandbox(t);
  const cases = {
    'valid.json': { claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 3_600_000 } },
    'expired.json': { claudeAiOauth: { accessToken: 'tok', expiresAt: 1 } },
    'unrecognised.json': { nothing: true },
    'broken.json': 'not json at all',
  };

  for (const [name, value] of Object.entries(cases)) {
    const file = write(dir, name, value);
    const before = fs.readFileSync(file, 'utf8');
    const statBefore = fs.statSync(file);

    readCredential({ ...SPEC, file });

    assert.equal(fs.readFileSync(file, 'utf8'), before, `${name}: contents changed`);
    assert.equal(fs.statSync(file).mtimeMs, statBefore.mtimeMs, `${name}: mtime changed`);
  }

  // And nothing new appeared beside it -- no lockfile, no backup, no cache.
  assert.deepEqual(fs.readdirSync(dir).sort(), Object.keys(cases).sort());
});

// --- as the registry uses it -----------------------------------------------

test('a profile with a credential file becomes usable without any key set', (t) => {
  const dir = sandbox(t);
  write(dir, '.credentials.json', { claudeAiOauth: { accessToken: 'tok-live', expiresAt: Date.now() + 3_600_000 } });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.copyFileSync(path.join(dir, '.credentials.json'), path.join(dir, '.claude', '.credentials.json'));

  const config = configure(claudeCode, {}, { home: dir });
  assert.equal(config.usable, true);
  assert.equal(config.key, 'tok-live');
  assert.equal(config.problem, null);
});

test('an explicit token beats the file', (t) => {
  const dir = sandbox(t);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  write(dir, '.claude/.credentials.json', { claudeAiOauth: { accessToken: 'from-file', expiresAt: Date.now() + 3_600_000 } });

  const config = configure(claudeCode, { CLAUDE_CODE_OAUTH_TOKEN: 'from-env' }, { home: dir });
  assert.equal(config.key, 'from-env');
});

test('an unreadable credential file makes one provider unusable and says why', (t) => {
  // Not an exception: the other providers in the list are fine and must stay
  // fine. This is the rule CLAUDE.md gives for somebody else's file.
  const config = configure(codex, {}, { home: sandbox(t) });
  assert.equal(config.usable, false);
  assert.match(config.problem, /no such file/);
  assert.match(config.problem, /codex/, 'the remedy must name the tool that owns the file');
});

test('the account header from the file reaches the request headers', (t) => {
  const dir = sandbox(t);
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  write(dir, '.codex/auth.json', {
    tokens: { access_token: jwt(Math.floor(Date.now() / 1000) + 3600), account_id: 'acct-42' },
  });

  const config = configure(codex, {}, { home: dir });
  assert.equal(config.usable, true);
  assert.equal(config.extraHeaders['chatgpt-account-id'], 'acct-42');
});
