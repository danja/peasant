// Fields a provider puts on a tool call must come back to it untouched.
//
// Gemini 3.x attaches `extra_content.google.thought_signature` to every function
// call and answers `400 INVALID_ARGUMENT` on the next turn if it does not
// return. peasant dropped it in two places at once — the assembler read only
// the four fields it understood, and Conversation rebuilt the message from
// three of them — so a tool-using session against Google failed on its second
// turn while `peasant ask`, which sends no tools, worked perfectly.
//
// The capture proving Gemini sends it had been in docs/raw/ since the day
// Google was first probed, read by five tests, none of which looked at a field
// it was not already expecting. Hence this file: the rule is that we keep what
// we do not understand, and it is asserted directly rather than inferred.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallAssembler, assemble } from '../../src/provider/ToolCallAssembler.js';
import { Conversation } from '../../src/agent/Conversation.js';
import { listCaptures, readCapture } from './lib/fixtures.js';

const SIGNATURE = { google: { thought_signature: 'ErsCCrgCARFNMg9Z3RvnQTZYVuyOdDC0' } };

test('an unrecognised field on a tool call survives assembly', () => {
  const a = new ToolCallAssembler();
  a.push([{
    index: 0, id: 'call_1', type: 'function',
    extra_content: SIGNATURE,
    function: { name: 'read', arguments: '{"path":"notes.txt"}' },
  }]);
  const [call] = a.finish();
  assert.deepEqual(call.extra, { extra_content: SIGNATURE });
  assert.equal(call.name, 'read', 'the fields we do understand still work');
});

test('a call with nothing unrecognised reports null, not an empty object', () => {
  // So a caller can spread it unconditionally, and so the common case adds
  // nothing to a session record.
  const [call] = assemble([{ choices: [{ delta: { tool_calls: [{
    index: 0, id: 'c', type: 'function', function: { name: 'read', arguments: '{}' },
  }] } }] }]);
  assert.equal(call.extra, null);
});

test('an extra arriving in the opening delta survives the deltas that follow', () => {
  // The incremental shape: Gemini sends the signature once, with the id and
  // name, and later deltas carry only argument text. A field that was
  // overwritten by the last delta would be lost exactly when it is needed.
  const a = new ToolCallAssembler();
  a.push([{ index: 0, id: 'c', type: 'function', extra_content: SIGNATURE, function: { name: 'read', arguments: '{"pa' } }]);
  a.push([{ index: 0, function: { arguments: 'th":"x"}' } }]);
  const [call] = a.finish();
  assert.deepEqual(call.extra, { extra_content: SIGNATURE });
  assert.equal(call.arguments, '{"path":"x"}');
});

test('two calls keep their own extras', () => {
  const a = new ToolCallAssembler();
  a.push([
    { index: 0, id: 'c0', type: 'function', extra_content: { google: { thought_signature: 'AAA' } }, function: { name: 'read', arguments: '{}' } },
    { index: 1, id: 'c1', type: 'function', extra_content: { google: { thought_signature: 'BBB' } }, function: { name: 'ls', arguments: '{}' } },
  ]);
  const calls = a.finish();
  assert.equal(calls[0].extra.extra_content.google.thought_signature, 'AAA');
  assert.equal(calls[1].extra.extra_content.google.thought_signature, 'BBB');
});

test('the conversation sends the extra back on the assistant message', () => {
  const c = new Conversation();
  c.user('read notes.txt');
  c.assistant({ content: '', toolCalls: [{
    id: 'call_1', name: 'read', arguments: '{"path":"notes.txt"}', extra: { extra_content: SIGNATURE },
  }] });
  const [, assistantMsg] = c.messages;
  assert.deepEqual(assistantMsg.tool_calls[0].extra_content, SIGNATURE);
  assert.equal(assistantMsg.tool_calls[0].id, 'call_1');
  assert.equal(assistantMsg.tool_calls[0].function.name, 'read');
});

test('a provider field cannot overwrite id, type or function', () => {
  // The extras are spread first for this reason. A provider that happened to
  // send `id` in a place we treat as opaque must not be able to rewrite the
  // call we are answering.
  const c = new Conversation();
  c.user('hi');
  c.assistant({ content: '', toolCalls: [{
    id: 'real', name: 'read', arguments: '{}',
    extra: { id: 'spoofed', type: 'nonsense', function: { name: 'rm' } },
  }] });
  const call = c.messages[1].tool_calls[0];
  assert.equal(call.id, 'real');
  assert.equal(call.type, 'function');
  assert.equal(call.function.name, 'read');
});

test('a conversation with no extras is byte-identical to before', () => {
  // The fix must be invisible to every provider that does not need it.
  const c = new Conversation();
  c.user('hi');
  c.assistant({ content: '', toolCalls: [{ id: 'c', name: 'read', arguments: '{}' }] });
  assert.deepEqual(c.messages[1].tool_calls[0], {
    id: 'c', type: 'function', function: { name: 'read', arguments: '{}' },
  });
});

test('the extra survives a round trip through the session transcript', () => {
  // Conversation.fromJSON() replays a stored transcript. A signature lost on resume
  // would fail the next turn with the same 400, from a file that looked fine.
  const c = new Conversation();
  c.user('hi');
  c.assistant({ content: '', toolCalls: [{
    id: 'c', name: 'read', arguments: '{}', extra: { extra_content: SIGNATURE },
  }] });
  c.toolResult('c', 'alpha');
  const replayed = Conversation.fromJSON(JSON.parse(JSON.stringify(c.messages)));
  assert.deepEqual(replayed.messages[1].tool_calls[0].extra_content, SIGNATURE);
});

// --- against the real bytes --------------------------------------------------

test("Google's captured tool call really does carry a thought_signature", () => {
  // If this ever fails, Google stopped sending it and the rest of this file is
  // guarding a problem that no longer exists — which is worth being told.
  const capture = listCaptures().find((c) => c.name === 'google-tools.sse');
  assert.ok(capture, 'no google-tools.sse capture — re-probe Google');
  const chunks = String(readCapture(capture.name)).split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter((d) => d && d !== '[DONE]')
    .map((d) => JSON.parse(d));

  const calls = assemble(chunks);
  assert.ok(calls.length > 0, 'the capture has no tool call in it');
  assert.ok(calls[0].extra?.extra_content?.google?.thought_signature,
    'the signature is in the capture but did not survive assembly');
});

test('every captured tool call round-trips its provider fields into a request', () => {
  // The end-to-end property, over whatever captures exist: whatever a provider
  // attached to a call is on the message we would send back. This is the test
  // that would have caught the bug on 2026-09-12.
  const toolCaptures = listCaptures().filter((c) => c.name.includes('-tools'));
  assert.ok(toolCaptures.length > 0, 'no tool captures — this test is blind');

  for (const { name } of toolCaptures) {
    const chunks = String(readCapture(name)).split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter((d) => d && d !== '[DONE]')
      .map((d) => JSON.parse(d));

    const calls = assemble(chunks);
    if (calls.length === 0) continue;

    const c = new Conversation();
    c.user('go');
    c.assistant({ content: '', toolCalls: calls });
    const sent = c.messages[1].tool_calls;

    for (const [i, call] of calls.entries()) {
      for (const key of Object.keys(call.extra ?? {})) {
        assert.deepEqual(sent[i][key], call.extra[key],
          `${name}: ${key} was dropped between the response and the next request`);
      }
    }
  }
});
