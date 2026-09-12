import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Conversation } from '../../src/agent/Conversation.js';
import { Loop } from '../../src/agent/Loop.js';
import { Policy, DECISION } from '../../src/permission/Policy.js';
import { describe as describeCall, preview } from '../../src/permission/Prompt.js';
import { TOOLS, byName } from '../../src/tools/registry.js';
import { Terminal } from '../../src/ui/Terminal.js';
import { Router } from '../../src/provider/Router.js';
import { OpenAICompatClient } from '../../src/provider/OpenAICompatClient.js';
import { defineProfile } from '../../src/provider/profiles/generic.js';
import { FakeProvider, frameChunks } from './lib/FakeProvider.js';

// --- Conversation ----------------------------------------------------------

test('records a system prompt first, or not at all', () => {
  assert.deepEqual(new Conversation().messages, []);
  assert.deepEqual(new Conversation({ system: 'be brief' }).messages,
    [{ role: 'system', content: 'be brief' }]);
});

test('records assistant tool calls in the provider shape', () => {
  const c = new Conversation();
  c.user('hi').assistant({
    content: '',
    toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a"}' }],
  });
  const m = c.messages.at(-1);
  assert.equal(m.role, 'assistant');
  assert.deepEqual(m.tool_calls, [
    { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
  ]);
});

test('refuses to continue while a tool call is unanswered', () => {
  // Some providers 400 on this and some quietly produce nonsense, so the
  // invariant is enforced here rather than discovered once per provider.
  const c = new Conversation();
  c.user('hi').assistant({ toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] });
  assert.throws(() => c.user('and another thing'), /1 tool call\(s\) are unanswered/);
  assert.throws(() => c.assistant({ content: 'x' }), /unanswered/);
  assert.deepEqual(c.pendingToolCalls, ['c1']);
});

test('refuses a tool result that answers nothing', () => {
  const c = new Conversation();
  c.user('hi').assistant({ toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] });
  assert.throws(() => c.toolResult('c2', 'x'), /does not answer any pending call.*expected one of c1/s);
});

test('answering every call lets the turn continue', () => {
  const c = new Conversation();
  c.user('hi').assistant({
    toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }, { id: 'c2', name: 'ls', arguments: '{}' }],
  });
  c.toolResult('c1', 'one');
  assert.throws(() => c.assistant({ content: 'x' }), /unanswered/);
  c.toolResult('c2', 'two');
  assert.doesNotThrow(() => c.assistant({ content: 'x' }));
  assert.deepEqual(c.pendingToolCalls, []);
});

test('abandoning pending calls keeps the conversation usable', () => {
  // An interrupt mid-turn leaves tool calls unanswered, and a conversation in
  // that state refuses every later message -- so one Ctrl-C would cost the
  // whole session rather than one request.
  const c = new Conversation();
  c.user('hi').assistant({
    toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }, { id: 'c2', name: 'ls', arguments: '{}' }],
  });
  assert.throws(() => c.user('again'), /unanswered/);

  assert.equal(c.abandonPending(), 2);
  assert.deepEqual(c.pendingToolCalls, []);
  assert.doesNotThrow(() => c.user('again'));

  const answers = c.messages.filter((m) => m.role === 'tool');
  assert.deepEqual(answers.map((m) => m.tool_call_id), ['c1', 'c2']);
  assert.match(answers[0].content, /interrupted by the user/);
});

test('abandoning nothing is harmless', () => {
  const c = new Conversation();
  c.user('hi');
  assert.equal(c.abandonPending(), 0);
  assert.equal(c.messages.filter((m) => m.role === 'tool').length, 0);
});

test('reasoning is not sent back to the provider', () => {
  // It is the model's private working, it is most of the token cost, and no
  // provider requires it echoed.
  const c = new Conversation();
  c.assistant({ content: 'answer' });
  assert.ok(!('reasoning' in c.messages.at(-1)));
});

test('round-trips through JSON for the session store', () => {
  const c = new Conversation({ system: 's' });
  c.user('hi').assistant({ content: 'there' });
  assert.deepEqual(Conversation.fromJSON(c.toJSON()).messages, c.messages);
});

// --- Policy ----------------------------------------------------------------

test('reading is never worth interrupting someone for', () => {
  const p = new Policy({ mode: 'ask' });
  for (const t of TOOLS.filter((x) => !x.mutates)) {
    assert.equal(p.decide(t), DECISION.allow, t.name);
  }
});

test('anything that changes something is asked about', () => {
  const p = new Policy({ mode: 'ask' });
  for (const t of TOOLS.filter((x) => x.mutates)) {
    assert.equal(p.decide(t), DECISION.ask, t.name);
  }
});

test('allow and deny modes apply to mutating tools only', () => {
  assert.equal(new Policy({ mode: 'allow' }).decide(byName('bash')), DECISION.allow);
  assert.equal(new Policy({ mode: 'deny' }).decide(byName('bash')), DECISION.deny);
  assert.equal(new Policy({ mode: 'deny' }).decide(byName('read')), DECISION.allow);
});

test('an explicit deny beats everything', () => {
  const p = new Policy({ mode: 'allow', deny: ['bash'] });
  assert.equal(p.decide(byName('bash')), DECISION.deny);
  assert.equal(p.decide(byName('write')), DECISION.allow);
});

test('remembering an allowance lasts the session and no longer', () => {
  const p = new Policy({ mode: 'ask' });
  assert.equal(p.decide(byName('edit')), DECISION.ask);
  p.rememberAllow('edit');
  assert.equal(p.decide(byName('edit')), DECISION.allow);
  assert.equal(p.decide(byName('bash')), DECISION.ask, 'one tool, not all of them');
  // Nothing is written to disk: a new Policy starts from configuration again.
  assert.equal(new Policy({ mode: 'ask' }).decide(byName('edit')), DECISION.ask);
});

test('an unknown mode is an error, not a default', () => {
  assert.throws(() => new Policy({ mode: 'sometimes' }), /must be one of ask, allow, deny/);
});

test('an edit is previewed as a diff, not as JSON', () => {
  // "Is this the right change" is not a question anyone can answer from a JSON
  // blob, and an approval prompt nobody reads properly is worse than none.
  const out = { isTTY: false, columns: 80, written: [], write(s) { this.written.push(s); return true; } };
  const term = new Terminal({ out, err: out, colour: false, env: {} });
  const lines = preview(term, byName('edit'), { path: 'a.js', old: 'x = 1', new: 'x = 2' });
  assert.match(lines[0], /^a\.js$/);
  assert.match(lines[1], /- x = 1/);
  assert.match(lines[2], /\+ x = 2/);

  const write = preview(term, byName('write'), { path: 'b.js', content: 'one\ntwo' });
  assert.match(write[0], /^create b\.js$/);
  assert.match(write[1], /2 lines/);

  // Anything without a bespoke preview still says something useful.
  assert.deepEqual(preview(term, byName('bash'), { command: 'ls -l' }), ['ls -l']);
});

test('the prompt describes what will happen, not the argument JSON', () => {
  assert.deepEqual(describeCall(byName('bash'), { command: 'rm -rf build' }), ['rm -rf build']);
  const edit = describeCall(byName('edit'), { path: 'a.js', old: 'x = 1', new: 'x = 2' });
  assert.match(edit[0], /^edit a\.js$/);
  assert.match(edit[1], /^- x = 1$/);
  assert.match(edit[2], /^\+ x = 2$/);
});

// --- Loop ------------------------------------------------------------------

const profile = defineProfile({
  name: 'fake', baseUrl: 'https://fake.invalid/v1',
  keyVar: 'F_API_KEY', baseUrlVar: 'F_BASE_URL', modelVar: 'F_MODEL',
});

function toolCallChunk(id, name, args) {
  return {
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      finish_reason: 'tool_calls',
    }],
  };
}

function textChunk(text) {
  return { choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] };
}

async function harness(t, { policy = new Policy({ mode: 'allow' }), files = {}, maxTurns } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-loop-')));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  const fake = await new FakeProvider().start();
  t.after(() => { fake.stop(); fs.rmSync(root, { recursive: true, force: true }); });

  const client = new OpenAICompatClient({
    profile, name: 'fake', key: 'k', baseUrl: fake.baseUrl, model: 'm', extraHeaders: {},
  });
  const prompt = { ask: async () => ({ decision: DECISION.deny, reason: 'no terminal' }) };
  const loop = new Loop({
    router: new Router([client], { sleep: async () => {} }),
    tools: TOOLS, policy, prompt, root,
    ...(maxTurns === undefined ? {} : { maxTurns }),
  });
  return { fake, loop, root, prompt };
}

async function drain(loop, conversation) {
  const events = [];
  for await (const ev of loop.run(conversation)) events.push(ev);
  return events;
}

test('a reply with no tool calls ends the loop in one turn', async (t) => {
  const { fake, loop } = await harness(t);
  fake.respond({ sse: frameChunks([textChunk('done')]) });
  const events = await drain(loop, new Conversation().user('hi'));
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).turns, 1);
  assert.equal(events.at(-1).result.content, 'done');
});

test('runs a tool the model asks for and feeds the result back', async (t) => {
  const { fake, loop } = await harness(t, { files: { 'a.txt': 'hello world' } });
  fake.respond({ sse: frameChunks([toolCallChunk('c1', 'read', { path: 'a.txt' })]) });
  fake.respond({ sse: frameChunks([textChunk('the file says hello world')]) });

  const conversation = new Conversation().user('what is in a.txt?');
  const events = await drain(loop, conversation);

  const start = events.find((e) => e.type === 'tool-start');
  assert.deepEqual(start.args, { path: 'a.txt' });
  const result = events.find((e) => e.type === 'tool-result');
  assert.equal(result.ok, true);
  assert.match(result.content, /hello world/);

  // The second request must carry the tool result back.
  const second = fake.requests.at(-1).body.messages;
  assert.equal(second.at(-1).role, 'tool');
  assert.equal(second.at(-1).tool_call_id, 'c1');
  assert.equal(events.at(-1).turns, 2);
});

test('sends the tool specs, and they are the ones the registry declares', async (t) => {
  const { fake, loop } = await harness(t);
  fake.respond({ sse: frameChunks([textChunk('ok')]) });
  await drain(loop, new Conversation().user('hi'));
  const sent = fake.lastRequest.body.tools.map((s) => s.function.name);
  assert.deepEqual(sent, TOOLS.map((t2) => t2.name));
});

test('a denied tool is reported to the model rather than ending the run', async (t) => {
  const { fake, loop } = await harness(t, { policy: new Policy({ mode: 'deny' }) });
  fake.respond({ sse: frameChunks([toolCallChunk('c1', 'write', { path: 'a.txt', content: 'x' })]) });
  fake.respond({ sse: frameChunks([textChunk('understood')]) });

  const events = await drain(loop, new Conversation().user('write a file'));
  const result = events.find((e) => e.type === 'tool-result');
  assert.equal(result.ok, false);
  assert.match(result.content, /not permitted/);
  assert.equal(events.at(-1).type, 'done', 'the run continues so the model can respond');
});

test('a tool error is reported to the model, not thrown', async (t) => {
  // A model told what went wrong usually fixes it; a model told nothing
  // repeats it.
  const { fake, loop } = await harness(t);
  fake.respond({ sse: frameChunks([toolCallChunk('c1', 'read', { path: 'missing.txt' })]) });
  fake.respond({ sse: frameChunks([textChunk('no such file then')]) });

  const events = await drain(loop, new Conversation().user('read missing.txt'));
  const result = events.find((e) => e.type === 'tool-result');
  assert.equal(result.ok, false);
  assert.match(result.content, /does not exist/);
});

test('an unknown tool is answered with the list of real ones', async (t) => {
  const { fake, loop } = await harness(t);
  fake.respond({ sse: frameChunks([toolCallChunk('c1', 'delete_everything', {})]) });
  fake.respond({ sse: frameChunks([textChunk('sorry')]) });
  const events = await drain(loop, new Conversation().user('go'));
  const result = events.find((e) => e.type === 'tool-result');
  assert.match(result.content, /there is no tool called delete_everything/);
  assert.match(result.content, /Available: read, write/);
});

test('malformed tool arguments are answered with what to do about it', async (t) => {
  const { fake, loop } = await harness(t);
  fake.respond({
    sse: frameChunks([{
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":' } }] },
        finish_reason: 'tool_calls',
      }],
    }]),
  });
  fake.respond({ sse: frameChunks([textChunk('let me try again')]) });
  const events = await drain(loop, new Conversation().user('go'));
  const result = events.find((e) => e.type === 'tool-result');
  assert.match(result.content, /not valid JSON/);
  assert.match(result.content, /Send them again as a JSON object/);
});

test('every tool call is answered, including failures', async (t) => {
  // An unanswered call leaves the conversation in a state some providers
  // reject and others quietly mishandle.
  const { fake, loop } = await harness(t, { files: { 'a.txt': 'x' } });
  fake.respond({
    sse: frameChunks([{
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":"a.txt"}' } },
            { index: 1, id: 'c2', function: { name: 'read', arguments: '{"path":"nope.txt"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    }]),
  });
  fake.respond({ sse: frameChunks([textChunk('both seen')]) });

  const conversation = new Conversation().user('go');
  await drain(loop, conversation);
  const toolMessages = conversation.messages.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMessages.map((m) => m.tool_call_id), ['c1', 'c2']);
  assert.deepEqual(conversation.pendingToolCalls, []);
});

test('stops at the turn limit rather than looping forever', async (t) => {
  // A model that keeps calling a tool would otherwise spend the whole day's
  // quota in a few seconds.
  const { fake, loop } = await harness(t, { files: { 'a.txt': 'x' }, maxTurns: 3 });
  for (let i = 0; i < 6; i++) {
    fake.respond({ sse: frameChunks([toolCallChunk(`c${i}`, 'read', { path: 'a.txt' })]) });
  }
  const events = await drain(loop, new Conversation().user('go'));
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).reason, 'turn limit');
  assert.equal(events.at(-1).turns, 3);
});
