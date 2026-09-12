import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, newId, sessionsDir } from '../../src/session/Store.js';
import { Conversation } from '../../src/agent/Conversation.js';

function store(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { store: Store.open({ env: {}, home }), home };
}

test('sessions live under the home directory, or PEASANT_HOME', () => {
  assert.equal(sessionsDir({}, '/home/x'), '/home/x/.peasant/sessions');
  assert.equal(sessionsDir({ PEASANT_HOME: '/kit' }, '/home/x'), '/kit/sessions');
  assert.equal(sessionsDir({ PEASANT_HOME: '~/kit' }, '/home/x'), '/home/x/kit/sessions');
});

test('ids sort chronologically, so listing is a directory read', () => {
  const early = newId(new Date('2026-01-01T00:00:00Z'));
  const late = newId(new Date('2026-06-01T00:00:00Z'));
  assert.ok(early < late);
  assert.match(early, /^\d{8}T\d{6}-[a-z0-9]{6}$/);
  // Two in the same second must still differ.
  const now = new Date();
  assert.notEqual(newId(now), newId(now));
});

test('a session round-trips its messages', (t) => {
  const { store: s } = store(t);
  const session = s.create({ root: '/work' });
  session.message({ role: 'user', content: 'hello' });
  session.message({ role: 'assistant', content: 'hi' });

  const { meta, messages } = s.read(session.id);
  assert.equal(meta.root, '/work');
  assert.equal(meta.version, 1);
  assert.deepEqual(messages, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]);
});

test('a reset replaces history, which is what compaction does', (t) => {
  const { store: s } = store(t);
  const session = s.create({ root: '/work' });
  for (let i = 0; i < 5; i++) session.message({ role: 'user', content: `m${i}` });
  session.reset([{ role: 'user', content: 'summary' }], { reason: 'compacted' });
  session.message({ role: 'assistant', content: 'after' });

  const { messages } = s.read(session.id);
  assert.deepEqual(messages.map((m) => m.content), ['summary', 'after'],
    'everything before the reset is superseded');
});

test('a truncated final line is skipped rather than fatal', (t) => {
  // The only way one gets there is a process dying mid-write, and the line it
  // was writing is the one thing nobody needs.
  const { store: s } = store(t);
  const session = s.create({ root: '/work' });
  session.message({ role: 'user', content: 'kept' });
  fs.appendFileSync(session.file, '{"type":"message","message":{"role":"user","con');

  const { messages } = s.read(session.id);
  assert.deepEqual(messages.map((m) => m.content), ['kept']);
});

test('sync records only what is new', (t) => {
  const { store: s } = store(t);
  const session = s.create({ root: '/work' });
  const c = new Conversation({ system: 'be helpful' }).user('one');

  let known = session.sync(c.messages, 0);
  assert.equal(known, 2);

  c.assistant({ content: 'two' });
  known = session.sync(c.messages, known);
  assert.equal(known, 3);

  const { messages } = s.read(session.id);
  assert.equal(messages.length, 3, 'nothing was written twice');
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant']);
});

test('the system message is persisted, or a resumed session loses its instructions', (t) => {
  // The bug this pins: the session loop recorded from the current length
  // rather than from zero, so the system message -- written before anything
  // else -- was never saved. A resumed session had no instructions at all, and
  // nothing said so.
  const { store: s } = store(t);
  const session = s.create({ root: '/work' });
  const c = new Conversation({ system: 'be helpful' }).user('hello');

  session.sync(c.messages, 0);
  const { messages } = s.read(session.id);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, 'be helpful');
  assert.equal(messages.length, 2);
});

test('a conversation survives a round trip through the store', (t) => {
  const { store: s } = store(t);
  const session = s.create({ root: '/work' });
  const original = new Conversation({ system: 's' });
  original.user('ask');
  original.assistant({ content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a"}' }] });
  original.toolResult('c1', 'contents');
  original.assistant({ content: 'done' });

  session.sync(original.messages, 0);
  const restored = Conversation.fromJSON(s.read(session.id).messages);

  assert.deepEqual(restored.messages, original.messages);
  assert.deepEqual(restored.pendingToolCalls, [], 'and it is valid to continue');
  assert.doesNotThrow(() => restored.user('and again'));
});

test('listing is newest first and says what each session was about', (t) => {
  const { store: s } = store(t);
  const a = s.create({ root: '/work', id: '20260101T000000-aaaaaa' });
  a.message({ role: 'user', content: 'the first question\nwith more lines' });
  const b = s.create({ root: '/other', id: '20260601T000000-bbbbbb' });
  b.message({ role: 'user', content: 'the second question' });

  const listed = s.list();
  assert.deepEqual(listed.map((x) => x.id), [b.id, a.id]);
  assert.equal(listed[1].summary, 'the first question', 'the first line is what makes it recognisable');
  assert.equal(listed[1].root, '/work');
});

test('resume finds the latest session for this workspace, not any workspace', (t) => {
  // Resuming a conversation about a different repository is never what anyone
  // meant.
  const { store: s } = store(t);
  s.create({ root: '/work', id: '20260101T000000-aaaaaa' }).message({ role: 'user', content: 'old work' });
  s.create({ root: '/other', id: '20260301T000000-bbbbbb' }).message({ role: 'user', content: 'other' });
  s.create({ root: '/work', id: '20260601T000000-cccccc' }).message({ role: 'user', content: 'new work' });

  assert.equal(s.latestFor('/work').id, '20260601T000000-cccccc');
  assert.equal(s.latestFor('/other').id, '20260301T000000-bbbbbb');
  assert.equal(s.latestFor('/nowhere'), null);
});

test('an empty store lists nothing rather than failing', (t) => {
  const { store: s } = store(t);
  assert.deepEqual(s.list(), []);
  assert.equal(s.latestFor('/work'), null);
});

test('an unreadable session does not break the listing of the others', (t) => {
  const { store: s } = store(t);
  s.create({ root: '/work', id: '20260101T000000-aaaaaa' }).message({ role: 'user', content: 'fine' });
  fs.writeFileSync(path.join(s.dir, '20260202T000000-broken.jsonl'), 'not json at all\n');
  const listed = s.list();
  assert.ok(listed.some((x) => x.id === '20260101T000000-aaaaaa'));
});

test('session files are not world readable', (t) => {
  // They contain whatever the workspace contains, which may be anything.
  const { store: s } = store(t);
  const session = s.create({ root: '/work' });
  const mode = fs.statSync(session.file).mode & 0o777;
  assert.equal(mode & 0o077, 0, `mode was ${mode.toString(8)}`);
});

test('opening a session that does not exist says so', (t) => {
  const { store: s } = store(t);
  assert.throws(() => s.open('nope'), /no session nope/);
});

test('a session saved mid-turn can be resumed', (t) => {
  // An interrupted session can have unanswered tool calls. Restoring one and
  // continuing would refuse every message, so resume closes the orphans off.
  const { store: s } = store(t);
  const session = s.create({ root: '/work' });
  const c = new Conversation({ system: 's' }).user('ask');
  c.assistant({ toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] });
  session.sync(c.messages, 0);

  const restored = Conversation.fromJSON(s.read(session.id).messages);
  assert.deepEqual(restored.pendingToolCalls, ['c1']);
  assert.throws(() => restored.user('again'), /unanswered/);

  restored.abandonPending('the session was interrupted and resumed');
  assert.doesNotThrow(() => restored.user('again'));
});

test('a failed write does not end the session', (t) => {
  // Persistence is a convenience. Losing it must not lose the conversation.
  const { store: s } = store(t);
  const session = s.create({ root: '/work' });
  fs.rmSync(s.dir, { recursive: true, force: true });
  assert.doesNotThrow(() => session.message({ role: 'user', content: 'x' }));
});
