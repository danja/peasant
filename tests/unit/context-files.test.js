import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadContext, renderContext, userFile, PROJECT_NAMES, MAX_CHARS } from '../../src/agent/context-files.js';
import { systemPrompt } from '../../src/agent/prompt.js';

function workspace(t, files = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-ctx-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-ctxhome-')));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  for (const [name, content] of Object.entries(files)) {
    const full = name.startsWith('~') ? path.join(home, name.slice(2)) : path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return { root, home };
}

test('nothing configured is the normal case, not an error', (t) => {
  const { root, home } = workspace(t);
  const result = loadContext({ root, env: {}, home });
  assert.deepEqual(result.found, []);
  assert.equal(result.chars, 0);
  assert.equal(renderContext(result.found), '');
});

test('a project PEASANT.md is read', (t) => {
  const { root, home } = workspace(t, { 'PEASANT.md': 'Use tabs. Never use semicolons.' });
  const { found } = loadContext({ root, env: {}, home });
  assert.equal(found.length, 1);
  assert.match(found[0].content, /Never use semicolons/);
  assert.match(found[0].label, /PEASANT\.md from this project/);
});

test('AGENTS.md is read when there is no PEASANT.md', (t) => {
  // The cross-tool convention, which many repositories already have.
  const { root, home } = workspace(t, { 'AGENTS.md': 'Run the tests before finishing.' });
  const { found } = loadContext({ root, env: {}, home });
  assert.equal(found.length, 1);
  assert.match(found[0].label, /AGENTS\.md/);
});

test('PEASANT.md wins over AGENTS.md rather than both being sent', (t) => {
  const { root, home } = workspace(t, { 'PEASANT.md': 'the specific one', 'AGENTS.md': 'the general one' });
  const { found } = loadContext({ root, env: {}, home });
  assert.equal(found.length, 1);
  assert.match(found[0].content, /the specific one/);
});

test('CLAUDE.md is deliberately not read', (t) => {
  // It is addressed to a different agent with different tools, and following
  // instructions written for someone else is worse than having none.
  const { root, home } = workspace(t, { 'CLAUDE.md': 'instructions for somebody else' });
  assert.deepEqual(loadContext({ root, env: {}, home }).found, []);
  assert.ok(!PROJECT_NAMES.includes('CLAUDE.md'));
});

test('a personal file applies across every project', (t) => {
  const { root, home } = workspace(t, { '~/.config/peasant/PEASANT.md': 'Always answer in British English.' });
  const { found } = loadContext({ root, env: {}, home });
  assert.equal(found.length, 1);
  assert.match(found[0].label, /your instructions/);
});

test('personal and project instructions are both sent, personal first', (t) => {
  const { root, home } = workspace(t, {
    '~/.config/peasant/PEASANT.md': 'personal preference',
    'PEASANT.md': 'project convention',
  });
  const { found } = loadContext({ root, env: {}, home });
  assert.equal(found.length, 2);
  assert.match(found[0].content, /personal preference/);
  assert.match(found[1].content, /project convention/);
});

test('PEASANT_HOME moves the personal file', (t) => {
  assert.equal(userFile({ env: { PEASANT_HOME: '/kit' }, home: '/h' }), '/kit/PEASANT.md');
  assert.equal(userFile({ env: {}, home: '/h' }), '/h/.config/peasant/PEASANT.md');
});

test('an empty file is skipped rather than sent as nothing', (t) => {
  const { root, home } = workspace(t, { 'PEASANT.md': '   \n\n  ' });
  assert.deepEqual(loadContext({ root, env: {}, home }).found, []);
});

test('an oversized file is capped, and says so', (t) => {
  // Everything here is resent on every turn against a budget of 8,000 tokens a
  // minute. A context file nobody has read the size of is a tax on every
  // request.
  const { root, home } = workspace(t, { 'PEASANT.md': 'x'.repeat(MAX_CHARS + 5000) });
  const { found, notes } = loadContext({ root, env: {}, home });
  assert.ok(found[0].chars <= MAX_CHARS + 100, `kept ${found[0].chars} characters`);
  assert.match(found[0].content, /truncated: 5000 more characters/);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /only the first 8000 are sent/);
});

test('each block says where it came from', (t) => {
  // A model given instructions with no provenance cannot weigh them against
  // the task it was actually asked to do.
  const { root, home } = workspace(t, { 'PEASANT.md': 'the rule' });
  const rendered = renderContext(loadContext({ root, env: {}, home }).found);
  assert.match(rendered, /--- PEASANT\.md from this project \(.*PEASANT\.md\) ---/);
  assert.match(rendered, /the rule/);
});

test('context is appended to the system prompt, not prepended', (t) => {
  // The tool rules are what make the harness work at all, and a project file
  // must not be able to displace them by being read first.
  const prompt = systemPrompt({ root: '/work', context: 'PROJECT RULES HERE' });
  assert.ok(prompt.indexOf('Work by using the tools') < prompt.indexOf('PROJECT RULES HERE'));
  assert.match(prompt, /comes from configuration files, not from the user's message/);
});

test('an empty context leaves the system prompt exactly as it was', (t) => {
  assert.equal(systemPrompt({ root: '/work' }), systemPrompt({ root: '/work', context: '  ' }));
});
