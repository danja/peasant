import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, parseData, DONE } from '../../src/provider/SseParser.js';
import { listCaptures, readCapture } from './lib/fixtures.js';

const enc = (s) => new TextEncoder().encode(s);

function parseAll(input, chunkSize = Infinity) {
  const bytes = typeof input === 'string' ? enc(input) : input;
  const p = new SseParser();
  const out = [];
  if (chunkSize === Infinity) {
    out.push(...p.push(bytes));
  } else {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      out.push(...p.push(bytes.subarray(i, i + chunkSize)));
    }
  }
  out.push(...p.end());
  return out;
}

test('parses a single event', () => {
  assert.deepEqual(parseAll('data: hello\n\n'), [{ data: 'hello', event: undefined, id: undefined, retry: undefined }]);
});

test('joins repeated data fields with a newline', () => {
  assert.equal(parseAll('data: one\ndata: two\n\n')[0].data, 'one\ntwo');
});

test('strips exactly one space after the colon', () => {
  assert.equal(parseAll('data:  two spaces\n\n')[0].data, ' two spaces');
  assert.equal(parseAll('data:none\n\n')[0].data, 'none');
});

test('ignores comment lines used as keepalives', () => {
  assert.deepEqual(parseAll(': ping\n\ndata: real\n\n').map((e) => e.data), ['real']);
});

test('a field with no value is an empty string', () => {
  assert.equal(parseAll('data\n\n')[0].data, '');
});

test('handles CRLF and lone CR terminators', () => {
  assert.equal(parseAll('data: a\r\n\r\n')[0].data, 'a');
  assert.equal(parseAll('data: b\r\r')[0].data, 'b');
});

test('reads event, id and retry fields', () => {
  const [e] = parseAll('event: update\nid: 7\nretry: 250\ndata: x\n\n');
  assert.equal(e.event, 'update');
  assert.equal(e.id, '7');
  assert.equal(e.retry, 250);
});

test('ignores unknown fields', () => {
  assert.equal(parseAll('nonsense: x\ndata: y\n\n')[0].data, 'y');
});

test('flushes a trailing event with no blank line', () => {
  // Providers do end this way. Without end() the last token is silently lost.
  assert.deepEqual(parseAll('data: last').map((e) => e.data), ['last']);
});

test('emits nothing for a stream of only whitespace', () => {
  assert.deepEqual(parseAll('\n\n\n\n'), []);
});

test('push after end is an error, not silence', () => {
  const p = new SseParser();
  p.end();
  assert.throws(() => p.push(enc('data: x\n\n')), /push\(\) after end\(\)/);
});

test('an event split across chunks is not lost or doubled', () => {
  const src = 'data: {"a":1}\n\ndata: {"a":2}\n\n';
  for (let size = 1; size <= src.length; size++) {
    assert.deepEqual(parseAll(src, size).map((e) => e.data), ['{"a":1}', '{"a":2}'],
      `failed at chunk size ${size}`);
  }
});

test('a multi-byte character split mid-sequence survives', () => {
  // The bug this pins: decoding each chunk independently turns one character
  // into two replacement characters, silently, inside someone's source code.
  const text = 'data: café — naïve 日本語 🎯\n\n';
  const bytes = enc(text);
  for (let size = 1; size <= 8; size++) {
    const got = parseAll(bytes, size);
    assert.equal(got.length, 1, `chunk size ${size}`);
    assert.equal(got[0].data, 'café — naïve 日本語 🎯', `chunk size ${size}`);
    assert.ok(!got[0].data.includes('�'), `replacement character at chunk size ${size}`);
  }
});

test('parseData recognises the OpenAI terminator', () => {
  assert.equal(parseData('[DONE]'), DONE);
  assert.deepEqual(parseData('{"a":1}'), { a: 1 });
});

// --- against the real captures -------------------------------------------

const captures = listCaptures();

test('there are real provider captures to test against', () => {
  assert.ok(captures.length >= 2,
    'expected SSE captures in docs/raw/*_providers -- run: node bin/probe-providers.js');
});

for (const { name } of captures) {
  test(`${name}: parses, ends with [DONE], and every event is JSON`, () => {
    const events = parseAll(readCapture(name));
    // Mistral answers a tool call in three events: role delta, the whole tool
    // call, [DONE]. Two is the floor that still proves framing worked.
    assert.ok(events.length >= 2, `only ${events.length} events`);

    const datas = events.map((e) => e.data);
    assert.equal(datas.at(-1), '[DONE]', 'stream must terminate with [DONE]');

    for (const d of datas.slice(0, -1)) {
      assert.doesNotThrow(() => JSON.parse(d), `not JSON: ${d.slice(0, 80)}`);
    }
  });

  test(`${name}: byte-at-a-time gives the identical result`, () => {
    // The whole point of the parser. If this diverges, so does every stream
    // that arrives over a slow connection.
    const whole = parseAll(readCapture(name));
    const dribbled = parseAll(readCapture(name), 1);
    assert.deepEqual(dribbled, whole);
  });

  test(`${name}: stable across every chunk size up to 64`, () => {
    const expected = parseAll(readCapture(name));
    for (let size = 2; size <= 64; size++) {
      assert.deepEqual(parseAll(readCapture(name), size), expected, `chunk size ${size}`);
    }
  });
}
