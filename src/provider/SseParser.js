// Incremental Server-Sent Events decoding.
//
// fetch() yields bytes, not lines. A `data:` line can be split across two
// chunks, and it can be split *mid-UTF-8-sequence* -- decoding each chunk
// independently turns a multi-byte character into two replacement characters,
// silently, in the middle of someone's source code. So the decoder is stateful
// and the buffer is text, never bytes.
//
// Framing, per the WHATWG spec, and all of it observed in the wild:
//   - events are separated by a blank line
//   - a line beginning ":" is a comment (some providers use these as keepalives)
//   - "field: value" -- exactly one leading space after the colon is stripped
//   - repeated "data" fields join with "\n"
//   - "\r\n", "\n" and a lone "\r" are all line terminators

const FIELD = /^([^:]*)(?::[ ]?([\s\S]*))?$/;

export class SseParser {
  #decoder = new TextDecoder('utf-8');
  #buffer = '';
  #done = false;

  // Feed a chunk, get back whatever complete events it completed. Bytes or a
  // string; a string is assumed already decoded and is not re-buffered.
  push(chunk) {
    if (this.#done) throw new Error('SseParser: push() after end()');
    this.#buffer += typeof chunk === 'string'
      ? chunk
      : this.#decoder.decode(chunk, { stream: true });
    return this.#drain(false);
  }

  // Flush. A stream that ends without a trailing blank line still has one event
  // in it, and providers do end that way.
  end() {
    if (this.#done) return [];
    this.#done = true;
    this.#buffer += this.#decoder.decode();
    return this.#drain(true);
  }

  #drain(final) {
    const events = [];

    for (;;) {
      const boundary = findBoundary(this.#buffer);
      if (boundary === -1) break;
      const block = this.#buffer.slice(0, boundary.start);
      this.#buffer = this.#buffer.slice(boundary.end);
      const ev = parseBlock(block);
      if (ev) events.push(ev);
    }

    if (final && this.#buffer.trim() !== '') {
      const ev = parseBlock(this.#buffer);
      if (ev) events.push(ev);
      this.#buffer = '';
    }
    return events;
  }
}

// A blank line ends an event. Returns where the block stops and where the next
// one starts, since the separator may be 2 or 4 characters.
function findBoundary(s) {
  let best = -1;
  let len = 0;
  for (const sep of ['\r\n\r\n', '\n\n', '\r\r']) {
    const i = s.indexOf(sep);
    if (i !== -1 && (best === -1 || i < best)) { best = i; len = sep.length; }
  }
  return best === -1 ? -1 : { start: best, end: best + len };
}

function parseBlock(block) {
  const data = [];
  let event, id, retry;

  for (const line of block.split(/\r\n|\n|\r/)) {
    if (line === '') continue;
    if (line.startsWith(':')) continue; // comment / keepalive

    const m = FIELD.exec(line);
    if (!m) continue;
    const field = m[1];
    const value = m[2] ?? '';

    switch (field) {
      case 'data': data.push(value); break;
      case 'event': event = value; break;
      case 'id': id = value; break;
      case 'retry': { const n = Number(value); if (Number.isInteger(n)) retry = n; break; }
      default: break; // unknown fields are ignored, per spec
    }
  }

  if (data.length === 0 && event === undefined && id === undefined && retry === undefined) return null;
  return { data: data.join('\n'), event, id, retry };
}

// Convenience over a fetch() body. Yields events as they complete.
export async function* streamEvents(body) {
  const parser = new SseParser();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const ev of parser.push(value)) yield ev;
    }
    for (const ev of parser.end()) yield ev;
  } finally {
    reader.releaseLock?.();
  }
}

// The OpenAI convention layered on top: every event's data is a JSON object,
// except the terminator, which is the literal string [DONE].
export const DONE = Symbol('sse-done');

export function parseData(data) {
  if (data === '[DONE]') return DONE;
  return JSON.parse(data);
}
