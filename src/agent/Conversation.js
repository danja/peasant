// The message list, and the protocol rules that govern it.
//
// The one that bites: a `tool` message must follow the assistant message that
// requested it, and every tool call in that assistant message must be answered
// before anything else is said. Providers differ in how loudly they complain --
// some 400, some quietly produce nonsense -- so the invariant is enforced here
// rather than discovered per provider.

export class Conversation {
  #messages = [];
  #pending = null; // tool_call_ids still unanswered

  constructor({ system } = {}) {
    if (system) this.#messages.push({ role: 'system', content: system });
  }

  get messages() { return this.#messages.map((m) => ({ ...m })); }
  get length() { return this.#messages.length; }

  // Unanswered tool calls, if any. The loop must answer all of them.
  get pendingToolCalls() { return this.#pending ? [...this.#pending] : []; }

  user(content) {
    this.#assertNothingPending('a user message');
    this.#messages.push({ role: 'user', content });
    return this;
  }

  // The assistant's reply. Tool calls are recorded in the OpenAI shape, and
  // reasoning is deliberately *not* sent back: it is the model's private
  // working, it is most of the token cost (docs/providers.md), and no provider
  // requires it echoed.
  assistant({ content = '', toolCalls = [] }) {
    this.#assertNothingPending('an assistant message');

    const message = { role: 'assistant', content: content || null };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }));
      this.#pending = new Set(toolCalls.map((c) => c.id));
    }
    this.#messages.push(message);
    return this;
  }

  toolResult(toolCallId, content) {
    if (!this.#pending?.has(toolCallId)) {
      throw new Error(
        `tool result for ${JSON.stringify(toolCallId)} does not answer any pending call`
        + `${this.#pending ? `; expected one of ${[...this.#pending].join(', ')}` : ''}`,
      );
    }
    this.#messages.push({ role: 'tool', tool_call_id: toolCallId, content: String(content) });
    this.#pending.delete(toolCallId);
    if (this.#pending.size === 0) this.#pending = null;
    return this;
  }

  // An interrupted turn can leave tool calls unanswered, and a conversation in
  // that state refuses every subsequent message -- so an interrupt would cost
  // the whole session rather than one request. Answering them keeps the
  // transcript valid and tells the model what happened, which is also true.
  abandonPending(reason = 'interrupted by the user') {
    if (!this.#pending) return 0;
    const ids = [...this.#pending];
    for (const id of ids) {
      this.#messages.push({ role: 'tool', tool_call_id: id, content: `Error: ${reason}` });
    }
    this.#pending = null;
    return ids.length;
  }

  #assertNothingPending(what) {
    if (this.#pending && this.#pending.size > 0) {
      throw new Error(
        `cannot add ${what} while ${this.#pending.size} tool call(s) are unanswered: `
        + `${[...this.#pending].join(', ')}. Every tool call must be answered before the turn continues.`,
      );
    }
  }

  // For the session store, and for compaction in Phase 4.
  toJSON() { return this.#messages; }

  // Replays a stored conversation, *including* which tool calls are still
  // unanswered. Pushing the messages without rebuilding that state would leave
  // a resumed conversation happily accepting a new message on top of an
  // orphaned tool call -- and sending a message list providers reject.
  static fromJSON(messages) {
    const c = new Conversation();
    for (const m of messages) {
      c.#messages.push(m);
      if (m.role === 'assistant' && m.tool_calls?.length) {
        c.#pending = new Set(m.tool_calls.map((call) => call.id));
      } else if (m.role === 'tool' && c.#pending) {
        c.#pending.delete(m.tool_call_id);
        if (c.#pending.size === 0) c.#pending = null;
      }
    }
    return c;
  }
}
