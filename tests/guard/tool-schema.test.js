// A tool's advertised schema is the schema that validates its arguments.
//
// Two copies would drift, and the drift shows up as a model being told one
// thing and refused for doing it -- which it cannot diagnose and will simply
// repeat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './lib/scan.js';
import { TOOLS, TOOL_NAMES, byName, specs } from '../../src/tools/registry.js';

const TOOL_DIR = path.join(REPO, 'src', 'tools');
const INFRASTRUCTURE = ['Tool.js', 'registry.js', 'schema.js', 'paths.js'];

test('every file in src/tools is registered', () => {
  const files = fs.readdirSync(TOOL_DIR)
    .filter((f) => f.endsWith('.js') && !INFRASTRUCTURE.includes(f))
    .map((f) => f.replace(/\.js$/, ''));
  const unregistered = files.filter((f) => !TOOL_NAMES.includes(f));
  assert.deepEqual(unregistered, [], `src/tools contains tools nothing can reach: ${unregistered.join(', ')}`);
});

test('every registered tool has a file', () => {
  const missing = TOOL_NAMES.filter((n) => !fs.existsSync(path.join(TOOL_DIR, `${n}.js`)));
  assert.deepEqual(missing, []);
});

test('the schema sent to the model is the schema that validates', () => {
  for (const tool of TOOLS) {
    assert.equal(tool.spec.function.parameters, tool.parameters,
      `${tool.name}: spec and validator must be the same object, not copies`);
    assert.equal(tool.spec.function.name, tool.name);
    assert.equal(tool.spec.function.description, tool.description);
  }
});

test('every tool declares whether it changes anything', () => {
  // The permission policy reads this. A tool that forgot to declare it would
  // default to something, and either default is wrong.
  for (const tool of TOOLS) {
    assert.equal(typeof tool.mutates, 'boolean', `${tool.name}`);
  }
  assert.deepEqual(TOOLS.filter((t) => t.mutates).map((t) => t.name).sort(),
    ['bash', 'edit', 'write'],
    'if this changed, the permission prompt covers a different set of actions than it did');
});

test('every parameter has a description, because the model chooses by it', () => {
  for (const tool of TOOLS) {
    for (const [name, sub] of Object.entries(tool.parameters.properties)) {
      assert.ok(sub.description, `${tool.name}.${name} has no description`);
    }
  }
});

test('every tool refuses arguments its schema forbids', () => {
  for (const tool of TOOLS) {
    const required = tool.parameters.required ?? [];
    if (required.length === 0) continue;
    assert.throws(() => tool.prepare({}), /invalid arguments/, `${tool.name} accepted empty arguments`);
  }
});

test('every tool refuses a parameter it does not declare', () => {
  // additionalProperties: false everywhere, so a model inventing a parameter is
  // told so rather than having it silently ignored.
  for (const tool of TOOLS) {
    assert.equal(tool.parameters.additionalProperties, false, `${tool.name} allows undeclared parameters`);
  }
});

test('tool names are unique and lower snake case', () => {
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length, 'duplicate tool name');
  for (const n of TOOL_NAMES) assert.match(n, /^[a-z][a-z0-9_]*$/);
});

test('tools are frozen, so nothing can rewrite a schema at runtime', () => {
  for (const tool of TOOLS) assert.ok(Object.isFrozen(tool), tool.name);
});

test('specs() produces one entry per tool in the provider shape', () => {
  const s = specs();
  assert.equal(s.length, TOOLS.length);
  for (const entry of s) {
    assert.equal(entry.type, 'function');
    assert.ok(entry.function.name && entry.function.description && entry.function.parameters);
  }
});

test('byName refuses an unknown tool and lists the known ones', () => {
  assert.equal(byName('read').name, 'read');
  assert.throws(() => byName('reed'), /unknown tool "reed"\. Known: read, write/);
});

test('the scan found tools to check', () => {
  assert.ok(TOOLS.length >= 5, 'this guard is blind');
});
