// The guard that scrapes source needs its own test, or it goes blind rather
// than red. Every case here is one the dependency guard depends on being right.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractImports, scanSource, isPermitted, listFiles } from './lib/scan.js';

test('extracts every import form', () => {
  const src = `
    import fs from 'node:fs';
    import { a, b } from "./local.js";
    import '../side-effect.js';
    import def, { named as alias } from 'node:path';
    export { x } from './re-export.js';
    export * from 'node:url';
    const m = await import('node:os');
    const r = require('node:util');
  `;
  const got = extractImports(src).sort();
  assert.deepEqual(got, [
    '../side-effect.js', './local.js', './re-export.js',
    'node:fs', 'node:os', 'node:path', 'node:url', 'node:util',
  ]);
});

test('handles a multi-line import clause', () => {
  const src = `import {\n  one,\n  two,\n} from 'node:assert';`;
  assert.deepEqual(extractImports(src), ['node:assert']);
});

test('ignores specifiers inside comments', () => {
  const src = `
    // import evil from 'left-pad';
    /* import worse from 'chalk'; */
    import ok from 'node:fs';
  `;
  assert.deepEqual(extractImports(src), ['node:fs']);
});

test('ignores specifiers inside string literals', () => {
  const src = `const doc = "import x from 'express'"; import fs from 'node:fs';`;
  assert.deepEqual(extractImports(src), ['node:fs']);
});

test('does not lose code to an escaped quote', () => {
  const src = `const s = 'it\\'s fine'; import fs from 'node:fs';`;
  assert.deepEqual(extractImports(src), ['node:fs']);
});

test('scanning preserves offsets and line count', () => {
  const src = `const a = 1; // note\nconst b = "text";\n/* two\nlines */\n`;
  const { clean } = scanSource(src);
  assert.equal(clean.length, src.length, 'clean source must be the same length');
  assert.equal(clean.split('\n').length, src.split('\n').length, 'line count must survive');
  assert.ok(clean.includes('"text"'), 'string contents must survive -- specifiers live in them');
  assert.ok(!clean.includes('note'), 'comment bodies must not survive');
});

test('string ranges cover the literal content only', () => {
  const { strings } = scanSource(`const a = "xy";`);
  assert.equal(strings.length, 1);
  assert.equal(strings[0].start, 11);
  assert.equal(strings[0].end, 13);
});

test('an unterminated string does not hang or swallow the file', () => {
  const { clean } = scanSource(`import fs from 'node:fs';\nconst broken = "oops`);
  assert.ok(clean.includes('node:fs'));
});

test('a quote or backtick inside a regex does not open a string', () => {
  // The bug this pins, found by the provider guard reporting a name that was
  // only ever in a comment: a regex character class containing a backtick was
  // read as a template literal opener, so every comment after it survived the
  // strip. A guard that scrapes source needs its own test, and this is why.
  const src = [
    "const symbols = /[{}()[\\];=<>+*/\\\\|&^%$#@~`_-]/;",
    "// import evil from 'left-pad';",
    "import fs from 'node:fs';",
  ].join('\n');
  assert.deepEqual(extractImports(src), ['node:fs']);
});

test('an apostrophe inside a regex does not swallow the file', () => {
  const src = "const re = /don't/;\n// import evil from 'chalk';\nimport fs from 'node:fs';";
  assert.deepEqual(extractImports(src), ['node:fs']);
});

test('division is not mistaken for a regex', () => {
  // The other half of the ambiguity: getting this wrong would blank real code.
  const src = "const ratio = total / count;\nconst half = (a + b) / 2;\nimport fs from 'node:fs';";
  const { clean } = scanSource(src);
  assert.ok(clean.includes('total / count'), 'division must survive');
  assert.ok(clean.includes('/ 2'), 'division after a bracket must survive');
  assert.deepEqual(extractImports(src), ['node:fs']);
});

test('a regex after a keyword is recognised', () => {
  const src = "function f(s) { return /a'b/.test(s); }\n// import x from 'chalk';\nimport fs from 'node:fs';";
  assert.deepEqual(extractImports(src), ['node:fs']);
});

test('an escaped slash inside a regex does not end it early', () => {
  const src = "const re = /a\\/b'c/;\n// import x from 'chalk';\nimport fs from 'node:fs';";
  assert.deepEqual(extractImports(src), ['node:fs']);
});

test('the scanner survives the real source files it has to read', () => {
  // Every shipped file, scanned. A regex somewhere that breaks the scan would
  // otherwise show up as a mystery failure in an unrelated guard.
  for (const file of listFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    const { clean } = scanSource(src);
    assert.equal(clean.length, src.length, `${file}: length changed`);
    assert.equal(clean.split('\n').length, src.split('\n').length, `${file}: line count changed`);
  }
});

test('isPermitted allows builtins and relative paths only', () => {
  for (const s of ['node:fs', 'node:test', './x.js', '../y/z.js']) {
    assert.ok(isPermitted(s), `${s} should be permitted`);
  }
  for (const s of ['fs', 'express', '@scope/pkg', 'chalk', '/abs/path.js']) {
    assert.ok(!isPermitted(s), `${s} should be refused`);
  }
});
