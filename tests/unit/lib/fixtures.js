// The SSE fixtures are the raw captures written by bin/probe-providers.js and
// kept in docs/raw/ as dated evidence. The tests read them from there rather
// than keeping a copy: one file, so re-probing cannot leave the tests asserting
// against a shape no provider produces any more.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(fileURLToPath(import.meta.url), '../../../..');
const RAW = path.join(REPO, 'docs', 'raw');

// Newest capture directory wins, so adding a fresh probe run updates the tests.
export function captureDir() {
  const dirs = fs.readdirSync(RAW, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith('_providers'))
    .map((e) => e.name)
    .sort();
  if (dirs.length === 0) {
    throw new Error('no provider capture in docs/raw/*_providers -- run: node bin/probe-providers.js');
  }
  return path.join(RAW, dirs[dirs.length - 1]);
}

export function listCaptures() {
  const dir = captureDir();
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sse'))
    .map((f) => ({ name: f, path: path.join(dir, f) }));
}

export function readCapture(name) {
  return fs.readFileSync(path.join(captureDir(), name));
}
