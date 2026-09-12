// .gitignore must not exclude a file a test reads.
//
// This repository started from the stock Node .gitignore, which excludes *.log
// and *.pid. Recorded SSE streams and provider transcripts are exactly what
// gets saved under a .log name by accident, and the failure mode is a test that
// passes here and fails on a fresh clone -- the worst kind, because the machine
// that can reproduce it is the one nobody is using.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { REPO } from './lib/scan.js';

// check-ignore answers for paths that do not exist yet, which is the point:
// this guards the convention, not the current contents of the tree.
function isIgnored(relPath) {
  const r = spawnSync('git', ['check-ignore', '-q', relPath], { cwd: REPO });
  if (r.error) return null;
  return r.status === 0;
}

const gitAvailable = isIgnored('package.json') !== null;

test('fixtures survive the stock *.log and *.pid rules', (t) => {
  if (!gitAvailable) return t.skip('git not available to evaluate .gitignore');
  const mustBeTracked = [
    'tests/unit/fixtures/groq-stream.log',
    'tests/unit/fixtures/mistral-toolcall.log',
    'tests/provider/fixtures/rate-limit.log',
    'tests/unit/sse.fixture.log',
  ];
  const wrongly = mustBeTracked.filter((p) => isIgnored(p));
  assert.deepEqual(wrongly, [],
    `.gitignore excludes fixture paths -- a fresh clone would fail: ${wrongly.join(', ')}`);
});

test('stray logs elsewhere are still ignored', (t) => {
  if (!gitAvailable) return t.skip('git not available to evaluate .gitignore');
  // The negation must be narrow. If this stops being ignored, the rule was
  // written too broadly and real noise will start getting committed.
  for (const p of ['debug.log', 'src/run.log', 'node_modules/', '.env']) {
    assert.ok(isIgnored(p), `${p} should still be ignored`);
  }
});

test('nothing the package ships is ignored', (t) => {
  if (!gitAvailable) return t.skip('git not available to evaluate .gitignore');
  // package.json `files` names what reaches a user. An ignored path there means
  // a published package missing a file that works fine locally.
  const wrongly = ['bin/peasant.js', 'src/agent/Loop.js', 'README.md', 'LICENSE']
    .filter((p) => isIgnored(p));
  assert.deepEqual(wrongly, [], `shipped paths are gitignored: ${wrongly.join(', ')}`);
});
