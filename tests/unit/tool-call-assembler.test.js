import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallAssembler, assemble } from '../../src/provider/ToolCallAssembler.js';
import { SseParser, parseData, DONE } from '../../src/provider/SseParser.js';
import { listCaptures, readCapture } from './lib/fixtures.js';

function feed(...batches) {
  const a = new ToolCallAssembler();
  for (const b of batches) a.push(b);
  return a.finish();
}

test('assembles the whole-in-one-delta shape Groq and Mistral use', () => {
  const [c] = feed([{
    id: 'fc_1', type: 'function', index: 0,
    function: { name: 'get_weather', arguments: '{"city":"Paris","unit":"c"}' },
  }]);
  assert.equal(c.id, 'fc_1');
  assert.equal(c.name, 'get_weather');
  assert.ok(c.valid);
  assert.deepEqual(c.args, { city: 'Paris', unit: 'c' });
});

test('assembles the incremental shape the OpenAI API uses', () => {
  const [c] = feed(
    [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }],
    [{ index: 0, function: { arguments: '{"ci' } }],
    [{ index: 0, function: { arguments: 'ty":"Par' } }],
    [{ index: 0, function: { arguments: 'is"}' } }],
  );
  assert.equal(c.id, 'call_1');
  assert.equal(c.name, 'get_weather');
  assert.deepEqual(c.args, { city: 'Paris' });
});

test('concatenates a name split across deltas', () => {
  // The spec permits it. Assigning instead of concatenating would keep only
  // "weather" and call a tool that does not exist.
  const [c] = feed(
    [{ index: 0, function: { name: 'get_' } }],
    [{ index: 0, function: { name: 'weather', arguments: '{}' } }],
  );
  assert.equal(c.name, 'get_weather');
});

test('keeps parallel tool calls apart, in first-seen order', () => {
  const calls = feed(
    [{ index: 1, id: 'b', function: { name: 'second', arguments: '{"x":' } }],
    [{ index: 0, id: 'a', function: { name: 'first', arguments: '{"y":1}' } }],
    [{ index: 1, function: { arguments: '2}' } }],
  );
  assert.deepEqual(calls.map((c) => c.name), ['second', 'first']);
  assert.deepEqual(calls.find((c) => c.id === 'b').args, { x: 2 });
  assert.deepEqual(calls.find((c) => c.id === 'a').args, { y: 1 });
});

test('treats a missing index as 0', () => {
  const calls = feed(
    [{ id: 'a', function: { name: 'f', arguments: '{"a":' } }],
    [{ function: { arguments: '1}' } }],
  );
  assert.equal(calls.length, 1, 'both deltas belong to the same call');
  assert.deepEqual(calls[0].args, { a: 1 });
});

test('an absent arguments field is a no-argument call, not a malformed one', () => {
  const [c] = feed([{ index: 0, id: 'a', function: { name: 'now' } }]);
  assert.ok(c.valid);
  assert.deepEqual(c.args, {});
});

test('reports malformed JSON instead of throwing', () => {
  // The model producing bad JSON happens. Throwing would take down the turn;
  // reporting lets the loop ask again.
  const [c] = feed([{ index: 0, id: 'a', function: { name: 'f', arguments: '{"unterminated' } }]);
  assert.equal(c.valid, false);
  assert.equal(c.args, null);
  assert.ok(c.error);
  assert.equal(c.arguments, '{"unterminated', 'the raw text is kept for diagnosis');
});

test('rejects arguments that are valid JSON but not an object', () => {
  for (const raw of ['[1,2]', '"a string"', '42', 'null']) {
    const [c] = feed([{ index: 0, id: 'a', function: { name: 'f', arguments: raw } }]);
    assert.equal(c.valid, false, `${raw} should not be accepted as arguments`);
    assert.match(c.error, /expected an object/);
  }
});

test('ignores null, undefined and non-array input', () => {
  const a = new ToolCallAssembler();
  a.push(undefined); a.push(null); a.push('nonsense'); a.push([null, 42]);
  assert.deepEqual(a.finish(), []);
});

// --- against the real captures -------------------------------------------

function chunksOf(name) {
  const p = new SseParser();
  const raw = readCapture(name);
  const events = [...p.push(raw), ...p.end()];
  return events.map((e) => parseData(e.data)).filter((d) => d !== DONE);
}

const toolCaptures = listCaptures().filter((c) => c.name.includes('-tools'));

for (const { name } of toolCaptures) {
  test(`${name}: assembles to exactly one valid tool call`, () => {
    // This is a test of the *dialect*, not of the model's judgement. Whether
    // the model filled the arguments in is its business; whether we reassemble
    // what it sent is ours. The free OpenRouter model called get_weather with
    // {} despite `city` being required, which is a model-choice question.
    const calls = assemble(chunksOf(name));
    assert.equal(calls.length, 1, `expected one tool call, got ${calls.length}`);
    const [c] = calls;
    assert.equal(c.name, 'get_weather', 'the tool the probe offered');
    assert.ok(c.id, 'a call with no id cannot be answered');
    assert.ok(c.valid, `arguments did not parse: ${c.error} -- ${c.arguments}`);
  });
}

test('arguments survive assembly where the model actually sent them', () => {
  // Proves the concatenation works against real bytes, from whichever captures
  // came from a model that filled the argument in.
  const withArgs = toolCaptures
    .map(({ name }) => ({ name, call: assemble(chunksOf(name))[0] }))
    .filter(({ call }) => Object.keys(call.args ?? {}).length > 0);

  assert.ok(withArgs.length > 0, 'no capture has a tool call with arguments -- re-probe');
  for (const { name, call } of withArgs) {
    assert.equal(call.args.city, 'Paris', `${name} lost the argument in assembly`);
  }
});

test('both dialects are represented in the captures', () => {
  // Groq and Mistral send the whole call in one delta; OpenRouter dribbles the
  // arguments in a second. If only one shape is captured, half the assembler
  // is untested against reality.
  const shapes = toolCaptures.map(({ name }) => {
    const deltas = chunksOf(name)
      .map((c) => c?.choices?.[0]?.delta?.tool_calls)
      .filter(Boolean);
    return { name, deltas: deltas.length };
  });
  assert.ok(shapes.some((s) => s.deltas === 1), `no whole-in-one-delta capture: ${JSON.stringify(shapes)}`);
  assert.ok(shapes.some((s) => s.deltas > 1), `no incremental capture: ${JSON.stringify(shapes)}`);
});

test('a plain content stream yields no tool calls', () => {
  const plain = listCaptures().find((c) => c.name.includes('-stream'));
  assert.deepEqual(assemble(chunksOf(plain.name)), []);
});
