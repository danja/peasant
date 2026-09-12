// No native addons, no WASM, no prebuilt binaries -- ever.
//
// The target CPU is below the baseline that prebuilt x86-64 artefacts are
// compiled for. A .node or .wasm blob in the tree is a SIGILL waiting for a
// user, and it will not announce itself at install time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, SHIPPED_DIRS, listFiles } from './lib/scan.js';

const BANNED_EXT = ['.node', '.wasm', '.so', '.dylib', '.dll', '.a', '.o', '.exe'];

test('no compiled artefacts under bin/ or src/', () => {
  const all = listFiles(SHIPPED_DIRS, null);
  const bad = all.filter((f) => BANNED_EXT.includes(path.extname(f).toLowerCase()));
  assert.deepEqual(bad.map((f) => path.relative(REPO, f)), []);
});

test('no ELF or Mach-O binaries under bin/ or src/, whatever they are named', () => {
  // An extension is a convention; a magic number is a fact.
  const MAGIC = [
    { name: 'ELF', bytes: [0x7f, 0x45, 0x4c, 0x46] },
    { name: 'WASM', bytes: [0x00, 0x61, 0x73, 0x6d] },
    { name: 'Mach-O', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
    { name: 'PE', bytes: [0x4d, 0x5a] },
  ];
  const bad = [];
  for (const file of listFiles(SHIPPED_DIRS, null)) {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    for (const m of MAGIC) {
      if (m.bytes.every((b, i) => head[i] === b)) bad.push(`${path.relative(REPO, file)} (${m.name})`);
    }
  }
  assert.deepEqual(bad, []);
});

test('no build scripts that could compile one', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  for (const hook of ['install', 'preinstall', 'postinstall', 'gypfile']) {
    assert.equal(pkg.scripts?.[hook], undefined, `package.json must not define a ${hook} script`);
  }
  assert.ok(!fs.existsSync(path.join(REPO, 'binding.gyp')), 'binding.gyp must not exist');
});
