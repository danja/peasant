// The SSE fixtures are the raw captures written by bin/probe-providers.js and
// kept in docs/raw/ as dated evidence. The tests read them from there rather
// than keeping a copy: one file, so re-probing cannot leave the tests asserting
// against a shape no provider produces any more.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(fileURLToPath(import.meta.url), '../../../..');
const RAW = path.join(REPO, 'docs', 'raw');

function captureDirs() {
  const dirs = fs.readdirSync(RAW, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith('_providers'))
    .map((e) => e.name)
    .sort();
  if (dirs.length === 0) {
    throw new Error('no provider capture in docs/raw/*_providers -- run: node bin/probe-providers.js');
  }
  return dirs.map((d) => path.join(RAW, d));
}

// Every capture, by filename, with the newest run of each file winning.
//
// Resolved per *file*, not per directory. "Newest directory wins" was the
// obvious reading and it was wrong: `probe-providers.js --only nvidia` writes a
// fresh dated directory containing that one provider, and the whole suite lost
// every Groq and Mistral fixture the moment someone re-probed a single
// provider. A capture is evidence about one provider, so a newer run says
// nothing about a provider it did not ask.
function index() {
  const byName = new Map();
  for (const dir of captureDirs()) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sse'))) {
      byName.set(f, path.join(dir, f));
    }
  }
  return byName;
}

export function listCaptures() {
  return [...index()].map(([name, p]) => ({ name, path: p })).sort((a, b) => a.name.localeCompare(b.name));
}

export function readCapture(name) {
  const p = index().get(name);
  if (!p) {
    throw new Error(
      `no capture named ${name} in docs/raw/*_providers -- ` +
      `have: ${[...index().keys()].join(', ') || '(none)'}`,
    );
  }
  return fs.readFileSync(p);
}
