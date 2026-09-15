// The provider list, example.env, and the captured evidence must agree.
//
// Three copies of the same facts otherwise -- a profile file, a line in
// ProfileRegistry, and a block in example.env -- and nothing would notice them
// diverging. The symptom of divergence is "it stalls sometimes", which is the
// most expensive kind of bug to chase.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, listFiles, scanSource } from './lib/scan.js';
import { PROFILES, PROFILE_NAMES } from '../../src/provider/ProfileRegistry.js';

const PROFILE_DIR = path.join(REPO, 'src', 'provider', 'profiles');
const exampleEnv = fs.readFileSync(path.join(REPO, 'example.env'), 'utf8');

test('every file in profiles/ is registered', () => {
  const files = fs.readdirSync(PROFILE_DIR)
    .filter((f) => f.endsWith('.js') && f !== 'generic.js')
    .map((f) => f.replace(/\.js$/, ''));
  const unregistered = files.filter((f) => !PROFILE_NAMES.includes(f));
  assert.deepEqual(unregistered, [],
    `profiles/ contains files no one can reach: ${unregistered.join(', ')}`);
});

test('every registered profile has a file', () => {
  const missing = PROFILE_NAMES.filter((n) => !fs.existsSync(path.join(PROFILE_DIR, `${n}.js`)));
  assert.deepEqual(missing, []);
});

test('every profile names its settings in example.env', () => {
  // A provider nobody can configure is a provider nobody will use.
  const missing = [];
  for (const p of PROFILES) {
    for (const v of [p.keyVar, p.baseUrlVar, p.modelVar]) {
      if (!exampleEnv.includes(v)) missing.push(`${p.name}: ${v}`);
    }
  }
  assert.deepEqual(missing, [], `add these to example.env: ${missing.join(', ')}`);
});

test("example.env's base URLs are the profiles' own", () => {
  // The names were already bound; the URLs were two copies of the same fact,
  // and a provider moving its endpoint would have left the documented one
  // quietly wrong.
  const wrong = [];
  for (const p of PROFILES) {
    const line = new RegExp(`^#?${p.baseUrlVar}=(.*)$`, 'm').exec(exampleEnv);
    if (!line) { wrong.push(`${p.name}: ${p.baseUrlVar} not documented`); continue; }
    if (line[1].trim() !== p.baseUrl) {
      wrong.push(`${p.name}: example.env says ${line[1].trim()}, the profile says ${p.baseUrl}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('PEASANT_PROVIDERS in example.env lists only known providers', () => {
  const m = /^PEASANT_PROVIDERS=(.*)$/m.exec(exampleEnv);
  assert.ok(m, 'example.env must set PEASANT_PROVIDERS');
  const unknown = m[1].split(',').map((s) => s.trim()).filter(Boolean)
    .filter((n) => !PROFILE_NAMES.includes(n));
  assert.deepEqual(unknown, [], `example.env names providers with no profile: ${unknown.join(', ')}`);
});

test('a profile claiming verified has a captured response behind it', () => {
  // verified: true is a claim about evidence. Without this, it is a comment.
  const dirs = fs.readdirSync(path.join(REPO, 'docs', 'raw'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith('_providers'))
    .map((e) => path.join(REPO, 'docs', 'raw', e.name));
  const captured = new Set(dirs.flatMap((d) => fs.readdirSync(d))
    .filter((f) => f.endsWith('.sse'))
    .map((f) => f.split('-')[0]));

  const unevidenced = PROFILES.filter((p) => p.verified && !captured.has(p.name)).map((p) => p.name);
  assert.deepEqual(unevidenced, [],
    `these profiles claim verified with no capture in docs/raw/*_providers/: ${unevidenced.join(', ')}`);
});

test('an unverified profile says so in a comment', () => {
  // So nobody trusts a guessed header name because it looked authoritative.
  const vague = [];
  for (const p of PROFILES.filter((x) => !x.verified)) {
    const src = fs.readFileSync(path.join(PROFILE_DIR, `${p.name}.js`), 'utf8');
    if (!/UNVERIFIED/.test(src)) vague.push(p.name);
  }
  assert.deepEqual(vague, [], `these profiles are unverified but do not say so: ${vague.join(', ')}`);
});

test('no provider is named outside profiles/ and the registry', () => {
  // The agent loop must not know who it is talking to. A branch on a provider
  // name is a profile field that has not been written yet.
  const allowed = [
    path.join('src', 'provider', 'profiles'),
    path.join('src', 'provider', 'ProfileRegistry.js'),
    // The probes take a provider on the command line by name, which is the
    // point of them: they are diagnostics run against one provider at a time.
    path.join('bin', 'probe-providers.js'),
    path.join('bin', 'probe-tokens.js'),
  ];
  const offenders = [];

  for (const file of listFiles()) {
    const rel = path.relative(REPO, file);
    if (allowed.some((a) => rel.startsWith(a))) continue;
    // Import specifiers legitimately contain a provider name; statements do not.
    const { clean } = scanSource(fs.readFileSync(file, 'utf8'));
    const body = clean.replace(/^\s*(?:import|export)\b[^\n;]*;?$/gm, '');
    const hit = namesIn(body)[0];
    if (hit) offenders.push(`${rel}: ${hit}`);
  }
  assert.deepEqual(offenders, [],
    `provider names must not appear outside profiles/: ${offenders.join(', ')}`);
});

// Whole tokens, not substrings.
//
// `\banthropic\b` matched `anthropic-version` -- the Anthropic Messages
// format's own header name, which `dialects/messages.js` has to send literally
// and which is a fact about the *format*, not a branch on a provider. A
// hyphenated compound is a different word from the name inside it, and
// `claude-code` still matches itself exactly because it is compared whole.
function namesIn(text) {
  const wanted = new Set(PROFILE_NAMES.map((n) => n.toLowerCase()));
  return (text.match(/[A-Za-z0-9_-]+/g) ?? []).filter((t) => wanted.has(t.toLowerCase()));
}

test('the provider-name scan still catches what it is for', () => {
  // A guard that scrapes source needs its own test that the scraping works, or
  // it goes blind rather than red -- CLAUDE.md, and scanner.test.js exists for
  // exactly this reason one level down.
  assert.deepEqual(namesIn('if (name === "groq") special();'), ['groq'],
    'a bare provider name must still be caught');
  assert.deepEqual(namesIn("headers['anthropic-version'] = v;"), [],
    'a hyphenated compound is not a reference to the provider inside it');
  assert.deepEqual(namesIn('const p = "claude-code";'), ['claude-code'],
    'a hyphenated provider name must still match itself');
  assert.deepEqual(namesIn('const groqClient = 1;'), [],
    'a longer identifier is not the name');
});

test('the scan found profiles to check', () => {
  assert.ok(PROFILES.length >= 2, 'no profiles registered -- this guard is blind');
});
