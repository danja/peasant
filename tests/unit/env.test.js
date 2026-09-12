import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, read, load, require_, redact } from '../../src/config/Env.js';

test('parses plain assignments in file order', () => {
  assert.deepEqual(parse('A=1\nB=two\n'), { A: '1', B: 'two' });
});

test('ignores blank lines and comments', () => {
  assert.deepEqual(parse('\n# a note\n\nA=1\n   # indented\n'), { A: '1' });
});

test('tolerates an export prefix and whitespace', () => {
  assert.deepEqual(parse('export A=1\n  B  =  2  \n'), { A: '1', B: '2' });
});

test('an empty value is empty, not missing', () => {
  // example.env ships every key empty; they must parse as present-and-blank so
  // "no account yet" and "typo in the name" stay distinguishable.
  const v = parse('GROQ_API_KEY=\n');
  assert.equal(v.GROQ_API_KEY, '');
  assert.ok('GROQ_API_KEY' in v);
});

test('strips an inline comment from an unquoted value', () => {
  assert.equal(parse('A=value # trailing').A, 'value');
  // A # with no preceding space is part of the value: keys can contain one.
  assert.equal(parse('A=val#ue').A, 'val#ue');
});

test('keeps a # inside quotes', () => {
  assert.equal(parse('A="has # hash"').A, 'has # hash');
  assert.equal(parse("A='has # hash'").A, 'has # hash');
});

test('honours escapes in double quotes only', () => {
  assert.equal(parse('A="one\\ntwo"').A, 'one\ntwo');
  assert.equal(parse("A='one\\ntwo'").A, 'one\\ntwo');
});

test('allows a comment after a closing quote', () => {
  assert.equal(parse('A="v"  # why').A, 'v');
});

test('refuses a line it cannot parse, naming the line number', () => {
  // No inline fallbacks: a skipped line is a key that vanishes, and a vanished
  // key looks exactly like a missing account.
  assert.throws(() => parse('A=1\nthis is not an assignment\n'), /:2: cannot parse/);
});

test('refuses an unterminated quote', () => {
  assert.throws(() => parse('A="oops\n'), /:1: unterminated " quote/);
});

test('refuses text after a closing quote', () => {
  assert.throws(() => parse('A="v" junk\n'), /:1: unexpected text after closing quote/);
});

test('a missing file is not an error', () => {
  assert.deepEqual(read(path.join(os.tmpdir(), 'peasant-does-not-exist-' + Date.now())), {});
});

test('reads a real file', (t) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-')), '.env');
  fs.writeFileSync(f, 'A=1\nB="two"\n');
  t.after(() => fs.rmSync(path.dirname(f), { recursive: true, force: true }));
  assert.deepEqual(read(f), { A: '1', B: 'two' });
});

test('the real environment beats the file', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-')), '.env');
  fs.writeFileSync(f, 'A=from-file\nB=from-file\n');
  const merged = load({ file: f, env: { A: 'from-env' } });
  assert.equal(merged.A, 'from-env', 'an exported variable is a deliberate act; a file is a default');
  assert.equal(merged.B, 'from-file');
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

test('an empty environment variable does not mask a file value', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-')), '.env');
  fs.writeFileSync(f, 'A=from-file\n');
  assert.equal(load({ file: f, env: { A: '' } }).A, 'from-file');
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

test('require_ names what is missing and where to put it', () => {
  assert.equal(require_({ A: 'x' }, 'A'), 'x');
  assert.throws(() => require_({}, 'GROQ_API_KEY'), /GROQ_API_KEY is not set.*example\.env/s);
  assert.throws(() => require_({ GROQ_API_KEY: '' }, 'GROQ_API_KEY'), /is not set/);
});

test('redact removes every secret value from text', () => {
  const values = { GROQ_API_KEY: 'gsk_abcdefghijklmnop', MISTRAL_API_KEY: 'j2SmAbCdEfGhIjKl', NOT_SECRET: 'visible' };
  const out = redact('auth gsk_abcdefghijklmnop and j2SmAbCdEfGhIjKl and visible', values);
  assert.ok(!out.includes('gsk_abcdefghijklmnop'));
  assert.ok(!out.includes('j2SmAbCdEfGhIjKl'));
  assert.ok(out.includes('visible'), 'only secrets are redacted');
  assert.equal(out.match(/\[REDACTED\]/g).length, 2);
});

test('redact handles one key being a prefix of another', () => {
  // Longest first, or the short key masks part of the long one and leaves a
  // recognisable tail in the output.
  const values = { A_API_KEY: 'abcdefgh', B_API_KEY: 'abcdefghijklmnop' };
  const out = redact('abcdefghijklmnop', values);
  assert.equal(out, '[REDACTED]');
});

test('redact ignores values too short to be keys', () => {
  // A one-character value would otherwise redact half the document.
  assert.equal(redact('a short a', { X_API_KEY: 'a' }), 'a short a');
});
