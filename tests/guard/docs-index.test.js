// docs/index.md must list every standing document.
//
// CLAUDE.md instructs keeping the index current when adding a document, and a
// rule worth stating is worth a test. The failure is quiet in both directions:
// an unlisted document is one nobody finds, and a listed one that no longer
// exists is a link that misleads whoever follows it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './lib/scan.js';

const DOCS = path.join(REPO, 'docs');
const INDEX = path.join(DOCS, 'index.md');
const index = fs.readFileSync(INDEX, 'utf8');

// Only top-level docs/*.md are standing documents. entries/ and raw/ are
// append-only collections, listed as directories rather than file by file.
const standing = fs.readdirSync(DOCS, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'index.md')
  .map((e) => e.name);

test('every standing document is listed in docs/index.md', () => {
  const missing = standing.filter((name) => !index.includes(`(${name})`));
  assert.deepEqual(missing, [],
    `add these to docs/index.md: ${missing.join(', ')}`);
});

test('every link in docs/index.md resolves', () => {
  const targets = [...index.matchAll(/\]\(([^)#]+)\)/g)].map((m) => m[1]);
  const broken = targets.filter((t) => {
    if (/^https?:/.test(t)) return false;
    return !fs.existsSync(path.resolve(DOCS, t));
  });
  assert.deepEqual(broken, [], `docs/index.md points at things that do not exist: ${broken.join(', ')}`);
});

test('the scan found documents to check', () => {
  assert.ok(standing.length > 0, 'no standing documents found -- this guard is blind');
});
