// One task, non-interactively, with tools. What you reach for in a script.

import { Conversation } from '../agent/Conversation.js';
import { systemPrompt } from '../agent/prompt.js';
import { build, assertCanAsk } from './context.js';
import { makeLoop, runTurn } from './agent.js';

export async function run(term, env, task, { allowAll, signal }) {
  if (task.trim() === '') {
    term.error('nothing to do. Try: peasant run "add a --version flag"');
    return 64;
  }

  const ctx = await build(term, env, { allowAll, signal });
  if (!assertCanAsk(term, ctx.policy, ctx.prompt)) return 64;

  const loop = makeLoop(ctx);
  const conversation = new Conversation({ system: systemPrompt({ root: ctx.root }) }).user(task);

  await runTurn(term, loop, conversation, { signal, router: ctx.router });
  return 0;
}
