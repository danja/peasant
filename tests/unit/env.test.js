import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, read, load, require_, redact, configFiles, sourceOf, problemsOf } from '../../src/config/Env.js';

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
  const merged = load({ files: [f], env: { A: 'from-env' } });
  assert.equal(merged.A, 'from-env', 'an exported variable is a deliberate act; a file is a default');
  assert.equal(merged.B, 'from-file');
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

test('an empty environment variable does not mask a file value', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-')), '.env');
  fs.writeFileSync(f, 'A=from-file\n');
  assert.equal(load({ files: [f], env: { A: '' } }).A, 'from-file');
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

test('a user-level config is found, not only the working directory', (t) => {
  // The bug this pins: the working directory is the *workspace* -- somebody
  // else's project -- and keys belong with peasant, not copied into every
  // repository it is pointed at. Reading only ./.env meant peasant worked in
  // its own directory and nowhere else.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-cwd-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });

  fs.mkdirSync(path.join(home, '.config', 'peasant'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'peasant', '.env'), 'GROQ_API_KEY=user-level\n');

  const values = load({ files: configFiles({ env: {}, cwd, home }), env: {} });
  assert.equal(values.GROQ_API_KEY, 'user-level');
});

test('a project .env overrides the user-level one', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-cwd-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });

  fs.mkdirSync(path.join(home, '.config', 'peasant'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'peasant', '.env'), 'GROQ_MODEL=user\nGROQ_API_KEY=shared\n');
  fs.writeFileSync(path.join(cwd, '.env'), 'GROQ_MODEL=project\n');

  const values = load({ files: configFiles({ env: {}, cwd, home }), env: {} });
  assert.equal(values.GROQ_MODEL, 'project', 'a repository may pin a model for work done in it');
  assert.equal(values.GROQ_API_KEY, 'shared', 'without having to restate the key');
});

test('an empty value in a later file does not blank a real one', (t) => {
  // The trap this closes: example.env ships every key empty, so copying it
  // into a project directory disabled every key from the user's own config.
  // "Fill this in" and "unset this" look identical in a .env file, and only
  // one of them is ever meant.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const user = path.join(dir, 'user.env');
  const project = path.join(dir, 'project.env');
  fs.writeFileSync(user, 'GROQ_API_KEY=real\nGROQ_MODEL=from-user\n');
  fs.writeFileSync(project, 'GROQ_API_KEY=\nGROQ_MODEL=from-project\n');

  const values = load({ files: [user, project], env: {} });
  assert.equal(values.GROQ_API_KEY, 'real', 'an empty placeholder must not erase a key');
  assert.equal(values.GROQ_MODEL, 'from-project', 'but a real value still overrides');
  assert.equal(sourceOf(values, 'GROQ_API_KEY'), user);
});

test('an empty value still registers a key nothing else has set', (t) => {
  // So "no account yet" stays distinguishable from "the name is misspelt".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'a.env');
  fs.writeFileSync(f, 'NVIDIA_API_KEY=\n');
  const values = load({ files: [f], env: {} });
  assert.ok('NVIDIA_API_KEY' in values);
  assert.equal(values.NVIDIA_API_KEY, '');
});

test('config files are searched in increasing precedence', () => {
  const files = configFiles({ env: {}, cwd: '/work', home: '/home/x' });
  assert.deepEqual(files, ['/home/x/.config/peasant/.env', '/home/x/.peasant/.env', '/work/.env']);
});

test('PEASANT_HOME and XDG_CONFIG_HOME are honoured', () => {
  assert.equal(configFiles({ env: { PEASANT_HOME: '/custom' }, cwd: '/w', home: '/h' })[0], '/custom/.env');
  assert.equal(configFiles({ env: { PEASANT_HOME: '~/kit' }, cwd: '/w', home: '/h' })[0], '/h/kit/.env');
  assert.equal(configFiles({ env: { XDG_CONFIG_HOME: '/xdg' }, cwd: '/w', home: '/h' })[0], '/xdg/peasant/.env');
});

test('sourceOf says where a setting came from', (t) => {
  // "It works in one directory and not another" is otherwise a long afternoon.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, 'FROM_FILE=1\n');
  const values = load({ files: [f], env: { FROM_ENV: '2' } });
  assert.equal(sourceOf(values, 'FROM_FILE'), f);
  assert.equal(sourceOf(values, 'FROM_ENV'), 'environment');
  assert.equal(sourceOf(values, 'ABSENT'), null);
});

test('an unreadable file is skipped and named, not fatal', (t) => {
  // The bug this pins: a `.env` belonging to the *project being worked on* --
  // full of shell peasant has no business understanding -- took down startup
  // and threw away perfectly good keys from the user's own config. Whose file
  // it is decides how strict to be about it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const good = path.join(dir, 'good.env');
  const bad = path.join(dir, 'bad.env');
  fs.writeFileSync(good, 'GROQ_API_KEY=kept\n');
  fs.writeFileSync(bad, 'GROQ_MODEL=fine\nexport SOMETHING\n');

  const values = load({ files: [good, bad], env: {} });
  assert.equal(values.GROQ_API_KEY, 'kept', 'the readable file still counts');
  assert.equal(values.GROQ_MODEL, undefined, 'and the unreadable one contributes nothing');

  const problems = problemsOf(values);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /bad\.env:2: cannot parse/);
  assert.match(problems[0], /skipped/);
});

test('a readable file after an unreadable one is still read', (t) => {
  // Order matters: giving up at the first bad file would lose the later ones.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.env'), 'oops no equals\n');
  fs.writeFileSync(path.join(dir, 'b.env'), 'GROQ_API_KEY=kept\n');
  const values = load({ files: [path.join(dir, 'a.env'), path.join(dir, 'b.env')], env: {} });
  assert.equal(values.GROQ_API_KEY, 'kept');
});

test('nothing wrong means no problems reported', () => {
  assert.deepEqual(problemsOf(load({ files: [], env: {} })), []);
});

test('parse itself is still strict, because that is where the error is useful', () => {
  // load() decides what to do about a bad file; parse() still says exactly
  // what is wrong with it.
  assert.throws(() => parse('A=1\nnonsense\n'), /:2: cannot parse/);
});

test('a missing config file is not an error', () => {
  assert.deepEqual(Object.keys(load({ files: ['/nowhere/.env'], env: {} })), []);
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
