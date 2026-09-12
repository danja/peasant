// Running the agent loop and printing it. Shared by `run` and the interactive
// session -- the only difference between them is who supplies the task and
// whether the conversation survives afterwards.

import { Loop } from '../agent/Loop.js';
import { TOOLS } from '../tools/registry.js';
import { EventPrinter } from './EventPrinter.js';

export function makeLoop({ router, policy, prompt, root, budget, compactor, estimator }) {
  return new Loop({ router, tools: TOOLS, policy, prompt, root, budget, compactor, estimator });
}

export async function runTurn(term, loop, conversation, { signal, router }) {
  const printer = new EventPrinter(term);
  let last = null;

  try {
    for await (const ev of loop.run(conversation, { signal })) {
      printer.handle(ev);
      if (ev.type === 'done') last = ev;
    }
  } finally {
    // An interrupt mid-turn can leave tool calls unanswered, and a conversation
    // in that state refuses every later message. Without this, one Ctrl-C would
    // cost the whole session instead of one request.
    const abandoned = conversation.abandonPending();
    if (abandoned > 0) {
      term.endLine();
      term.line(term.paint(`  ${abandoned} tool call${abandoned === 1 ? '' : 's'} abandoned`, 'grey'));
    }
  }

  term.line(printer.summary({
    model: last?.result?.model ?? null,
    reason: last?.reason ?? null,
    turns: last?.turns ?? null,
  }));

  for (const [name, why] of router.retired) {
    term.error(term.paint(`  ${name} withdrawn for this session: ${why}`, 'yellow'));
  }

  // Compaction builds a new conversation, so the caller has to adopt it or the
  // compaction is silently discarded and the next turn is just as large.
  return { done: last, conversation: last?.conversation ?? conversation };
}
