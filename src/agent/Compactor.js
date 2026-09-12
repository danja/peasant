// Making a long conversation short enough to send again.
//
// It summarises the older half and keeps the recent exchange verbatim, because
// the recent exchange is what the model is actually working from and a summary
// of it would lose exactly the detail in use.
//
// Two rules it must not break:
//
//   - the system message survives untouched; it is the instructions
//   - an assistant message carrying tool calls and the tool messages answering
//     it are one unit, and cutting between them produces a conversation
//     providers reject
//
// ContextBudget.split does the second. This does the asking.

import { Conversation } from './Conversation.js';
import { ContextBudget } from './ContextBudget.js';

// The word limit is scaled to what is being replaced, not fixed.
//
// A fixed "400 words" produced summaries larger than the conversation they
// replaced -- 449 tokens became 614, three times in one session -- because a
// model writes to the length it is asked for, not the length of its input.
// Roughly a third of the original is enough to be useful and small enough to
// be worth doing.
function instruction(words) {
  return [
    'Summarise the conversation so far for your own later reference.',
    '',
    'Include: what the user asked for, what has been done, what was learned about',
    'the code (file paths, function names, decisions), and what is still outstanding.',
    'Omit: pleasantries, tool output that has been superseded, anything already',
    'reflected in the files.',
    '',
    'Write it as notes, not prose. Be specific about paths and names -- they are',
    `what makes the summary usable. Use at most ${words} words; fewer is better.`,
  ].join('\n');
}

// Words per token, roughly, for turning a token budget into a word budget.
const WORDS_PER_TOKEN = 0.75;

export class Compactor {
  #router;
  #estimator;

  constructor({ router, estimator }) {
    this.#router = router;
    this.#estimator = estimator;
  }

  // Returns a new Conversation, or the original when there is nothing worth
  // compacting. Never throws on a failed summary: not compacting is a worse
  // conversation, while losing it is a worse afternoon.
  //
  // Two affordability questions, and they are not the same one:
  //
  //   canAfford  -- could the *summary request* be sent? It carries the old
  //                 transcript and no tools.
  //   targetFits -- would the *compacted conversation* be sendable? It carries
  //                 the tool schemas, which are the largest single item.
  //
  // Conflating them stopped the mechanical fallback too early: it declared
  // success at a size that still could not be sent, because it had not counted
  // the 738 tokens of tool schemas that go out with every real request.
  //
  // The first exists because of a deadlock this design walked straight into:
  // the summary is itself a request, and the moment the conversation is most
  // over budget is exactly the moment a summary cannot be sent either. So when
  // the summary is unaffordable -- or fails, or comes back empty -- there is a
  // mechanical fallback that costs nothing and always makes progress.
  async compact(conversation, { signal, keepRecent, canAfford = null, targetFits = null } = {}) {
    const messages = conversation.messages;
    const { system, older, recent } = ContextBudget.split(messages, { keepRecent });

    const before = this.#estimator.estimate({ messages });
    const fits = !targetFits || targetFits(messages);

    if (older.length === 0) {
      // "Nothing old enough to summarise" is not the same as "nothing to do".
      //
      // Three file reads make a four-message conversation that does not fit,
      // and none of it is old: `split` keeps the last six messages, so `older`
      // is empty and there is no transcript to summarise. Returning here meant
      // the request went out anyway, the router refused it, and the user
      // retried into exactly the same state for ever. Eliding the tool results
      // is still available, and it is what actually helps.
      if (fits) {
        return { conversation, compacted: false, quiet: true, reason: 'nothing old enough to summarise' };
      }
      return this.#mechanical(conversation, {
        system, older: [], recent, before, targetFits,
        why: 'the conversation does not fit and none of it is old enough to summarise',
      });
    }
    const mechanical = (why) => this.#mechanical(conversation, {
      system, older, recent, before, why, targetFits,
    });

    const transcript = renderTranscript(older);
    if (canAfford && !canAfford([{ role: 'user', content: transcript }])) {
      return mechanical('the summary request would not fit the budget either');
    }

    // A third of what is being replaced, floored so a summary is still worth
    // having and capped so it never becomes the largest thing in the request.
    const olderTokens = this.#estimator.estimate({ messages: older });
    const words = Math.max(60, Math.min(400, Math.round(olderTokens * WORDS_PER_TOKEN / 3)));

    let summary;
    try {
      summary = await this.#summarise(transcript, words, signal);
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      return mechanical(`summary failed: ${e.message}`);
    }

    if (!summary || summary.trim() === '') {
      return mechanical('the model returned an empty summary');
    }

    const rebuilt = Conversation.fromJSON([
      ...system,
      { role: 'user', content: `Notes from earlier in this session:\n\n${summary}` },
      { role: 'assistant', content: 'Understood. Continuing from those notes.' },
      ...recent,
    ]);

    const after = this.#estimator.estimate({ messages: rebuilt.messages });

    // A summary longer than what it replaced is worse than no compaction at
    // all, and it happened: three short messages became a four-hundred-word set
    // of notes and the conversation grew from 1,248 tokens to 1,358. The model
    // writes to the length it was asked for, not to the length of its input.
    if (after >= before) {
      return mechanical(`the summary was larger than what it replaced (${before} -> ${after})`);
    }

    return {
      conversation: rebuilt,
      compacted: true,
      before,
      after,
      saved: before - after,
      summarised: older.length,
    };
  }

  // Compaction with no model call: deterministic, free, and always available.
  //
  // Two stages, in order of what they cost the conversation:
  //
  //   1. Elide old tool results. They are the bulkiest thing in a coding
  //      session and the most superseded -- a file read four turns ago has
  //      usually been edited since -- and the first line carries the gist.
  //   2. Drop the oldest exchanges outright, saying how many. Worse, but it
  //      always makes progress, and a conversation that cannot be sent at all
  //      is worth less than a shortened one.
  #mechanical(conversation, { system, older, recent, before, why, targetFits }) {
    const affordable = (messages) => !targetFits || targetFits(messages);
    const assemble = (kept, dropped) => [
      ...system,
      ...(dropped > 0
        ? [{ role: 'user', content: `[${dropped} earlier messages dropped to fit the token budget]` }]
        : []),
      ...kept,
    ];

    // Stage 1: elide tool results, keeping every message.
    //
    // Across the whole body, not just the older part. The message that makes a
    // conversation unsendable is often the one just read, and refusing to touch
    // it because it is recent leaves nothing to do. Eliding keeps its first
    // line and says how much went, which is a great deal better than the turn
    // failing.
    let kept = [...older, ...recent].map(elideToolResult);
    let dropped = 0;
    if (affordable(assemble(kept, dropped))) {
      return this.#result(conversation, assemble(kept, dropped), { before, why, changed: older.length });
    }

    // Stage 2: drop from the front until it fits.
    //
    // This deliberately cuts into the recent window once the older messages are
    // gone. The alternative is refusing to compact at all in exactly the case
    // that needs it: on a small budget the tool schemas can cost more than the
    // whole recent window, and then keeping six messages is not a policy but a
    // guarantee of failure. The last message is the floor -- it is the question
    // being asked, and without it there is nothing to answer.
    while (kept.length > 1) {
      const step = ContextBudget.safeBoundary(kept, 1);
      if (step >= kept.length) break;
      dropped += step;
      kept = kept.slice(step);
      if (affordable(assemble(kept, dropped))) break;
    }

    return this.#result(conversation, assemble(kept, dropped), {
      before, why, changed: older.length + recent.length - kept.length,
    });
  }

  #result(conversation, messages, { before, why, changed }) {
    const rebuilt = Conversation.fromJSON(messages);
    const after = this.#estimator.estimate({ messages: rebuilt.messages });

    if (after >= before) {
      return { conversation, compacted: false, reason: `${why}, and there was nothing left to remove` };
    }
    return {
      conversation: rebuilt,
      compacted: true,
      mechanical: true,
      reason: why,
      before,
      after,
      saved: before - after,
      summarised: changed,
    };
  }

  async #summarise(transcript, words, signal) {
    // The summary request carries no tools: they are the largest single item in
    // a normal request, measured at 738 tokens, and a summary has no use for
    // them.
    let content = '';
    for await (const ev of this.#router.stream({
      messages: [
        { role: 'user', content: `${instruction(words)}\n\n---\n\n${transcript}` },
      ],
      maxTokens: Math.ceil(words / WORDS_PER_TOKEN) + 100,
      temperature: 0,
      signal,
    }, { estimatedTokens: this.#estimator.estimate({ messages: [{ role: 'user', content: transcript }] }) })) {
      if (ev.type === 'done') content = ev.result.content;
    }
    return content;
  }
}

// Keeps the first line, which is the gist, and says how much went.
function elideToolResult(message) {
  if (message.role !== 'tool') return message;
  const text = String(message.content ?? '');
  const head = text.split('\n')[0] ?? '';
  if (text.length <= head.length + 40) return message;
  return { ...message, content: `${head}\n[${text.length - head.length} characters elided by compaction]` };
}

function renderTranscript(messages) {
  return messages.map(render).filter(Boolean).join('\n\n');
}

// Tool results are often long and mostly superseded, so they go in heavily
// abbreviated: what was called and roughly what came back.
function render(message) {
  switch (message.role) {
    case 'user':
      return `User: ${message.content}`;
    case 'assistant': {
      const calls = (message.tool_calls ?? [])
        .map((c) => `${c.function.name}(${c.function.arguments})`)
        .join(', ');
      const said = message.content ? `Assistant: ${message.content}` : '';
      return [said, calls ? `Assistant called: ${calls}` : ''].filter(Boolean).join('\n');
    }
    case 'tool': {
      const text = String(message.content ?? '');
      const head = text.split('\n').slice(0, 3).join('\n');
      return `Result: ${head}${text.length > head.length ? ' ...' : ''}`;
    }
    default:
      return '';
  }
}
