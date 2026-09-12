// The two search engines must give identical answers.
//
// Otherwise the same query gives two people different results depending on
// whether they happen to have ripgrep installed, which is the worst kind of
// bug: it works on your machine, and the difference is invisible.
//
// This is the test CLAUDE.md means by "write the test that binds them". It runs
// BOTH engines over the same tree and compares, rather than testing whichever
// one is present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as js from '../../src/tools/search/js.js';
import * as rg from '../../src/tools/search/rg.js';
import { detect, engineName } from '../../src/tools/search/index.js';

const probe = spawnSync('rg', ['--version'], { encoding: 'utf8', timeout: 5000 });
const HAVE_RG = !probe.error && probe.status === 0;

// A workspace containing every case the two engines could disagree about.
function tricky(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-parity-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const write = (rel, content) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  write('README.md', 'target in readme\n');
  write('src/a.js', 'const x = 1;\nconst target = 2;\n');
  write('src/B.js', 'target uppercase filename\n');       // sort order: bytes, not locale
  write('src/deep/c.js', 'target deeper\n');
  write('src.txt', 'target in a file named like the directory\n'); // '.' vs '/' ordering
  write('node_modules/pkg/d.js', 'target in a dependency\n');      // never searched
  write('dist/e.js', 'target in a build directory\n');             // never searched
  write('.hidden', 'target hidden\n');                             // skipped while walking
  write('.github/w.yml', 'target in a workflow\n');                // also skipped while walking
  write('.gitignore', 'ignored.txt\n');
  write('ignored.txt', 'target in a gitignored file\n');           // searched anyway
  write('LONG.txt', `target ${'x'.repeat(900)}\n`);                // line truncation
  write('case.txt', 'TARGET upper\n');
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.concat([
    Buffer.from('target binary'), Buffer.from([0, 1, 2]),
  ]));
  return root;
}

const CASES = [
  { name: 'plain match', options: { pattern: 'target' } },
  { name: 'case insensitive', options: { pattern: 'target', ignoreCase: true } },
  { name: 'include glob', options: { pattern: 'target', include: '**/*.js' } },
  { name: 'include glob, single segment', options: { pattern: 'target', include: '*.md' } },
  { name: 'anchored pattern', options: { pattern: '^const target' } },
  { name: 'character class', options: { pattern: 'targ[e]t' } },
  { name: 'no matches at all', options: { pattern: 'nothingmatchesthis' } },
  { name: 'matches a filename-like pattern', options: { pattern: 'x = 1' } },
];

async function bothEngines(root, from, options) {
  const request = { root, from, ceiling: 2000, ignoreCase: false, include: undefined, ...options };
  return {
    js: await js.search(request),
    rg: await rg.search(request),
  };
}

const normalise = (result) => result.matches
  .map((m) => `${m.file}:${m.line}:${m.text}`)
  .sort();

test('ripgrep is available to test parity against', () => {
  // If this is the only failure, parity is simply untested on this machine --
  // which is worth knowing rather than passing silently.
  assert.ok(HAVE_RG, 'ripgrep not installed; the parity of the two engines cannot be checked here');
});

for (const { name, options } of CASES) {
  test(`parity: ${name}`, async (t) => {
    if (!HAVE_RG) return t.skip('ripgrep not installed');
    const root = tricky(t);
    const { js: a, rg: b } = await bothEngines(root, root, options);
    assert.deepEqual(normalise(b), normalise(a), `engines disagree on ${name}`);
  });
}

test('parity: a dot-directory given explicitly is searched by both', async (t) => {
  if (!HAVE_RG) return t.skip('ripgrep not installed');
  const root = tricky(t);
  const from = path.join(root, '.github');
  const { js: a, rg: b } = await bothEngines(root, from, { pattern: 'target' });
  assert.deepEqual(normalise(b), normalise(a));
  assert.equal(a.matches.length, 1, 'and it does find the workflow');
});

test('parity: a subdirectory search agrees', async (t) => {
  if (!HAVE_RG) return t.skip('ripgrep not installed');
  const root = tricky(t);
  const { js: a, rg: b } = await bothEngines(root, path.join(root, 'src'), { pattern: 'target' });
  assert.deepEqual(normalise(b), normalise(a));
});

test('both engines skip dependencies, build output and binaries', async (t) => {
  const root = tricky(t);
  const engines = HAVE_RG ? [js, rg] : [js];
  for (const engine of engines) {
    const { matches } = await engine.search({ root, from: root, pattern: 'target', ceiling: 2000 });
    const files = matches.map((m) => m.file);
    assert.ok(!files.some((f) => f.startsWith('node_modules')), `${engine.name} searched node_modules`);
    assert.ok(!files.some((f) => f.startsWith('dist')), `${engine.name} searched dist`);
    assert.ok(!files.includes('bin.dat'), `${engine.name} searched a binary file`);
    assert.ok(!files.some((f) => path.basename(f).startsWith('.')), `${engine.name} searched a dotfile`);
  }
});

test('an include glob never re-enables a skipped directory', async (t) => {
  // The bug this pins, found by the parity test above: in ripgrep the *last*
  // matching glob wins, so passing the caller's include after the exclusions
  // put node_modules and dist back in. Grepping a dependency tree would spend
  // a minute of token budget in one call.
  const root = tricky(t);
  const engines = HAVE_RG ? [js, rg] : [js];
  for (const engine of engines) {
    const { matches } = await engine.search({
      root, from: root, pattern: 'target', include: '**/*.js', ceiling: 2000,
    });
    const files = matches.map((m) => m.file);
    assert.ok(files.length > 0, `${engine.name} found nothing at all`);
    assert.ok(!files.some((f) => f.startsWith('node_modules')), `${engine.name}: ${files.join(', ')}`);
    assert.ok(!files.some((f) => f.startsWith('dist')), `${engine.name}: ${files.join(', ')}`);
  }
});

test('both engines ignore .gitignore -- it is not a search preference', async (t) => {
  // ripgrep respects it by default and the JavaScript engine does not know
  // about it, so without --no-ignore this is where they would part company.
  const root = tricky(t);
  const engines = HAVE_RG ? [js, rg] : [js];
  for (const engine of engines) {
    const { matches } = await engine.search({ root, from: root, pattern: 'target', ceiling: 2000 });
    assert.ok(matches.some((m) => m.file === 'ignored.txt'), `${engine.name} skipped a gitignored file`);
  }
});

test('a pattern ripgrep cannot compile falls back rather than failing', async (t) => {
  if (!HAVE_RG) return t.skip('ripgrep not installed');
  // Rust's regex crate has no lookaround. The pattern is valid JavaScript, and
  // a user should not get an error because of what is installed.
  const root = tricky(t);
  await assert.rejects(
    () => rg.search({ root, from: root, pattern: 'target(?= in readme)', ceiling: 2000 }),
    (e) => e instanceof rg.UnsupportedPattern,
  );

  const { search } = await import('../../src/tools/search/index.js');
  const result = await search({ root, from: root, pattern: 'target(?= in readme)' });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].file, 'README.md');
});

test('detect reports which engine is in use', () => {
  const { version } = detect({ force: true });
  if (HAVE_RG) {
    assert.match(engineName(), /^ripgrep /);
    assert.ok(version);
  } else {
    assert.equal(engineName(), 'javascript');
  }
});

test('results are sorted, so the choice of matches does not depend on walk order', async (t) => {
  const { search } = await import('../../src/tools/search/index.js');
  const root = tricky(t);
  const result = await search({ root, from: root, pattern: 'target' });
  const keys = result.matches.map((m) => `${m.file}:${String(m.line).padStart(6, '0')}`);
  assert.deepEqual(keys, [...keys].sort(), 'matches must come back in a stable order');
});

test('long lines are truncated identically whichever engine ran', async (t) => {
  const { search } = await import('../../src/tools/search/index.js');
  const root = tricky(t);
  const result = await search({ root, from: root, pattern: 'target' });
  const long = result.matches.find((m) => m.file === 'LONG.txt');
  assert.ok(long.text.endsWith('...'));
  assert.ok(long.text.length <= 403, `line was ${long.text.length} characters`);
});
