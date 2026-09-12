// How much may be sent, and when the conversation has to be cut down.
//
// The usual assumption in a harness is that the context window is the
// constraint. On these tiers it is not: Groq allows 8,000 tokens a *minute*
// against a window many times that, so the binding limit is the rate limit, and
// a conversation that fits the window perfectly can still be unsendable.
//
// So the budget is the smaller of what the model can hold and what the provider
// will currently pass, and neither number is written down here -- the window
// comes from the model catalogue where a provider publishes one, and the rate
// limit from `x-ratelimit-*` headers.

import { DEFAULTS } from '../config/preferences.js';

// Declared once, in src/config/preferences.js, with the reason for its value.
const KEEP_RECENT = DEFAULTS.keepRecent;

export class ContextBudget {
  #estimator;
  #compactAt;

  constructor({ estimator, compactAt = DEFAULTS.compactAt }) {
    this.#estimator = estimator;
    this.#compactAt = compactAt;
  }

  // What one request to this client may cost. null means nothing is known yet,
  // which is not the same as nothing being available.
  limitFor(client) {
    const window = client.contextWindow ?? null;
    const rate = client.limiter.state.tokens.limit ?? null;

    if (window === null && rate === null) return null;
    if (window === null) return rate;
    if (rate === null) return window;
    return Math.min(window, rate);
  }

  // Accepts a Conversation or anything with a `messages` array, so a
  // hypothetical request can be costed before it is built.
  estimate(conversation, tools) {
    return this.#estimator.estimate({ messages: conversation.messages ?? [], tools });
  }

  // Would this request fit? `null` for unknown is deliberately *not* treated as
  // "no": refusing to send anything to a provider that has told us nothing
  // would make an unprobed provider permanently useless.
  fits(conversation, tools, client) {
    const limit = this.limitFor(client);
    if (limit === null) return { fits: true, estimate: this.estimate(conversation, tools), limit: null };
    const estimate = this.estimate(conversation, tools);
    return { fits: estimate <= limit, estimate, limit };
  }

  // Compaction is triggered on a fraction of the limit rather than a fixed
  // number of tokens, because the limit differs by provider and is discovered
  // at runtime.
  shouldCompact(conversation, tools, client) {
    const limit = this.limitFor(client);
    if (limit === null) return false;
    return this.estimate(conversation, tools) > limit * this.#compactAt;
  }

  // Where a conversation can be cut without breaking it.
  //
  // An assistant message carrying tool calls and the tool messages answering it
  // are one unit: splitting them leaves either an unanswered call or an answer
  // to nothing, and providers reject both. So the boundary walks forward to the
  // first message that is safe to start from.
  static safeBoundary(messages, from) {
    let i = Math.max(0, from);
    while (i < messages.length) {
      const m = messages[i];
      if (m.role === 'tool') { i++; continue; }         // an answer needs its question
      if (m.role === 'assistant' && m.tool_calls) {      // a question needs its answers
        i++;
        while (i < messages.length && messages[i].role === 'tool') i++;
        continue;
      }
      return i;
    }
    return messages.length;
  }

  // Splits a conversation into the part to summarise and the part to keep.
  // The system message is never summarised: it is the instructions.
  static split(messages, { keepRecent = KEEP_RECENT } = {}) {
    const system = messages[0]?.role === 'system' ? [messages[0]] : [];
    const rest = messages.slice(system.length);

    if (rest.length <= keepRecent) return { system, older: [], recent: rest };

    const boundary = ContextBudget.safeBoundary(rest, rest.length - keepRecent);
    return { system, older: rest.slice(0, boundary), recent: rest.slice(boundary) };
  }
}

export { KEEP_RECENT };
