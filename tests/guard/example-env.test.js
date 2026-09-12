// example.env is committed; .env is not. The failure this prevents is somebody
// filling in example.env instead of copying it, and pushing a live key.
//
// It also guards the shape of the file, because it is the only documentation of
// what Config reads. When ProfileRegistry exists, this test grows a second half
// binding the names here to the profiles that consume them -- see TODO.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './lib/scan.js';
import { TUNABLE_ENV_VARS } from '../../src/config/preferences.js';

const FILE = path.join(REPO, 'example.env');
const src = fs.readFileSync(FILE, 'utf8');

// Only uncommented assignments are live settings; everything else is prose.
const assignments = src.split('\n')
  .map((l, i) => ({ line: i + 1, text: l.trim() }))
  .filter(({ text }) => text && !text.startsWith('#') && text.includes('='))
  .map(({ line, text }) => {
    const eq = text.indexOf('=');
    return { line, name: text.slice(0, eq), value: text.slice(eq + 1) };
  });

test('no secret in example.env has a value', () => {
  const SECRET = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/;
  const filled = assignments.filter((a) => SECRET.test(a.name) && a.value !== '');
  assert.deepEqual(filled.map((a) => `${FILE}:${a.line} ${a.name}`), [],
    'a key has been filled into example.env -- copy it to .env instead; .env is gitignored');
});

test('nothing in example.env looks like a real credential', () => {
  // Belt and braces: a key pasted into a commented line, or into a field this
  // test does not recognise as a secret by name, is still a leak.
  const SHAPES = [
    /\bsk-[A-Za-z0-9_-]{16,}/,        // OpenAI-style, and OpenRouter
    /\bgsk_[A-Za-z0-9]{16,}/,         // Groq
    /\bcsk-[A-Za-z0-9]{16,}/,         // Cerebras
    /\bAIza[A-Za-z0-9_-]{20,}/,       // Google
    /\bhf_[A-Za-z0-9]{16,}/,          // Hugging Face
    /\bnvapi-[A-Za-z0-9_-]{16,}/,     // NVIDIA
    /\bghp_[A-Za-z0-9]{20,}/,         // GitHub
  ];
  const hits = SHAPES.filter((re) => re.test(src)).map(String);
  assert.deepEqual(hits, [], `example.env contains something shaped like a live key: ${hits.join(', ')}`);
});

test('.env is gitignored and example.env is not', () => {
  // The whole arrangement rests on this, and it is one .gitignore edit away
  // from being wrong in either direction.
  const ignored = (p) => spawnSync('git', ['check-ignore', '-q', p], { cwd: REPO }).status === 0;
  assert.ok(ignored('.env'), '.env must be gitignored');
  assert.ok(!ignored('example.env'), 'example.env must be tracked, or nobody sees it');
});

test('every provider block names where to get the key', () => {
  // A config file that lists a provider without a signup URL sends the reader
  // to a search engine. Each *_API_KEY or *_TOKEN must have a "Key:" line above.
  const lines = src.split('\n');
  const missing = [];
  for (const a of assignments.filter((x) => /(_API_KEY|_TOKEN)$/.test(x.name))) {
    const preceding = lines.slice(Math.max(0, a.line - 16), a.line - 1).join('\n');
    if (!/Key:\s+https?:\/\//.test(preceding)) missing.push(a.name);
  }
  assert.deepEqual(missing, [], `these settings have no "Key: <url>" line above them: ${missing.join(', ')}`);
});

test('every tunable is documented in example.env', () => {
  // A setting that exists but is written down nowhere is a setting nobody will
  // find. example.env is the only documentation of what Config reads.
  const missing = TUNABLE_ENV_VARS.filter((v) => !src.includes(v));
  assert.deepEqual(missing, [],
    `add these to example.env: ${missing.join(', ')}`);
});

test('every PEASANT_ setting in example.env is one the code reads', () => {
  // The other direction: a documented setting that nothing consumes is worse
  // than an undocumented one, because someone will set it and expect an effect.
  const known = new Set([...TUNABLE_ENV_VARS, 'PEASANT_PROVIDERS', 'PEASANT_PERMISSION_MODE', 'PEASANT_HOME']);
  const documented = [...src.matchAll(/^#?(PEASANT_[A-Z_]+)=/gm)].map((m) => m[1]);
  const orphans = [...new Set(documented)].filter((v) => !known.has(v));
  assert.deepEqual(orphans, [],
    `example.env documents settings nothing reads: ${orphans.join(', ')}`);
});

test('the scan found settings to check', () => {
  assert.ok(assignments.length > 0, 'no assignments parsed out of example.env -- this guard is blind');
});
