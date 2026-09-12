// A tool is one declaration: what the model is told, what its arguments are
// checked against, and what actually happens. All three from the same object,
// so the schema the model sees and the schema enforced cannot drift.

import { assertValidSchema, validate, withDefaults } from './schema.js';
import { DEFAULTS } from '../config/preferences.js';

export class ToolError extends Error {
  constructor(message, { recoverable = true } = {}) {
    super(message);
    this.name = 'ToolError';
    // Recoverable means: tell the model and let it try again. Unrecoverable
    // means something is wrong with the environment, not with the call.
    this.recoverable = recoverable;
  }
}

// `external` is for schemas peasant did not write -- an MCP server's, say.
// They are passed to the provider as they came, because the server knows what
// it accepts, and only checked loosely here: strict validation would refuse a
// perfectly good schema for using a keyword this subset does not implement.
export function defineTool({ name, description, parameters, mutates, run, external = false }) {
  if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`tool name ${JSON.stringify(name)} must be lower snake case`);
  }
  if (!description) throw new Error(`tool ${name}: description is required -- the model chooses by it`);
  if (typeof mutates !== 'boolean') {
    throw new Error(`tool ${name}: mutates must be declared explicitly -- the permission policy reads it`);
  }
  if (typeof run !== 'function') throw new Error(`tool ${name}: run must be a function`);
  if (external) {
    if (!parameters || typeof parameters !== 'object') {
      throw new Error(`tool ${name}: parameters must be an object`);
    }
  } else {
    assertValidSchema(parameters, `${name}.parameters`);
  }

  return Object.freeze({
    name,
    description,
    parameters,
    mutates,
    external,

    // What goes in the provider request. One place, so every provider gets the
    // same declaration.
    get spec() {
      return { type: 'function', function: { name, description, parameters } };
    },

    // Checks arguments against the advertised schema and fills declared
    // defaults. Errors come back as text for the model, because a model sending
    // the wrong shape is a normal event that it can correct.
    prepare(args) {
      // Defaults are applied *before* validation, not after: a model sending
      // "" for a parameter that has a default means "use the default", and
      // validating first would reject it for a minLength it was never going
      // to violate once filled in.
      const filled = withDefaults(args ?? {}, parameters);
      const errors = validate(filled, parameters);
      if (errors.length > 0) {
        throw new ToolError(`invalid arguments for ${name}: ${errors.join('; ')}`);
      }
      return filled;
    },

    async invoke(args, context) {
      const prepared = this.prepare(args);
      const result = await run(prepared, context);
      return truncate(result, context?.maxChars ?? DEFAULTS.maxToolResultChars);
    },
  });
}

// A tool result is charged against the token budget, and at Groq's measured
// 8,000 tokens a minute one careless file read costs most of a minute. So the
// cap is applied here, once, rather than trusted to each tool -- and it keeps
// the head *and* the tail, because the end of a stack trace or a diff is
// usually where the answer is.
export function truncate(text, maxChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;

  const keep = Math.floor(maxChars / 2) - 40;
  const head = s.slice(0, keep);
  const tail = s.slice(-keep);
  const omitted = s.length - head.length - tail.length;
  return `${head}\n\n... [${omitted} characters omitted of ${s.length}] ...\n\n${tail}`;
}
