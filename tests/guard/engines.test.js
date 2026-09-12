// package.json's engines.node and docs/runtime-baseline.md are two statements of
// the same fact, and nothing else would notice them disagreeing. The baseline
// document is the source of truth: it is where a measurement gets recorded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './lib/scan.js';

const BASELINE = path.join(REPO, 'docs', 'runtime-baseline.md');

function readBaseline() {
  const src = fs.readFileSync(BASELINE, 'utf8');
  const out = {};
  for (const m of src.matchAll(/<!--\s*baseline:(\w+)\s+(.+?)\s*-->/g)) out[m[1]] = m[2];
  return out;
}

test('docs/runtime-baseline.md exists and declares a floor', () => {
  assert.ok(fs.existsSync(BASELINE), 'docs/runtime-baseline.md is missing');
  const b = readBaseline();
  assert.ok(b.engines, 'runtime-baseline.md must carry a <!-- baseline:engines ... --> marker');
  assert.ok(b.status, 'runtime-baseline.md must carry a <!-- baseline:status ... --> marker');
  assert.ok(['PENDING', 'MEASURED'].includes(b.status), `unknown baseline status ${b.status}`);
});

test('engines.node matches the recorded baseline', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const b = readBaseline();
  assert.equal(pkg.engines?.node, b.engines,
    'package.json engines.node disagrees with docs/runtime-baseline.md -- change the document first');
});
