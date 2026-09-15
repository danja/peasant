// The OpenAI Responses wire format (`POST .../responses`), which is what the
// Codex backend speaks.
//
// UNVERIFIED against a live endpoint, for the same reason as messages.js: a
// capture costs the credentials of whoever runs it. See MAINTAINER.md.
//
// It differs from chat-completions more than the name suggests. There is no
// `messages` array: there is an `input` list of *items*, where an assistant
// tool call and its result are two sibling items rather than a message and a
// reply. The system prompt is `instructions`. And the stream is named events
// carrying whole items, not deltas against one choice.
//
// As in messages.js, everything is normalised on the way out into the OpenAI
// shapes the rest of peasant reads.

const STATUS_STOP = Object.freeze({
  completed: 'stop',
  incomplete: 'length',
  failed: 'stop',
});

export default {
  name: 'responses',
  completionPath: '/responses',
  // The Codex backend publishes no catalogue. A profile supplies a static one
  // instead; see Client.listModelDetails.
  modelsPath: null,
  requiresMaxTokens: false,

  headers: () => ({}),

  buildBody(request, ctx) {
    const { messages, model, tools, toolChoice, maxTokens, temperature, stream } = request;
    const { instructions, input } = translateMessages(messages);

    const body = {
      model,
      input,
      ...(instructions ? { instructions } : {}),
      ...(maxTokens === undefined ? {} : { max_output_tokens: maxTokens }),
      ...(temperature === undefined ? {} : { temperature }),
      // Nothing about a local coding session should be retained server-side for
      // later retrieval. The harness keeps its own transcript in ~/.peasant.
      store: false,
    };
    if (tools?.length) {
      body.tools = tools.map(translateTool);
      body.tool_choice = toolChoice ?? 'auto';
    }
    if (stream) body.stream = true;
    return body;
  },

  parseModels(parsed) {
    return parsed.data ?? [];
  },

  parseComplete(parsed) {
    const response = parsed.response ?? parsed;
    let content = '';
    let reasoning = '';
    const toolCallDeltas = [];

    for (const item of response.output ?? []) {
      if (item.type === 'message') {
        for (const block of item.content ?? []) {
          if (block.type === 'output_text') content += block.text ?? '';
        }
      } else if (item.type === 'reasoning') {
        for (const block of item.summary ?? []) reasoning += block.text ?? '';
      } else if (item.type === 'function_call') {
        toolCallDeltas.push({
          index: toolCallDeltas.length,
          // call_id is what a result must quote back; id names the item. Using
          // the wrong one produces a result the model cannot match to its call.
          id: item.call_id ?? item.id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments ?? '' },
        });
      }
    }

    return {
      model: response.model ?? null,
      content,
      reasoning,
      toolCallDeltas: toolCallDeltas.length ? toolCallDeltas : null,
      usage: translateUsage(response.usage),
      finishReason: STATUS_STOP[response.status] ?? response.status ?? null,
    };
  },

  parseEvent(ev, ctx, state) {
    const chunk = ev.chunk;
    const kind = ev.name ?? chunk.type;
    state.toolIndexByItem ??= new Map();
    state.toolCount ??= 0;

    switch (kind) {
      case 'response.output_item.added': {
        const item = chunk.item ?? {};
        if (item.type !== 'function_call') return null;
        const index = state.toolCount++;
        // Keyed by both, because the argument deltas that follow are keyed by
        // item_id in some builds and by output_index in others, and a lookup
        // that misses silently drops every argument.
        if (item.id !== undefined) state.toolIndexByItem.set(`id:${item.id}`, index);
        if (chunk.output_index !== undefined) state.toolIndexByItem.set(`ix:${chunk.output_index}`, index);
        return {
          toolCallDeltas: [{
            index,
            id: item.call_id ?? item.id,
            type: 'function',
            function: { name: item.name, arguments: item.arguments ?? '' },
          }],
        };
      }

      case 'response.function_call_arguments.delta': {
        const index = state.toolIndexByItem.get(`id:${chunk.item_id}`)
          ?? state.toolIndexByItem.get(`ix:${chunk.output_index}`);
        if (index === undefined) return null;
        return { toolCallDeltas: [{ index, function: { arguments: chunk.delta ?? '' } }] };
      }

      case 'response.output_text.delta':
        return { text: chunk.delta ?? '' };

      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        return { reasoning: chunk.delta ?? '' };

      case 'response.completed':
      case 'response.incomplete':
        return {
          model: chunk.response?.model ?? null,
          usage: translateUsage(chunk.response?.usage),
          finishReason: STATUS_STOP[chunk.response?.status] ?? null,
        };

      case 'response.failed':
        throw new Error(chunk.response?.error?.message ?? 'the provider reported the response failed');

      case 'error':
        throw new Error(chunk.message ?? chunk.error?.message ?? 'the provider ended the stream with an error');

      default:
        return null;
    }
  },

  errorDetail(parsed) {
    return parsed?.error?.message ?? parsed?.detail ?? null;
  },
};

// --- translation -----------------------------------------------------------

// OpenAI chat messages in, Responses `input` items out.
function translateMessages(messages) {
  const instructions = [];
  const input = [];

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) instructions.push(String(m.content));
      continue;
    }

    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: String(m.content ?? ''),
      });
      continue;
    }

    if (m.role === 'user') {
      input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: String(m.content ?? '') }],
      });
      continue;
    }

    if (m.role === 'assistant') {
      if (m.content) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: String(m.content) }],
        });
      }
      // A tool call is its own item, a sibling of the message rather than a
      // field on it -- which is why an assistant turn can produce two entries.
      for (const call of m.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments ?? '{}',
        });
      }
      continue;
    }

    throw new Error(`responses dialect: unknown role ${JSON.stringify(m.role)}`);
  }

  return { instructions: instructions.join('\n\n'), input };
}

function translateTool(tool) {
  const fn = tool.function ?? tool;
  return {
    type: 'function',
    name: fn.name,
    description: fn.description,
    parameters: fn.parameters ?? { type: 'object', properties: {} },
  };
}

// Into the field names the budgeter and the printer already read. Reasoning
// tokens are reported separately and are most of a reasoning model's output,
// so they are carried through in the shape EventPrinter already looks for.
function translateUsage(usage) {
  if (!usage) return null;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: usage.total_tokens ?? input + output,
    ...(reasoning === undefined ? {} : { completion_tokens_details: { reasoning_tokens: reasoning } }),
  };
}
