// Nothing outside src/ui/ writes to stdout.
//
// Scattered process.stdout.write is how a terminal UI becomes unfixable. The
// day colour has to be stripped for a pipe, or a redraw has to know what is on
// screen, every one of them has to be found.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, listFiles, scanSource } from './lib/scan.js';

// Each exemption is a deliberate decision with a reason, not a convenience:
//
//   src/ui               -- the layer itself
//   src/compat/Preflight -- runs before the UI is loaded, and a preflight check
//                           that depends on the UI loading cleanly is no defence
//   bin/probe-*          -- standalone diagnostics; a probe that routed output
//                           through the UI could not report a broken UI
const ALLOWED = [
  path.join('src', 'ui'),
  path.join('src', 'compat', 'Preflight.js'),
  path.join('bin', 'probe-runtime.js'),
  path.join('bin', 'probe-providers.js'),
  path.join('bin', 'probe-tokens.js'),
];

const WRITERS = /\b(?:process\.(?:stdout|stderr)\.write|console\.(?:log|info|warn|error|debug|table|dir))\b/;

test('only src/ui writes to the terminal', () => {
  const offenders = [];
  for (const file of listFiles()) {
    const rel = path.relative(REPO, file);
    if (ALLOWED.some((a) => rel === a || rel.startsWith(a + path.sep))) continue;
    const { clean } = scanSource(fs.readFileSync(file, 'utf8'));
    const m = WRITERS.exec(clean);
    if (m) offenders.push(`${rel}: ${m[0]}`);
  }
  assert.deepEqual(offenders, [],
    `terminal output belongs in src/ui/Terminal.js: ${offenders.join(', ')}`);
});

test('escape sequences are declared in Ansi.js and nowhere else', () => {
  // A stray escape somewhere else is a code nobody will find when colour has to
  // be switched off.
  //
  // Comments are stripped first: prose *describing* an escape sequence is not
  // one, and a comment explaining why readline emitted cursor-control codes
  // should not be indistinguishable from emitting them.
  const offenders = [];
  for (const file of listFiles()) {
    const rel = path.relative(REPO, file);
    if (rel === path.join('src', 'ui', 'Ansi.js')) continue;
    const { clean } = scanSource(fs.readFileSync(file, 'utf8'));
    if (/\\x1b\[|\\u001b\[|\\033\[/.test(clean)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `escape sequences outside Ansi.js: ${offenders.join(', ')}`);
});

test('the scan found files to check', () => {
  assert.ok(listFiles().length > 0, 'this guard is blind');
});
