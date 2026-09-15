// The Anthropic Messages wire format (`POST /v1/messages`).
//
// UNVERIFIED against a live endpoint. Every shape below is written from the
// published format, not from a captured response, because verifying it costs
// the credentials of whoever runs it. Until `bin/probe-providers.js` has been
// pointed at it and a capture lives in docs/raw/, treat this file as a claim.
// See MAINTAINER.md.
//
// Four things differ from chat-completions and all four are load-bearing:
//
//   1. The system prompt is a top-level parameter, not a message with a role.
//   2. A tool result is a *user* message carrying a tool_result block, not a
//      role of its own -- and every result for one assistant turn must arrive
//      in a single user message, or the API rejects the turn.
//   3. max_tokens is required. There is no server-side default to fall back on.
//   4. Streaming is named events over content-block indices, not one delta
//      object per chunk.
//
// Everything this produces is normalised into the OpenAI shapes the rest of
// peasant already reads: tool calls as streamed tool_call deltas, usage as
// prompt_tokens/completion_tokens. Translating at the edge is what keeps
// ToolCallAssembler, TokenEstimator and EventPrinter ignorant of who answered.

const ROLE_STOP = Object.freeze({
  end_turn: 'stop',
  max_tokens: 'length',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
  pause_turn: 'stop',
});

export default {
  name: 'messages',
  completionPath: '/messages',
  modelsPath: '/models',
  requiresMaxTokens: true,

  // No inline fallback: a profile that speaks this format without saying which
  // version of it is a profile to fix, not a request to send with a guessed
  // version and find out.
  headers: (ctx) => {
    if (!ctx.profile.apiVersion) {
      throw new Error(`profile ${ctx.profile.name}: the messages format requires apiVersion`);
    }
    return { 'anthropic-version': ctx.profile.apiVersion };
  },

  buildBody(request, ctx) {
    const { messages, model, tools, toolChoice, maxTokens, temperature, stream } = request;

    const { system, turns } = translateMessages(messages);
    const body = {
      model,
      max_tokens: maxTokens,
      messages: turns,
      ...(system.length ? { system } : {}),
      ...(temperature === undefined ? {} : { temperature }),
    };
    if (tools?.length) {
      body.tools = tools.map(translateTool);
      body.tool_choice = translateToolChoice(toolChoice);
    }
    if (stream) body.stream = true;
    return body;
  },

  parseModels(parsed) {
    return parsed.data ?? [];
  },

  parseComplete(parsed) {
    let content = '';
    let reasoning = '';
    const toolCallDeltas = [];

    for (const block of parsed.content ?? []) {
      if (block.type === 'text') content += block.text ?? '';
      else if (block.type === 'thinking') reasoning += block.thinking ?? '';
      else if (block.type === 'tool_use') {
        toolCallDeltas.push({
          index: toolCallDeltas.length,
          id: block.id,
          type: 'function',
          // Serialised back to a string because the assembler's contract is a
          // JSON string it concatenates -- the same path the streamed case
          // takes, so both arrive at one parse rather than two.
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      }
    }

    return {
      model: parsed.model ?? null,
      content,
      reasoning,
      toolCallDeltas: toolCallDeltas.length ? toolCallDeltas : null,
      usage: translateUsage(parsed.usage),
      finishReason: ROLE_STOP[parsed.stop_reason] ?? parsed.stop_reason ?? null,
    };
  },

  // `state` persists across one stream. Anthropic keys its deltas by content
  // block index, and a block index is not a tool call index -- a response with
  // text at index 0 and a tool_use at index 1 has exactly one tool call, at
  // tool index 0. Conflating the two numbers puts the arguments on a call that
  // does not exist.
  parseEvent(ev, ctx, state) {
    const chunk = ev.chunk;
    const kind = ev.name ?? chunk.type;
    state.toolIndexByBlock ??= new Map();
    state.toolCount ??= 0;

    switch (kind) {
      case 'message_start':
        // input_tokens arrives here and nowhere else; output_tokens is restated
        // in message_delta. Held on the state so the final usage can carry both.
        state.usage = translateUsage(chunk.message?.usage);
        return { model: chunk.message?.model ?? null, usage: null };

      case 'content_block_start': {
        const block = chunk.content_block ?? {};
        if (block.type !== 'tool_use') return null;
        const index = state.toolCount++;
        state.toolIndexByBlock.set(chunk.index, index);
        return {
          toolCallDeltas: [{
            index,
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: '' },
          }],
        };
      }

      case 'content_block_delta': {
        const delta = chunk.delta ?? {};
        if (delta.type === 'text_delta') return { text: delta.text ?? '' };
        if (delta.type === 'thinking_delta') return { reasoning: delta.thinking ?? '' };
        if (delta.type === 'input_json_delta') {
          const index = state.toolIndexByBlock.get(chunk.index);
          // A delta for a block we never saw start is not ours to guess at.
          if (index === undefined) return null;
          return {
            toolCallDeltas: [{
              index,
              function: { arguments: delta.partial_json ?? '' },
            }],
          };
        }
        return null;
      }

      case 'message_delta': {
        const usage = mergeUsage(state.usage, translateUsage(chunk.usage));
        state.usage = usage;
        return {
          usage,
          finishReason: ROLE_STOP[chunk.delta?.stop_reason] ?? chunk.delta?.stop_reason ?? null,
        };
      }

      // An error mid-stream is a real failure and must not read as a clean end.
      case 'error':
        throw new Error(chunk.error?.message ?? 'the provider ended the stream with an error');

      default:
        return null;
    }
  },

  errorDetail(parsed) {
    return parsed?.error?.message ?? null;
  },
};

// --- translation -----------------------------------------------------------

// OpenAI-shaped messages in, Anthropic turns out. The system prompt is lifted
// out entirely; consecutive tool results are gathered into one user message.
function translateMessages(messages) {
  const system = [];
  const turns = [];

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) system.push({ type: 'text', text: String(m.content) });
      continue;
    }

    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: String(m.content ?? ''),
      };
      // Appended to the previous user turn when that turn is itself tool
      // results: the API requires every result for one assistant turn in a
      // single user message, and emitting one message each is rejected.
      const last = turns.at(-1);
      if (last?.role === 'user' && last.content.every((b) => b.type === 'tool_result')) {
        last.content.push(block);
      } else {
        turns.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (m.role === 'user') {
      turns.push({ role: 'user', content: [{ type: 'text', text: String(m.content ?? '') }] });
      continue;
    }

    if (m.role === 'assistant') {
      const content = [];
      // An empty text block is rejected, and Conversation stores null content
      // for an assistant turn that was only a tool call.
      if (m.content) content.push({ type: 'text', text: String(m.content) });
      for (const call of m.tool_calls ?? []) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.function?.name,
          input: parseArguments(call.function?.arguments),
        });
      }
      if (content.length) turns.push({ role: 'assistant', content });
      continue;
    }

    throw new Error(`messages dialect: unknown role ${JSON.stringify(m.role)}`);
  }

  return { system, turns };
}

// The arguments we stored are a JSON string the model produced. It reaches here
// only after ToolCallAssembler declared it valid, so a failure is a bug in
// peasant rather than in the model -- but taking a whole conversation down on
// replay would be worse than sending an empty object and letting the model see
// its own call again.
function parseArguments(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function translateTool(tool) {
  const fn = tool.function ?? tool;
  return {
    name: fn.name,
    description: fn.description,
    input_schema: fn.parameters ?? { type: 'object', properties: {} },
  };
}

function translateToolChoice(choice) {
  if (choice === undefined || choice === null || choice === 'auto') return { type: 'auto' };
  if (choice === 'required' || choice === 'any') return { type: 'any' };
  if (choice === 'none') return { type: 'none' };
  if (typeof choice === 'object' && choice.function?.name) {
    return { type: 'tool', name: choice.function.name };
  }
  throw new Error(`messages dialect: cannot express tool_choice ${JSON.stringify(choice)}`);
}

// Into the field names the budgeter and the printer already read. Cache reads
// and writes are input tokens that were genuinely spent, so they are counted:
// leaving them out would under-report a cached turn and teach TokenEstimator
// the wrong constant.
function translateUsage(usage) {
  if (!usage) return null;
  const input = (usage.input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0);
  const output = usage.output_tokens ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
  };
}

// message_start carries the input count, message_delta the final output count.
// Neither event has both, so the last usage reported must be the two merged.
function mergeUsage(first, second) {
  if (!first) return second;
  if (!second) return first;
  const prompt = second.prompt_tokens || first.prompt_tokens;
  const completion = second.completion_tokens || first.completion_tokens;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}
