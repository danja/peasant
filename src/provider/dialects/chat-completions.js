// The OpenAI chat-completions wire format.
//
// This is what every provider in profiles/ spoke when there was only one shape,
// and it remains the default. The code here was lifted out of Client.js
// unchanged: the client kept the transport, the limiter and the failure
// classification, and handed the *format* to a dialect so a second one could
// exist without the loop learning about it.
//
// A dialect is the answer to "what does the wire look like", never "who is on
// the other end". Anything that varies per provider inside one format -- a
// header name, a reasoning field -- stays a profile field.

// Normalising into the streamed OpenAI tool-call delta shape is the contract
// every dialect meets, because ToolCallAssembler already handles both the
// whole-in-one-delta and the dribbled-arguments cases and has fixtures for
// both. A dialect that invented its own shape would need its own assembler.

export default {
  name: 'chat-completions',
  completionPath: '/chat/completions',
  modelsPath: '/models',

  // Anthropic requires max_tokens; OpenAI does not, and sending one where it
  // was never sent before would change every existing provider's behaviour.
  requiresMaxTokens: false,

  headers: () => ({}),

  buildBody(request, ctx) {
    const { messages, model, tools, toolChoice, maxTokens, temperature, stream } = request;
    const body = {
      model,
      messages,
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      ...(temperature === undefined ? {} : { temperature }),
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = toolChoice ?? 'auto';
    }
    if (stream) {
      body.stream = true;
      // Without this a streamed response reports no token count and the
      // budgeter is blind. Both measured providers honour it.
      if (ctx.profile.includeUsage) body.stream_options = { include_usage: true };
    }
    return body;
  },

  parseModels(parsed) {
    return parsed.data ?? parsed.models ?? [];
  },

  parseComplete(parsed, ctx) {
    const choice = parsed.choices?.[0] ?? {};
    return {
      model: parsed.model ?? null,
      content: choice.message?.content ?? '',
      reasoning: readReasoning(choice.message, ctx.profile) ?? '',
      toolCallDeltas: choice.message?.tool_calls ?? null,
      usage: parsed.usage ?? null,
      finishReason: choice.finish_reason ?? null,
    };
  },

  parseEvent(ev, ctx) {
    const choice = ev.chunk.choices?.[0];
    const delta = choice?.delta ?? {};
    return {
      model: ev.chunk.model ?? null,
      usage: ev.chunk.usage ?? null,
      finishReason: choice?.finish_reason ?? null,
      text: typeof delta.content === 'string' ? delta.content : '',
      reasoning: readReasoning(delta, ctx.profile) ?? '',
      toolCallDeltas: delta.tool_calls ?? null,
    };
  },

  errorDetail(parsed) {
    return parsed?.error?.message ?? parsed?.message ?? null;
  },
};

// Fields in a delta that carry the model's private reasoning. Which ones a
// provider uses is a profile fact, not a format fact -- Groq's gpt-oss models
// send `reasoning` where others send `reasoning_content`.
function readReasoning(obj, profile) {
  if (!obj) return null;
  for (const field of profile.reasoningFields) {
    if (typeof obj[field] === 'string' && obj[field] !== '') return obj[field];
  }
  return null;
}
