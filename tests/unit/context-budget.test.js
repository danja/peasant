import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextBudget, KEEP_RECENT } from '../../src/agent/ContextBudget.js';
import { Compactor } from '../../src/agent/Compactor.js';
import { Conversation } from '../../src/agent/Conversation.js';
import { TokenEstimator } from '../../src/agent/TokenEstimator.js';
import { Router } from '../../src/provider/Router.js';
import { OpenAICompatClient } from '../../src/provider/OpenAICompatClient.js';
import { defineProfile } from '../../src/provider/profiles/generic.js';
import { FakeProvider, frameChunks } from './lib/FakeProvider.js';

const profile = defineProfile({
  name: 'fake', baseUrl: 'https://fake.invalid/v1',
  keyVar: 'F_API_KEY', baseUrlVar: 'F_BASE_URL', modelVar: 'F_MODEL',
  rateLimit: {
    limitTokens: 'x-ratelimit-limit-tokens',
    remainingTokens: 'x-ratelimit-remaining-tokens',
    resetTokens: 'x-ratelimit-reset-tokens',
    resetFormat: 'duration',
  },
});

function clientWith({ limitTokens = null, contextWindow = null } = {}) {
  const c = new OpenAICompatClient({
    profile, name: 'fake', key: 'k', baseUrl: 'https://fake.invalid/v1',
    model: 'm', extraHeaders: {}, contextWindow,
  });
  if (limitTokens !== null) {
    c.limiter.observe({
      'x-ratelimit-limit-tokens': String(limitTokens),
      'x-ratelimit-remaining-tokens': String(limitTokens),
      'x-ratelimit-reset-tokens': '60s',
    });
  }
  return c;
}

const budget = () => new ContextBudget({ estimator: new TokenEstimator() });

// --- the limit --------------------------------------------------------------

test('the smaller of the window and the rate limit wins', () => {
  const b = budget();
  assert.equal(b.limitFor(clientWith({ limitTokens: 8000, contextWindow: 131072 })), 8000,
    'a conversation that fits the window perfectly can still be unsendable');
  assert.equal(b.limitFor(clientWith({ limitTokens: 200000, contextWindow: 8192 })), 8192);
  assert.equal(b.limitFor(clientWith({ contextWindow: 4096 })), 4096);
});

test('the rate limit binds, not only the context window', () => {
  // The assumption a harness usually makes is that the window is the
  // constraint. On these tiers it is not: 8,000 tokens a minute against a
  // window many times that, so a conversation that fits perfectly can still be
  // unsendable.
  const b = budget();
  assert.equal(b.limitFor(clientWith({ limitTokens: 8000 })), 8000);
});

test('unknown is not the same as none', () => {
  // Most providers publish nothing. Refusing to send anything to one that has
  // told us nothing would make it permanently useless.
  const b = budget();
  const c = clientWith();
  assert.equal(b.limitFor(c), null);
  assert.equal(b.fits(new Conversation().user('hi'), [], c).fits, true);
  assert.equal(b.shouldCompact(new Conversation().user('hi'), [], c), false);
});

test('a request that exceeds the limit does not fit', () => {
  const b = budget();
  const c = clientWith({ limitTokens: 200 });
  const small = new Conversation().user('hello');
  const large = new Conversation().user('x'.repeat(20000));
  assert.equal(b.fits(small, [], c).fits, true);
  assert.equal(b.fits(large, [], c).fits, false);
});

test('compaction triggers on a fraction of the limit', () => {
  const b = new ContextBudget({ estimator: new TokenEstimator(), compactAt: 0.5 });
  const c = clientWith({ limitTokens: 1000 });
  const small = new Conversation().user('hi');
  assert.equal(b.shouldCompact(small, [], c), false);
  const big = new Conversation().user('word '.repeat(700));
  assert.equal(b.shouldCompact(big, [], c), true);
});

// --- safe boundaries --------------------------------------------------------

test('a boundary never separates a tool call from its answers', () => {
  // Cutting between them leaves either an unanswered call or an answer to
  // nothing, and providers reject both.
  const messages = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'result' },
    { role: 'assistant', content: 'done' },
  ];
  // Asking to cut in the middle of the call/answer pair walks forward past it.
  assert.equal(ContextBudget.safeBoundary(messages, 1), 3);
  assert.equal(ContextBudget.safeBoundary(messages, 2), 3);
  assert.equal(ContextBudget.safeBoundary(messages, 0), 0);
});

test('a boundary past the end is the end', () => {
  assert.equal(ContextBudget.safeBoundary([{ role: 'user', content: 'a' }], 5), 1);
});

test('split keeps the system message out of the summary', () => {
  const messages = [
    { role: 'system', content: 'instructions' },
    ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` })),
  ];
  const { system, older, recent } = ContextBudget.split(messages, { keepRecent: 4 });
  assert.deepEqual(system, [messages[0]]);
  assert.equal(older.length + recent.length, 10);
  assert.equal(recent.length, 4);
  assert.ok(!older.some((m) => m.role === 'system'), 'the system message is the instructions, not history');
});

test('split does nothing to a short conversation', () => {
  const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  const { older, recent } = ContextBudget.split(messages);
  assert.deepEqual(older, []);
  assert.equal(recent.length, 2);
});

test('split respects the tool-call unit when choosing where to cut', () => {
  const messages = [
    { role: 'user', content: 'old' },
    { role: 'user', content: 'older' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'r' },
    { role: 'assistant', content: 'x' },
    { role: 'user', content: 'recent' },
  ];
  const { older, recent } = ContextBudget.split(messages, { keepRecent: 3 });
  // Cutting at length-3 would land on the tool message; it must walk forward.
  assert.ok(recent[0].role !== 'tool', 'a tool answer cannot start a conversation');
  assert.ok(!(older.at(-1)?.role === 'assistant' && older.at(-1)?.tool_calls),
    'an unanswered call cannot end one');
});

// --- compaction -------------------------------------------------------------

async function compactorWith(t, summary) {
  const fake = await new FakeProvider().start();
  t.after(() => fake.stop());
  const client = new OpenAICompatClient({
    profile, name: 'fake', key: 'k', baseUrl: fake.baseUrl, model: 'm', extraHeaders: {},
  });
  const router = new Router([client], { sleep: async () => {} });
  if (summary !== undefined) {
    fake.respond({ sse: frameChunks([{ choices: [{ index: 0, delta: { content: summary }, finish_reason: 'stop' }] }]) });
  }
  return { fake, compactor: new Compactor({ router, estimator: new TokenEstimator() }) };
}

function longConversation() {
  const c = new Conversation({ system: 'be helpful' });
  for (let i = 0; i < 8; i++) {
    c.user(`question ${i} `.repeat(40));
    c.assistant({ content: `answer ${i} `.repeat(40) });
  }
  return c;
}

test('compaction replaces the older half and keeps the recent exchange', async (t) => {
  const { compactor } = await compactorWith(t, 'Notes: user asked about src/a.js; add() was changed.');
  const original = longConversation();
  const { conversation, compacted, saved } = await compactor.compact(original);

  assert.equal(compacted, true);
  assert.ok(saved > 0, `compaction saved ${saved} tokens`);
  assert.equal(conversation.messages[0].role, 'system', 'the instructions survive');
  assert.match(conversation.messages[1].content, /Notes from earlier/);
  assert.match(conversation.messages[1].content, /src\/a\.js/);

  // The most recent exchange is what the model is working from, so it stays.
  const last = original.messages.at(-1);
  assert.deepEqual(conversation.messages.at(-1), last);
});

test('compaction sends no tools -- they are the biggest item and no use here', async (t) => {
  const { fake, compactor } = await compactorWith(t, 'notes');
  await compactor.compact(longConversation());
  assert.equal(fake.lastRequest.body.tools, undefined);
});

test('a conversation too big to send is reduced even when none of it is old', async (t) => {
  // The bug this pins, reported from a real session that got stuck repeating
  // "no provider can serve a request of about 9057 tokens":
  //
  // three file reads make a conversation that does not fit, and `split` keeps
  // the last six messages, so `older` is empty and there is no transcript to
  // summarise. compact() returned early on that, the oversized request went out
  // anyway, the router refused it, and retrying reproduced it exactly. For ever.
  const { compactor } = await compactorWith(t);
  const estimator = new TokenEstimator();

  const c = new Conversation({ system: 's' });
  c.user('read the big file');
  c.assistant({ content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] });
  c.toolResult('c1', `src/big.js (900 lines)\n${'const x = 1;\n'.repeat(2000)}`);

  const { older } = ContextBudget.split(c.messages);
  assert.equal(older.length, 0, 'the premise: nothing is old enough to summarise');

  const result = await compactor.compact(c, {
    canAfford: () => false,
    targetFits: (m) => estimator.estimate({ messages: m }) <= 8000,
  });

  assert.equal(result.compacted, true, 'it must still reduce');
  assert.equal(result.mechanical, true, 'and without a request it cannot afford');
  assert.ok(result.after < result.before, `${result.before} -> ${result.after}`);
  assert.deepEqual(result.conversation.pendingToolCalls, [], 'and the result is sendable');
});

test('a recent tool result is elided rather than left alone for being recent', async (t) => {
  // The message that makes a conversation unsendable is often the one just
  // read. Refusing to touch it because it is recent leaves nothing to do.
  const { compactor } = await compactorWith(t);
  const c = new Conversation({ system: 's' });
  c.user('read it');
  c.assistant({ content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] });
  c.toolResult('c1', `src/big.js (900 lines)\n${'x'.repeat(30000)}`);

  const result = await compactor.compact(c, { canAfford: () => false, targetFits: () => false });
  const tool = result.conversation.messages.find((m) => m.role === 'tool');
  assert.match(tool.content, /^src\/big\.js \(900 lines\)/, 'the first line is the gist and survives');
  assert.match(tool.content, /elided by compaction/, 'and the rest is honestly accounted for');
});

test('a conversation that fits is still left alone', async (t) => {
  // The early return is right when there is genuinely nothing to do; it was
  // only wrong when the conversation did not fit.
  const { compactor } = await compactorWith(t);
  const c = new Conversation({ system: 's' }).user('hi');
  const result = await compactor.compact(c, { targetFits: () => true });
  assert.equal(result.compacted, false);
  assert.equal(result.quiet, true);
  assert.equal(result.conversation, c);
});

test('a short conversation is left alone', async (t) => {
  const { compactor } = await compactorWith(t);
  const c = new Conversation({ system: 's' }).user('hi');
  const result = await compactor.compact(c);
  assert.equal(result.compacted, false);
  assert.equal(result.conversation, c, 'the original is returned unchanged');
});

test('a failed summary leaves the conversation alone rather than losing it', async (t) => {
  // Not compacting is a worse conversation; losing it is a worse afternoon.
  const fake = await new FakeProvider().start();
  t.after(() => fake.stop());
  const client = new OpenAICompatClient({
    profile, name: 'fake', key: 'k', baseUrl: fake.baseUrl, model: 'm', extraHeaders: {},
  });
  const compactor = new Compactor({
    router: new Router([client], { sleep: async () => {} }),
    estimator: new TokenEstimator(),
  });
  fake.respond({ status: 500, json: { error: { message: 'boom' } } });

  const original = longConversation();
  const result = await compactor.compact(original);
  assert.equal(result.compacted, false);
  assert.match(result.reason, /summary failed/);
  assert.equal(result.conversation, original);
});

test('a summary larger than what it replaced is refused', async (t) => {
  // It happened live: three short messages became four hundred words of notes
  // and the conversation grew from 1,248 tokens to 1,358. The model writes to
  // the length it was asked for, not the length of its input.
  const { compactor } = await compactorWith(t, 'notes '.repeat(2000));
  const c = new Conversation({ system: 's' });
  for (let i = 0; i < 8; i++) { c.user(`q${i}`); c.assistant({ content: `a${i}` }); }

  const result = await compactor.compact(c, { targetFits: () => true });
  if (result.compacted) {
    assert.ok(result.after < result.before, `compaction must never grow the conversation: ${result.before} -> ${result.after}`);
    assert.equal(result.mechanical, true, 'it should have fallen back');
  } else {
    assert.match(result.reason, /larger than what it replaced|nothing left to remove/);
  }
});

test('nothing old enough to summarise is reported quietly', async (t) => {
  // It is the normal state a turn after compacting, not a problem worth a line
  // of output on every turn.
  const { compactor } = await compactorWith(t);
  const c = new Conversation({ system: 's' }).user('hi');
  const result = await compactor.compact(c);
  assert.equal(result.compacted, false);
  assert.equal(result.quiet, true);
});

test('an empty summary is refused rather than accepted', async (t) => {
  const { compactor } = await compactorWith(t, '');
  const result = await compactor.compact(longConversation());
  assert.equal(result.compacted, false);
  assert.match(result.reason, /empty summary/);
});

test('the compacted conversation is still valid to send', async (t) => {
  // The invariant that matters: no unanswered tool calls, no orphan answers.
  const { compactor } = await compactorWith(t, 'notes');
  const c = new Conversation({ system: 's' });
  for (let i = 0; i < 4; i++) {
    c.user(`ask ${i}`);
    c.assistant({ content: '', toolCalls: [{ id: `c${i}`, name: 'read', arguments: '{}' }] });
    c.toolResult(`c${i}`, 'x'.repeat(500));
  }
  c.user('and finally');

  const { conversation, compacted } = await compactor.compact(c);
  assert.equal(compacted, true);
  assert.deepEqual(conversation.pendingToolCalls, []);
  for (let i = 0; i < conversation.messages.length; i++) {
    const m = conversation.messages[i];
    if (m.role !== 'tool') continue;
    const previous = conversation.messages[i - 1];
    const answersACall = previous?.tool_calls?.some((call) => call.id === m.tool_call_id)
      || previous?.role === 'tool';
    assert.ok(answersACall, `message ${i} answers no call`);
  }
});

test('mechanical compaction cuts into the recent window when it has to', async (t) => {
  // On a small budget the tool schemas can cost more than the whole recent
  // window, and then keeping six messages is not a policy but a guarantee of
  // failure. The last message is the floor: it is the question being asked.
  const { compactor } = await compactorWith(t);
  const c = new Conversation({ system: 's' });
  for (let i = 0; i < 6; i++) {
    c.user(`question ${i} `.repeat(50));
    c.assistant({ content: `answer ${i} `.repeat(50) });
  }

  let budgetLeft = 200;
  const result = await compactor.compact(c, {
    canAfford: () => false,                       // no summary is affordable
    targetFits: (messages) => new TokenEstimator().estimate({ messages }) <= budgetLeft,
  });

  assert.equal(result.compacted, true);
  assert.equal(result.mechanical, true);
  assert.ok(result.conversation.length < c.length);
  assert.equal(result.conversation.messages[0].role, 'system', 'the instructions always survive');
  assert.match(result.conversation.messages[1].content, /earlier messages dropped/);
  // Whatever else goes, the last thing said survives.
  assert.deepEqual(result.conversation.messages.at(-1), c.messages.at(-1));
});

test('mechanical compaction always terminates, even on an impossible budget', async (t) => {
  const { compactor } = await compactorWith(t);
  const c = new Conversation({ system: 's' });
  for (let i = 0; i < 6; i++) { c.user(`q${i}`); c.assistant({ content: `a${i}` }); }

  const result = await compactor.compact(c, {
    canAfford: () => false,
    targetFits: () => false, // nothing will ever fit
  });
  // It stops at the floor rather than looping or emptying the conversation.
  assert.ok(result.conversation.messages.length >= 1);
});

test('elided tool results keep their first line', async (t) => {
  const { compactor } = await compactorWith(t);
  const c = new Conversation({ system: 's' });
  for (let i = 0; i < 5; i++) {
    c.user(`ask ${i}`);
    c.assistant({ content: '', toolCalls: [{ id: `c${i}`, name: 'read', arguments: '{}' }] });
    c.toolResult(`c${i}`, `src/file${i}.js (200 lines)\n${'x'.repeat(3000)}`);
  }
  c.user('now what');

  const result = await compactor.compact(c, { canAfford: () => false, targetFits: () => true });
  assert.equal(result.compacted, true);
  const elided = result.conversation.messages.filter((m) => m.role === 'tool' && /elided/.test(m.content));
  assert.ok(elided.length > 0, 'old tool results should be elided');
  assert.match(elided[0].content, /^src\/file\d\.js \(200 lines\)/, 'the first line is the gist and survives');
});

test('KEEP_RECENT is a stated number, not a magic one', () => {
  assert.ok(Number.isInteger(KEEP_RECENT) && KEEP_RECENT >= 2);
});
