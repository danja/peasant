// A small JSON Schema validator -- enough for tool parameters, and no more.
//
// It exists so that the schema a model is *shown* and the schema its arguments
// are *checked against* are the same object. Two copies would drift, and the
// drift would show up as a model being told one thing and refused for doing it.
//
// Deliberately a subset: object, string, number, integer, boolean, array, with
// required, enum, and simple bounds. A tool needing more than this is probably
// a tool that should be two tools. Anything unrecognised in a schema is an
// error at definition time, not something quietly ignored at call time.

const TYPES = ['object', 'string', 'number', 'integer', 'boolean', 'array'];
const KEYWORDS = [
  'type', 'description', 'properties', 'required', 'additionalProperties',
  'enum', 'items', 'minimum', 'maximum', 'minLength', 'maxLength', 'default',
];

// Checked when a tool is defined, so a malformed schema cannot reach a model.
export function assertValidSchema(schema, path = 'parameters') {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`${path}: must be an object`);
  }
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.includes(key)) {
      throw new Error(`${path}: unsupported schema keyword ${JSON.stringify(key)}; supported: ${KEYWORDS.join(', ')}`);
    }
  }
  if (!schema.type) throw new Error(`${path}: type is required`);
  if (!TYPES.includes(schema.type)) {
    throw new Error(`${path}: unsupported type ${JSON.stringify(schema.type)}; supported: ${TYPES.join(', ')}`);
  }
  if (schema.type === 'object') {
    if (!schema.properties || typeof schema.properties !== 'object') {
      throw new Error(`${path}: an object schema needs properties`);
    }
    for (const [name, sub] of Object.entries(schema.properties)) {
      assertValidSchema(sub, `${path}.${name}`);
      if (!sub.description) throw new Error(`${path}.${name}: every property needs a description -- the model reads it`);
    }
    for (const name of schema.required ?? []) {
      if (!(name in schema.properties)) {
        throw new Error(`${path}: required names ${JSON.stringify(name)}, which is not a property`);
      }
    }
  }
  if (schema.type === 'array') {
    if (!schema.items) throw new Error(`${path}: an array schema needs items`);
    assertValidSchema(schema.items, `${path}.items`);
  }
  if (schema.enum && !Array.isArray(schema.enum)) throw new Error(`${path}: enum must be an array`);
}

// Returns a list of human-readable problems, empty when the value conforms.
// Messages are written to be handed back to the model, so they say what was
// expected rather than merely that something was wrong.
export function validate(value, schema, path = '') {
  const where = path || 'argument';
  const errors = [];

  if (schema.enum && !schema.enum.includes(value)) {
    return [`${where} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}; got ${JSON.stringify(value)}`];
  }

  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return [`${where} must be an object`];
      }
      for (const name of schema.required ?? []) {
        if (value[name] === undefined) errors.push(`${where ? `${where}.` : ''}${name} is required`);
      }
      for (const [name, sub] of Object.entries(schema.properties ?? {})) {
        if (value[name] === undefined) continue;
        errors.push(...validate(value[name], sub, path ? `${path}.${name}` : name));
      }
      if (schema.additionalProperties === false) {
        for (const name of Object.keys(value)) {
          if (!(name in (schema.properties ?? {}))) {
            errors.push(`${where} has no parameter ${JSON.stringify(name)}`);
          }
        }
      }
      break;
    }
    case 'string': {
      if (typeof value !== 'string') { errors.push(`${where} must be a string`); break; }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`${where} must be at least ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`${where} must be at most ${schema.maxLength} characters`);
      }
      break;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push(`${where} must be a number`); break; }
      if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(`${where} must be a whole number`);
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${where} must be at least ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${where} must be at most ${schema.maximum}`);
      break;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') errors.push(`${where} must be true or false`);
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) { errors.push(`${where} must be an array`); break; }
      value.forEach((item, i) => errors.push(...validate(item, schema.items, `${path}[${i}]`)));
      break;
    }
    default: break;
  }

  return errors;
}

// Fills in declared defaults. Models routinely omit an optional parameter that
// has one, and the alternative is every tool writing `args.x ?? default` --
// which is the inline fallback CLAUDE.md forbids, scattered.
//
// An empty string counts as omitted, but *only* where a default is declared.
// Observed live: a model sent `glob {"path":"","pattern":"greet.js"}`, meaning
// "from the top", and got "path must be a non-empty string" -- a wasted turn
// and a wasted minute of budget over a value whose intent was not in doubt.
// Where no default is declared an empty string is kept, because for `edit.new`
// it means "delete this text" and is entirely meaningful.
export function withDefaults(value, schema) {
  if (schema.type !== 'object') return value;
  const out = { ...value };
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    if (sub.default === undefined) continue;
    if (out[name] === undefined || out[name] === '') out[name] = sub.default;
  }
  return out;
}
