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
import { ProviderClient } from '../../src/provider/Client.js';
import { defineProfile } from '../../src/provider/profiles/generic.js';
import { FakeProvider, frameChunks } from './lib/FakeProvider.js';
import { TokenEstimator } from '../../src/agent/TokenEstimator.js';
import { ContextBudget } from '../../src/agent/ContextBudget.js';
import { Compactor } from '../../src/agent/Compactor.js';

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

test('an assistant message with nothing in it is refused', () => {
  // It poisons the conversation permanently: providers reject it with
  // "must have non-empty content", and a 400 is our own fault by definition so
  // the router will not rotate past it. Every later request then fails the same
  // way for the rest of the session.
  const c = new Conversation().user('hi');
  assert.throws(() => c.assistant({ content: '', toolCalls: [] }), /no content and no tool calls/);
  assert.throws(() => c.assistant({}), /no content and no tool calls/);

  // With either one, it is a real turn.
  assert.doesNotThrow(() => c.assistant({ content: 'something' }));
  const d = new Conversation().user('hi');
  assert.doesNotThrow(() => d.assistant({ content: '', toolCalls: [{ id: 'c1', name: 'ls', arguments: '{}' }] }));
});

test('a conversation recorded before that check is repaired on replay', () => {
  // Resuming into a poisoned transcript would fail on every request with no
  // way for anyone to see why.
  const restored = Conversation.fromJSON([
    { role: 'system', content: 's' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null },
    { role: 'user', content: 'continue' },
  ]);
  assert.deepEqual(restored.messages.map((m) => m.role), ['system', 'user', 'user']);
});

test('a replayed assistant message with tool calls survives, content or not', () => {
  const restored = Conversation.fromJSON([
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ]);
  assert.equal(restored.messages.length, 2);
  assert.deepEqual(restored.pendingToolCalls, []);
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
  assert.deepEqual(describeCall('bash', { command: 'rm -rf build' }), ['rm -rf build']);
  const edit = describeCall('edit', { path: 'a.js', old: 'x = 1', new: 'x = 2' });
  assert.match(edit[0], /^edit a\.js$/);
  assert.match(edit[1], /^- x = 1$/);
  assert.match(edit[2], /^\+ x = 2$/);
});

// --- Loop ------------------------------------------------------------------

const profile = defineProfile({
  name: 'fake', baseUrl: 'https://fake.invalid/v1',
  keyVar: 'F_API_KEY', baseUrlVar: 'F_BASE_URL', modelVar: 'F_MODEL',
  // Named, so the limiter has something to learn from -- without these the
  // budget is unknown and nothing is ever over it.
  rateLimit: {
    limitTokens: 'x-ratelimit-limit-tokens',
    remainingTokens: 'x-ratelimit-remaining-tokens',
    resetTokens: 'x-ratelimit-reset-tokens',
    resetFormat: 'duration',
  },
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

async function harness(t, { policy = new Policy({ mode: 'allow' }), files = {}, maxTurns, withBudget = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-loop-')));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  const fake = await new FakeProvider().start();
  t.after(() => { fake.stop(); fs.rmSync(root, { recursive: true, force: true }); });

  const client = new ProviderClient({
    profile, name: 'fake', key: 'k', baseUrl: fake.baseUrl, model: 'm', extraHeaders: {},
  });
  const prompt = { ask: async () => ({ decision: DECISION.deny, reason: 'no terminal' }) };
  const router = new Router([client], { sleep: async () => {} });
  const estimator = new TokenEstimator();
  const extras = withBudget
    ? {
      estimator,
      budget: new ContextBudget({ estimator, compactAt: 0.5 }),
      compactor: new Compactor({ router, estimator }),
    }
    : { estimator };

  const loop = new Loop({
    router, tools: TOOLS, policy, prompt, root,
    ...extras,
    ...(maxTurns === undefined ? {} : { maxTurns }),
  });
  return { fake, loop, root, prompt, client, estimator };
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

test('the estimator learns from what each response actually cost', async (t) => {
  // Every response hands back usage.prompt_tokens. Not using it would be
  // choosing to stay wrong when the answer arrives on every turn.
  const { fake, loop, estimator } = await harness(t);
  fake.respond({
    sse: frameChunks([
      textChunk('ok'),
      { choices: [], usage: { prompt_tokens: 4321, completion_tokens: 2, total_tokens: 4323 } },
    ]),
  });
  assert.equal(estimator.observations, 0);
  await drain(loop, new Conversation().user('hi'));
  assert.equal(estimator.observations, 1, 'the reported usage was fed back');
  assert.notEqual(estimator.correction, 1, 'and it moved the correction');
});

test('compacts before asking, not after being refused', async (t) => {
  // A request that does not fit costs a round trip and, on a free tier,
  // possibly a cooldown. Compacting first avoids paying for the refusal.
  const { fake, loop, client } = await harness(t, { withBudget: true });
  // 2,000 rather than something tiny: the seven tool schemas alone cost about
  // 830 estimated tokens, so a limit below that makes *every* request
  // impossible and tests nothing about compaction.
  client.limiter.observe({
    'x-ratelimit-limit-tokens': '2000',
    'x-ratelimit-remaining-tokens': '2000',
    'x-ratelimit-reset-tokens': '60s',
  });

  const conversation = new Conversation({ system: 'be helpful' });
  for (let i = 0; i < 8; i++) {
    conversation.user(`question ${i} `.repeat(30));
    conversation.assistant({ content: `answer ${i} `.repeat(30) });
  }

  fake.respond({ sse: frameChunks([textChunk('a summary of what went before')]) });
  fake.respond({ sse: frameChunks([textChunk('done')]) });

  const events = await drain(loop, conversation);
  const compacted = events.find((e) => e.type === 'compacted');
  assert.ok(compacted, 'the conversation was over the threshold and should have been compacted');
  assert.ok(compacted.after < compacted.before, `${compacted.before} -> ${compacted.after}`);

  // And the compacted conversation is what was sent.
  const sent = fake.lastRequest.body.messages;
  assert.ok(sent.some((m) => /Notes from earlier/.test(m.content ?? '')));
  assert.equal(events.at(-1).type, 'done');
});

test('compaction falls back to something free when a summary cannot be afforded', async (t) => {
  // The deadlock this exists for: the summary is itself a request, and the
  // moment the conversation is most over budget is exactly the moment a
  // summary cannot be sent either. The fallback costs nothing and always makes
  // progress.
  const { fake, loop, client } = await harness(t, { withBudget: true });
  client.limiter.observe({
    'x-ratelimit-limit-tokens': '1200',
    'x-ratelimit-remaining-tokens': '1200',
    'x-ratelimit-reset-tokens': '60s',
  });

  const conversation = new Conversation({ system: 'be helpful' });
  for (let i = 0; i < 10; i++) {
    conversation.user(`question ${i} `.repeat(60));
    conversation.assistant({ content: `answer ${i} `.repeat(60) });
  }

  fake.respond({ sse: frameChunks([textChunk('done')]) });
  const events = await drain(loop, conversation);

  const compacted = events.find((e) => e.type === 'compacted');
  assert.ok(compacted, 'it must still compact');
  assert.equal(compacted.mechanical, true, 'and without spending a request it cannot afford');
  assert.match(compacted.reason, /would not fit/);
  assert.ok(compacted.after < compacted.before);
  assert.equal(fake.requests.length, 1, 'no summary request was attempted');
});

test('the done event carries the conversation, which may be a new one', async (t) => {
  // Compaction builds a new Conversation. A caller that keeps its own reference
  // silently discards the compaction and the next turn is just as large.
  const { fake, loop } = await harness(t);
  fake.respond({ sse: frameChunks([textChunk('ok')]) });
  const conversation = new Conversation().user('hi');
  const events = await drain(loop, conversation);
  assert.ok(events.at(-1).conversation, 'done must carry the conversation to adopt');
});

test('a short conversation is not compacted', async (t) => {
  const { fake, loop, client } = await harness(t, { withBudget: true });
  client.limiter.observe({
    'x-ratelimit-limit-tokens': '100000',
    'x-ratelimit-remaining-tokens': '100000',
    'x-ratelimit-reset-tokens': '60s',
  });
  fake.respond({ sse: frameChunks([textChunk('ok')]) });
  const events = await drain(loop, new Conversation().user('hi'));
  assert.ok(!events.some((e) => e.type === 'compacted'));
});

test('an empty reply is retried once, then reported', async (t) => {
  // Usually a model spending its whole completion on reasoning. The second
  // attempt generally lands; what must never happen is recording it.
  const { fake, loop } = await harness(t);
  const empty = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
  fake.respond({ sse: frameChunks([empty]) });
  fake.respond({ sse: frameChunks([textChunk('this time with words')]) });

  const conversation = new Conversation().user('hi');
  const events = await drain(loop, conversation);

  assert.equal(events.filter((e) => e.type === 'empty-reply').length, 1);
  assert.equal(events.at(-1).result.content, 'this time with words');
  assert.ok(!conversation.messages.some((m) => m.role === 'assistant' && (m.content ?? '') === ''),
    'nothing degenerate was recorded');
});

test('two empty replies end the turn rather than looping', async (t) => {
  const { fake, loop } = await harness(t);
  const empty = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
  fake.respond({ sse: frameChunks([empty]) });
  fake.respond({ sse: frameChunks([empty]) });

  const conversation = new Conversation().user('hi');
  const events = await drain(loop, conversation);
  assert.equal(events.at(-1).type, 'done');
  assert.match(events.at(-1).reason, /replied with nothing/);
  assert.equal(conversation.messages.filter((m) => m.role === 'assistant').length, 0,
    'and the conversation is still valid to continue');
  assert.doesNotThrow(() => conversation.user('try again'));
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
