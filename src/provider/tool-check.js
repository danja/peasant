// Can this provider's selected model actually make a tool call?
//
// It is the one thing a coding harness cannot work without, and it is a
// property of the *model*, not the provider: Hugging Face's first choice
// answered `422 UNSUPPORTED_OPENAI_PARAMS: tools, tool_choice`, and the only
// way to know is to ask.
//
// Preference lists are where this project's failures live. Four of six were
// written from documentation and four of six were wrong (`docs/providers.md`),
// and the fifth was worse than all of them: NVIDIA's `/llama-3\.[13]/` matched
// a content-safety classifier, which answered **HTTP 200**. Nothing rotated,
// nothing warned, and the only reason it was caught is that an unrelated probe
// hung. `selectModel` compares an id against a regex; until this existed,
// nothing anywhere asked the model to do the job.
//
// The request is deliberately the smallest one that can prove it: a trivial
// tool, one sentence, a low output ceiling.

import { validate } from '../tools/schema.js';

// One definition, two users -- this and `bin/probe-providers.js`, which used to
// carry its own copy. A check and the probe that informs it disagreeing about
// the question they ask is the kind of drift CLAUDE.md has a table for.
export const CHECK_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
        unit: { type: 'string', enum: ['c', 'f'], description: 'Temperature unit' },
      },
      required: ['city'],
    },
  },
});

const PROMPT = 'What is the weather in Paris? Use the tool.';

// Why the answer is what it is, in the order the outcomes matter. `ok` is the
// only passing state; everything else names a different remedy.
export const OUTCOMES = Object.freeze({
  ok: 'made a tool call with valid arguments',
  noToolCall: 'answered, but made no tool call',
  badArguments: 'made a tool call whose arguments do not match the schema it was given',
  refused: 'refused the request',
  failed: 'could not be reached',
});

// Never throws. A check that takes the session down when a provider is having a
// bad afternoon is worse than no check: this is a diagnostic, and every failure
// it can see is a result rather than an error.
export async function checkToolCall(client, { signal, timeoutMs } = {}) {
  if (!timeoutMs) {
    // No inline fallback: a caller that forgot the budget would otherwise get a
    // check that can hang forever, which is the one thing this is meant not to
    // do. It comes from preferences.js like every other tunable.
    throw new Error('checkToolCall needs timeoutMs (preferences.toolCheckTimeoutMs)');
  }

  const started = Date.now();

  // Two reasons to stop: the user pressed Ctrl-C, or the provider went quiet.
  // They want different messages, so the timeout is tracked separately rather
  // than inferred from an AbortError that could be either.
  const onTimeout = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; onTimeout.abort(); }, timeoutMs);
  const combined = signal ? AbortSignal.any([signal, onTimeout.signal]) : onTimeout.signal;

  let result;
  try {
    result = await client.complete({
      messages: [{ role: 'user', content: PROMPT }],
      tools: [CHECK_TOOL],
      toolChoice: 'auto',
      maxTokens: 128,
      temperature: 0,
      signal: combined,
    });
  } catch (e) {
    if (!timedOut && signal?.aborted) throw e;      // Ctrl-C is not a result.
    return {
      provider: client.name,
      model: client.model,
      outcome: timedOut ? 'failed' : (e?.status === 400 || e?.kind === 'bad-request' ? 'refused' : 'failed'),
      detail: timedOut ? `no answer within ${timeoutMs} ms` : String(e?.message ?? e),
      ms: Date.now() - started,
      usage: null,
    };
  } finally {
    clearTimeout(timer);
  }

  const ms = Date.now() - started;
  const base = { provider: client.name, model: result.model ?? client.model, ms, usage: result.usage ?? null };
  const call = result.toolCalls?.[0];

  if (!call) {
    // The guardrail case. It answers, it is polite, and it is useless -- so the
    // detail carries what it said instead, because "no tool call" on its own
    // sends the reader back to the provider to find out why.
    const said = (result.content ?? '').trim().replace(/\s+/g, ' ');
    return {
      ...base,
      outcome: 'noToolCall',
      detail: said ? `said: ${said.slice(0, 120)}${said.length > 120 ? '…' : ''}` : 'and said nothing either',
    };
  }

  // Arguments that did not parse at all are a different fault from arguments
  // that parsed and do not fit, and `args` is null in the first case -- so
  // validating `args ?? {}` would report a missing `city` on a model whose real
  // problem was emitting broken JSON. The assembler already drew this
  // distinction; throwing it away here would waste it.
  if (!call.valid) {
    return { ...base, outcome: 'badArguments', detail: `arguments are not valid JSON: ${call.error}` };
  }

  // Validated with the project's own validator against the schema the model was
  // shown, so the schema advertised is the schema checked -- the same rule
  // `tests/guard/tool-schema.test.js` holds the real tools to. A model that
  // calls `get_weather({})` has technically made a tool call and has not done
  // the job; OpenRouter's free `cohere/north-mini-code` did exactly that.
  const errors = validate(call.args, CHECK_TOOL.function.parameters);
  if (errors.length > 0) {
    return { ...base, outcome: 'badArguments', detail: errors.join('; ') };
  }

  return { ...base, outcome: 'ok', detail: `${call.name}(${JSON.stringify(call.args)})` };
}
