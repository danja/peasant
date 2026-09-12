// One task, non-interactively, with tools. What you reach for in a script.

import { Conversation } from '../agent/Conversation.js';
import { systemPrompt } from '../agent/prompt.js';
import { build, assertCanAsk } from './context.js';
import { makeLoop, runTurn } from './agent.js';
import { Store } from '../session/Store.js';
import { closeServers } from '../mcp/connect.js';

export async function run(term, env, task, { allowAll, signal }) {
  if (task.trim() === '') {
    term.error('nothing to do. Try: peasant run "add a --version flag"');
    return 64;
  }

  const ctx = await build(term, env, { allowAll, signal });
  if (!assertCanAsk(term, ctx.policy, ctx.prompt)) return 64;

  const loop = makeLoop(ctx);
  const conversation = new Conversation({
    system: systemPrompt({ root: ctx.root, context: ctx.context }),
  }).user(task);

  // Recorded like an interactive session. A long task that fails halfway is
  // worth resuming rather than starting again, and it cost real tokens to get
  // that far.
  const record = Store.open({ env }).create({ root: ctx.root });
  record.sync(conversation.messages, 0);
  record.turn(1);
  term.line(term.paint(`  session ${record.id}`, 'grey'));

  let outcome;
  try {
    outcome = await runTurn(term, loop, conversation, { signal, router: ctx.router });
  } finally {
    // Whatever happened, including an interrupt, what was reached is kept.
    const final = outcome?.conversation ?? conversation;
    record.reset(final.messages, { reason: 'final' });
    await closeServers(ctx.mcpClients);
  }
  return 0;
}
