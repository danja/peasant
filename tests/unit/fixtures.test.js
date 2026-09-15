// The capture loader is the one thing standing between the test suite and its
// evidence, and it failed silently once: `--only nvidia` wrote a fresh dated
// directory holding one provider, "newest directory wins" selected it, and
// every Groq and Mistral fixture vanished from the suite at a stroke. The
// symptom was four unrelated tests failing on a missing file.
//
// These assert the contract directly rather than leaving it to be inferred
// from whichever test happens to break next.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listCaptures, readCapture, REPO } from './lib/fixtures.js';

const RAW = path.join(REPO, 'docs', 'raw');

function captureDirs() {
  return fs.readdirSync(RAW, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith('_providers'))
    .map((e) => e.name)
    .sort();
}

test('captures from every probe run are visible, not just the newest run', () => {
  const dirs = captureDirs();
  const everyFile = new Set(
    dirs.flatMap((d) => fs.readdirSync(path.join(RAW, d)).filter((f) => f.endsWith('.sse'))),
  );
  const loaded = new Set(listCaptures().map((c) => c.name));
  const lost = [...everyFile].filter((f) => !loaded.has(f));
  assert.deepEqual(lost, [],
    `these captures exist on disk but the loader cannot see them: ${lost.join(', ')}`);
});

test('a single-provider probe run does not hide the other providers', () => {
  // The exact failure, stated as a property: more than one provider is
  // represented, across however many runs it took to capture them.
  const providers = new Set(listCaptures().map((c) => c.name.split('-')[0]));
  assert.ok(providers.size >= 2,
    `only one provider in the captures (${[...providers].join(', ')}) -- ` +
    'the loader is probably collapsing to one run again');
});

test('the newest run of a given capture wins', () => {
  // Same filename in two dated directories: the later date is the evidence.
  const dirs = captureDirs();
  const byName = new Map();
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(RAW, d)).filter((n) => n.endsWith('.sse'))) {
      byName.set(f, path.join(RAW, d, f));
    }
  }
  for (const { name, path: p } of listCaptures()) {
    assert.equal(p, byName.get(name), `${name} resolved to an older run`);
  }
});

test('an unknown capture names what is available', () => {
  // A missing fixture used to surface as a bare ENOENT from node:fs, which says
  // nothing about which runs exist or what they hold.
  assert.throws(() => readCapture('nosuchprovider-tools.sse'), /no capture named/);
});

test('the loader found captures at all', () => {
  assert.ok(listCaptures().length > 0, 'no captures -- this whole file is blind');
});
