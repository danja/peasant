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
//
// Anything on a tool call that is *not* one of the four fields below is kept
// verbatim in `extra` and handed back untouched. Gemini 3.x is why: it attaches
// `extra_content.google.thought_signature` to every function call and rejects
// the next turn with a 400 if it does not come back. Reading only the fields we
// understand is what lost it, and that capture had been in `docs/raw/` since
// the day Google was first probed. A provider may add a field that becomes
// mandatory; keeping what we do not understand costs nothing and is the only
// thing that survives that.

// The fields this assembler interprets. Everything else on a delta is the
// provider's own and is preserved rather than dropped.
const KNOWN = new Set(['index', 'id', 'type', 'function']);

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
        this.#byIndex.set(index, { index, id: null, type: 'function', name: '', arguments: '', extra: {} });
        this.#order.push(index);
      }
      const acc = this.#byIndex.get(index);

      if (d.id) acc.id = d.id;
      if (d.type) acc.type = d.type;

      // Assigned, not concatenated: an unknown field is an opaque value, and
      // the only safe assumption about a value we do not understand is that the
      // provider meant the whole of it. A signature arrives once, in the delta
      // that opens the call, and later deltas carry only argument text.
      for (const [k, v] of Object.entries(d)) {
        if (!KNOWN.has(k) && v !== undefined) acc.extra[k] = v;
      }

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
        // null rather than {} when there is nothing, so a caller can spread it
        // without asking, and so the common case adds nothing to a session
        // record.
        extra: Object.keys(c.extra).length > 0 ? { ...c.extra } : null,
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
