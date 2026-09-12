// Reassembling tool calls from a stream.
//
// Two shapes exist in the wild and both must work:
//
//   whole      Groq and Mistral send id, name and the complete argument JSON in
//              a single delta at index 0 (measured 2026-09-12; captures in
//              docs/raw/2026-09-12_providers/*-tools.sse).
//   incremental  The OpenAI API sends the id and name in the first delta, then
//              dribbles `arguments` across many, keyed by `index`.
//
// The incremental shape is a superset, so the assembler simply concatenates
// everything and the whole-delta case falls out as the one-chunk special case.
// Writing it the other way round -- special-casing whole deltas -- is how a
// harness works against two providers and breaks on the third.
//
// A malformed argument string is reported, not thrown. The model producing
// invalid JSON is a thing that happens, and the loop can ask it again; an
// exception here would take the whole turn down instead.

export class ToolCallAssembler {
  #byIndex = new Map();
  #order = [];

  // Feed `delta.tool_calls` from each streamed chunk. Ignores null/undefined so
  // callers need not check.
  push(toolCalls) {
    if (!Array.isArray(toolCalls)) return;

    for (const d of toolCalls) {
      if (!d || typeof d !== 'object') continue;

      // Some providers omit index when there is only one call.
      const index = Number.isInteger(d.index) ? d.index : 0;

      if (!this.#byIndex.has(index)) {
        this.#byIndex.set(index, { index, id: null, type: 'function', name: '', arguments: '' });
        this.#order.push(index);
      }
      const acc = this.#byIndex.get(index);

      if (d.id) acc.id = d.id;
      if (d.type) acc.type = d.type;

      const fn = d.function;
      if (fn) {
        // Concatenated, not assigned: the spec permits a name split across
        // deltas, and assignment would keep only the last fragment.
        if (typeof fn.name === 'string') acc.name += fn.name;
        if (typeof fn.arguments === 'string') acc.arguments += fn.arguments;
      }
    }
  }

  get size() { return this.#byIndex.size; }

  // Everything assembled so far, in the order the indices first appeared.
  // `valid` says whether `arguments` parsed; `args` is the parsed object, or
  // null when it did not.
  finish() {
    return this.#order.map((i) => {
      const c = this.#byIndex.get(i);
      let args = null;
      let valid = false;
      let error = null;

      // An absent arguments field means a no-argument call, which is not the
      // same as a malformed one.
      const raw = c.arguments === '' ? '{}' : c.arguments;
      try {
        args = JSON.parse(raw);
        valid = args !== null && typeof args === 'object' && !Array.isArray(args);
        if (!valid) error = `arguments parsed to ${Array.isArray(args) ? 'an array' : typeof args}, expected an object`;
      } catch (e) {
        error = e.message;
      }

      return {
        index: c.index,
        id: c.id,
        type: c.type,
        name: c.name,
        arguments: c.arguments,
        args: valid ? args : null,
        valid,
        error,
      };
    });
  }
}

// Pulls tool-call deltas out of a whole stream of parsed chunks. Convenience
// for tests and for the non-streaming path, which gets the same shape.
export function assemble(chunks) {
  const a = new ToolCallAssembler();
  for (const c of chunks) {
    const calls = c?.choices?.[0]?.delta?.tool_calls ?? c?.choices?.[0]?.message?.tool_calls;
    a.push(calls);
  }
  return a.finish();
}
