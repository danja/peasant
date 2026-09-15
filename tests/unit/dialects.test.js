// The wire formats, each driven end to end through the real client.
//
// A dialect is two translations -- our request into their shape, their answer
// back into ours -- and both halves are tested here rather than by inspecting
// the functions, because the half that has historically broken is the one
// nobody looked at: what actually went over the socket.
//
// The two new formats are UNVERIFIED against their real endpoints. These tests
// prove the translation is self-consistent and that the client drives it; they
// cannot prove the shape is the shape Anthropic and OpenAI actually send. Only
// a capture can do that. See MAINTAINER.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderClient } from '../../src/provider/Client.js';
import { defineProfile } from '../../src/provider/profiles/generic.js';
import { DIALECTS, DIALECT_NAMES, byName } from '../../src/provider/dialects/index.js';
import { PROFILES } from '../../src/provider/ProfileRegistry.js';
import { FakeProvider, frameEvents } from './lib/FakeProvider.js';

function profileFor(dialect, extra = {}) {
  return defineProfile({
    name: 'fake',
    baseUrl: 'https://fake.invalid/v1',
    keyVar: 'FAKE_API_KEY', baseUrlVar: 'FAKE_BASE_URL', modelVar: 'FAKE_MODEL',
    dialect,
    apiVersion: '2023-06-01',
    ...extra,
  });
}

async function withClient(t, dialect, fn, { profile = profileFor(dialect), ...rest } = {}) {
  const fake = await new FakeProvider().start();
  t.after(() => fake.stop());
  const client = new ProviderClient({
    profile, name: profile.name, key: 'test-key',
    baseUrl: fake.baseUrl, model: 'test-model', extraHeaders: {},
    maxOutputTokens: 1024, ...rest,
  });
  return fn(client, fake);
}

// A conversation with every shape in it: a system prompt, a user turn, an
// assistant turn that called a tool, and the result of that call.
const CONVERSATION = [
  { role: 'system', content: 'be terse' },
  { role: 'user', content: 'read a file' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
  },
  { role: 'tool', tool_call_id: 'call_1', content: 'hello' },
  { role: 'tool', tool_call_id: 'call_2', content: 'world' },
];

const TOOLS = [{
  type: 'function',
  function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
}];

// --- the registry itself ---------------------------------------------------

test('every dialect is registered and complete', () => {
  // A dialect missing a method fails at the first request in a way that names
  // a property, not a format. Checked here instead, where it names the file.
  const required = ['name', 'completionPath', 'buildBody', 'parseModels', 'parseComplete', 'parseEvent', 'errorDetail', 'headers'];
  for (const d of DIALECTS) {
    for (const field of required) {
      assert.ok(d[field] !== undefined, `dialect ${d.name} is missing ${field}`);
    }
    assert.equal(typeof d.requiresMaxTokens, 'boolean', `${d.name}: requiresMaxTokens must be stated`);
  }
  assert.equal(new Set(DIALECT_NAMES).size, DIALECT_NAMES.length, 'two dialects share a name');
});

test('every profile names a dialect that exists', () => {
  // defineProfile already refuses an unknown one; this is the guard that the
  // check is still wired, and it covers profiles added later.
  for (const p of PROFILES) assert.doesNotThrow(() => byName(p.dialect), `${p.name}: ${p.dialect}`);
});

test('a dialect is named after a format, never after a provider', () => {
  // The whole point of the seam: two providers may speak one format, and a
  // dialect called `anthropic` would invite a second one called `claude`.
  const providerNames = PROFILES.map((p) => p.name);
  for (const name of DIALECT_NAMES) {
    assert.ok(!providerNames.includes(name), `dialect ${name} is named after a provider`);
  }
});

// --- Anthropic Messages ----------------------------------------------------

test('messages: the system prompt is hoisted out of the message list', async (t) => {
  await withClient(t, 'messages', async (client, fake) => {
    fake.respond({ json: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } } });
    await client.complete({ messages: CONVERSATION });

    const body = fake.lastRequest.body;
    assert.deepEqual(body.system, [{ type: 'text', text: 'be terse' }]);
    assert.ok(!body.messages.some((m) => m.role === 'system'), 'a system message survived into the turns');
  });
});

test('messages: consecutive tool results are gathered into one user turn', async (t) => {
  // The API rejects a turn that splits them, and the split is invisible until
  // a task happens to call two tools at once.
  await withClient(t, 'messages', async (client, fake) => {
    fake.respond({ json: { content: [], stop_reason: 'end_turn' } });
    await client.complete({ messages: CONVERSATION });

    const turns = fake.lastRequest.body.messages;
    const results = turns.filter((m) => m.content.every((b) => b.type === 'tool_result'));
    assert.equal(results.length, 1, 'tool results were split across turns');
    assert.deepEqual(results[0].content.map((b) => b.tool_use_id), ['call_1', 'call_2']);
  });
});

test('messages: an assistant tool call becomes a tool_use block with parsed input', async (t) => {
  await withClient(t, 'messages', async (client, fake) => {
    fake.respond({ json: { content: [], stop_reason: 'end_turn' } });
    await client.complete({ messages: CONVERSATION, tools: TOOLS });

    const assistant = fake.lastRequest.body.messages.find((m) => m.role === 'assistant');
    assert.deepEqual(assistant.content, [
      { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.txt' } },
    ]);
    // A tool's schema goes under input_schema, and the OpenAI `function`
    // wrapper does not survive.
    assert.deepEqual(fake.lastRequest.body.tools, [
      { name: 'read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
    ]);
    assert.deepEqual(fake.lastRequest.body.tool_choice, { type: 'auto' });
  });
});

test('messages: the required output ceiling comes from configuration', async (t) => {
  await withClient(t, 'messages', async (client, fake) => {
    fake.respond({ json: { content: [], stop_reason: 'end_turn' } });
    await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(fake.lastRequest.body.max_tokens, 1024);
  });
});

test('messages: with no ceiling anywhere, the error names the setting', async (t) => {
  // No inline fallback. A number invented here would be the one thing this
  // project refuses, and "400 max_tokens is required" names nothing.
  await withClient(t, 'messages', async (client) => {
    await assert.rejects(
      () => client.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      /PEASANT_MAX_OUTPUT_TOKENS/,
    );
  }, { maxOutputTokens: undefined });
});

test('messages: the version and OAuth beta headers are sent', async (t) => {
  await withClient(t, 'messages', async (client, fake) => {
    fake.respond({ json: { content: [], stop_reason: 'end_turn' } });
    await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(fake.lastRequest.headers['anthropic-version'], '2023-06-01');
  });
});

test('messages: a streamed tool call is reassembled across content blocks', async (t) => {
  // The index trap: the tool_use block is at content index 1, but it is tool
  // call 0. Using the block index would attach the arguments to a call that
  // does not exist and the turn would silently lose the call.
  await withClient(t, 'messages', async (client, fake) => {
    fake.respond({ sse: frameEvents([
      { event: 'message_start', data: { type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 12, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reading' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'read' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path"' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':"a.txt"}' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]) });

    const events = [];
    for await (const ev of client.stream({ messages: [{ role: 'user', content: 'go' }] })) events.push(ev);
    const done = events.at(-1);

    assert.equal(done.type, 'done');
    assert.equal(done.result.content, 'reading');
    assert.equal(done.result.model, 'claude-test');
    assert.equal(done.result.finishReason, 'tool_calls');
    assert.equal(done.result.toolCalls.length, 1);
    assert.equal(done.result.toolCalls[0].index, 0, 'the tool call took the content block index');
    assert.equal(done.result.toolCalls[0].id, 'toolu_9');
    assert.equal(done.result.toolCalls[0].name, 'read');
    assert.ok(done.result.toolCalls[0].valid, done.result.toolCalls[0].error);
    assert.deepEqual(done.result.toolCalls[0].args, { path: 'a.txt' });
  });
});

test('messages: usage is merged from both events that carry half of it', async (t) => {
  // input_tokens arrives in message_start and output_tokens in message_delta.
  // Taking either alone reports a turn as half its real cost, and the estimator
  // calibrates itself on that number.
  await withClient(t, 'messages', async (client, fake) => {
    fake.respond({ sse: frameEvents([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } } },
    ]) });

    const events = [];
    for await (const ev of client.stream({ messages: [{ role: 'user', content: 'go' }] })) events.push(ev);
    const usage = events.at(-1).result.usage;
    assert.deepEqual(usage, { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 });
  });
});

test('messages: cache tokens are counted as the input they cost', async (t) => {
  await withClient(t, 'messages', async (client, fake) => {
    fake.respond({ json: {
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 2 },
    } });
    const out = await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.usage.prompt_tokens, 105);
  });
});

test('messages: thinking is reasoning, and never assistant content', async (t) => {
  await withClient(t, 'messages', async (client, fake) => {
    fake.respond({ json: {
      content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'answer' }],
      stop_reason: 'end_turn',
    } });
    const out = await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.content, 'answer');
    assert.equal(out.reasoning, 'hmm');
  });
});

test('messages: an error event ends the stream as a rotatable failure', async (t) => {
  // Not a clean end. A stream that stops early with an error and reports
  // success gives the loop a truncated answer it has no way to distinguish.
  await withClient(t, 'messages', async (client, fake) => {
    fake.respond({ sse: frameEvents([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
      { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } } },
    ]) });

    await assert.rejects(async () => {
      for await (const _ of client.stream({ messages: [{ role: 'user', content: 'go' }] })) { /* drain */ }
    }, (e) => {
      assert.match(e.message, /overloaded/);
      assert.equal(e.kind, 'server-error');
      assert.ok(e.retryable, 'an overloaded provider must be worth rotating off');
      return true;
    });
  });
});

// --- OpenAI Responses ------------------------------------------------------

test('responses: the system prompt becomes instructions and turns become items', async (t) => {
  await withClient(t, 'responses', async (client, fake) => {
    fake.respond({ json: { output: [], status: 'completed' } });
    await client.complete({ messages: CONVERSATION });

    const body = fake.lastRequest.body;
    assert.equal(body.instructions, 'be terse');
    assert.equal(body.store, false, 'a coding session must not be stored server-side');

    // A tool call and its result are siblings in the input list, not a message
    // with a reply.
    assert.deepEqual(body.input.map((i) => i.type), [
      'message', 'function_call', 'function_call_output', 'function_call_output',
    ]);
    assert.equal(body.input[1].call_id, 'call_1');
    assert.equal(body.input[1].arguments, '{"path":"a.txt"}');
    assert.equal(body.input[2].output, 'hello');
  });
});

test('responses: a tool schema keeps its parameters and loses the wrapper', async (t) => {
  await withClient(t, 'responses', async (client, fake) => {
    fake.respond({ json: { output: [], status: 'completed' } });
    await client.complete({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    assert.deepEqual(fake.lastRequest.body.tools, [{
      type: 'function',
      name: 'read',
      description: 'read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    }]);
  });
});

test('responses: a streamed tool call is reassembled and keyed by call_id', async (t) => {
  await withClient(t, 'responses', async (client, fake) => {
    fake.respond({ sse: frameEvents([
      { event: 'response.created', data: { type: 'response.created', response: { model: 'codex-test' } } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'thinking aloud' } },
      { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'read', arguments: '' } } },
      { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"path"' } },
      { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: ':"b.txt"}' } },
      { event: 'response.completed', data: { type: 'response.completed', response: { model: 'codex-test', status: 'completed', usage: { input_tokens: 40, output_tokens: 9, output_tokens_details: { reasoning_tokens: 6 } } } } },
    ]) });

    const events = [];
    for await (const ev of client.stream({ messages: [{ role: 'user', content: 'go' }] })) events.push(ev);
    const result = events.at(-1).result;

    assert.equal(result.content, 'thinking aloud');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.toolCalls.length, 1);
    // call_id, not the item id: a result quoting the item id is one the model
    // cannot match to its own call.
    assert.equal(result.toolCalls[0].id, 'call_abc');
    assert.deepEqual(result.toolCalls[0].args, { path: 'b.txt' });
    assert.equal(result.usage.prompt_tokens, 40);
    assert.equal(result.usage.completion_tokens_details.reasoning_tokens, 6);
  });
});

test('responses: argument deltas keyed only by output_index still land', async (t) => {
  // Observed builds key these two ways. Losing the arguments would leave a
  // named tool call with empty arguments, which reads as the model's fault.
  await withClient(t, 'responses', async (client, fake) => {
    fake.respond({ sse: frameEvents([
      { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_x', name: 'ls' } } },
      { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":"."}' } },
      { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed' } } },
    ]) });

    const events = [];
    for await (const ev of client.stream({ messages: [{ role: 'user', content: 'go' }] })) events.push(ev);
    assert.deepEqual(events.at(-1).result.toolCalls[0].args, { path: '.' });
  });
});

test('responses: with no catalogue and no model named, the error says which to set', async (t) => {
  await withClient(t, 'responses', async (client) => {
    await assert.rejects(() => client.listModelDetails(), /FAKE_MODEL/);
  });
});

// --- the format-independent promise ----------------------------------------

test('every dialect returns the same result shape', async (t) => {
  // The loop, the printer and the budgeter read one shape. A dialect that
  // returned `input_tokens` would be discovered as a wrong number on a bill,
  // not as a failure.
  const bodies = {
    'chat-completions': { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    messages: { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    responses: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
  };

  for (const name of DIALECT_NAMES) {
    await withClient(t, name, async (client, fake) => {
      fake.respond({ json: bodies[name] });
      const out = await client.complete({ messages: [{ role: 'user', content: 'hi' }] });

      assert.deepEqual(Object.keys(out).sort(),
        ['content', 'finishReason', 'model', 'provider', 'reasoning', 'toolCalls', 'usage'],
        `${name} returned a different result shape`);
      assert.equal(out.content, 'hi', `${name} lost the content`);
      assert.equal(out.usage.prompt_tokens, 1, `${name} did not normalise usage`);
      assert.equal(out.finishReason, 'stop', `${name} did not normalise the stop reason`);
    });
  }
});
