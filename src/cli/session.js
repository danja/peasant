// The interactive session.
//
// The conversation persists between prompts, which is the point: the harness is
// cheaper to use across several related questions than as a series of one-shot
// commands, because the model has already read the files.
//
// It is also what makes Ctrl-C matter. Interrupting a request must leave the
// conversation intact, or an interrupt costs everything that has been built up.

import path from 'node:path';
import os from 'node:os';
import { Repl } from '../ui/Repl.js';
import { Conversation } from '../agent/Conversation.js';
import { systemPrompt } from '../agent/prompt.js';
import { build, assertCanAsk } from './context.js';
import { makeLoop, runTurn } from './agent.js';
import { engineName } from '../tools/search/index.js';
import { specs } from '../tools/registry.js';

const COMMANDS = {
  '/help': 'list these commands',
  '/clear': 'start a new conversation, keeping the session',
  '/providers': 'show which providers are configured',
  '/tokens': 'show what this conversation costs per request',
  '/compact': 'summarise the older half of the conversation now',
  '/allow': 'stop asking before running tools, for this session',
  '/exit': 'leave',
};

export async function session(term, env, { allowAll }) {
  const ctx = await build(term, env, { allowAll });
  if (!assertCanAsk(term, ctx.policy, ctx.prompt)) return 64;

  const loop = makeLoop(ctx);
  let conversation = fresh(ctx.root);
  let turns = 0;

  term.line(term.paint(`peasant  ${ctx.root}`, 'bold'));
  term.line(term.paint(
    `  ${ctx.clients.map((c) => c.name).join(', ')} · ${engineName()} · permissions: ${ctx.policy.mode}`,
    'grey'));

  const historyFile = path.join(
    env.PEASANT_HOME ? expand(env.PEASANT_HOME) : path.join(os.homedir(), '.peasant'),
    'history',
  );

  const repl = new Repl({ terminal: term, historyFile });

  await repl.start(async (line, { signal }) => {
    if (line.startsWith('/')) {
      const [command] = line.split(/\s+/);
      switch (command) {
        case '/exit':
        case '/quit':
          return false;
        case '/help':
          for (const [name, what] of Object.entries(COMMANDS)) {
            term.line(`  ${term.paint(name.padEnd(12), 'bold')} ${term.paint(what, 'grey')}`);
          }
          return true;
        case '/clear':
          conversation = fresh(ctx.root);
          turns = 0;
          term.line(term.paint('  new conversation', 'grey'));
          return true;
        case '/providers':
          for (const c of ctx.clients) {
            const s = c.limiter.state;
            const budget = s.tokens.remaining === null
              ? 'budget not yet reported'
              : `${s.tokens.remaining}/${s.tokens.limit} tokens left`;
            const retired = ctx.router.retired.has(c.name) ? term.paint('  withdrawn', 'yellow') : '';
            term.line(`  ${term.paint(c.name.padEnd(12), 'bold')} ${term.paint(`${c.model}  ${budget}`, 'grey')}${retired}`);
          }
          return true;
        case '/tokens': {
          const estimate = ctx.budget.estimate(conversation, specs());
          const client = ctx.router.clients[0];
          const limit = client ? ctx.budget.limitFor(client) : null;
          term.line(term.paint(
            `  ${conversation.length} messages over ${turns} turn${turns === 1 ? '' : 's'}`, 'grey'));
          term.line(term.paint(
            `  about ${estimate} tokens per request`
            + `${limit === null ? ' (no limit reported)' : ` of ${limit} available`}`, 'grey'));
          term.line(term.paint(
            `  estimator correction ${ctx.estimator.correction.toFixed(2)}`
            + ` after ${ctx.estimator.observations} response${ctx.estimator.observations === 1 ? '' : 's'}`, 'grey'));
          return true;
        }
        case '/compact': {
          const outcome = await ctx.compactor.compact(conversation, { signal });
          if (outcome.compacted) {
            conversation = outcome.conversation;
            term.line(term.paint(
              `  summarised ${outcome.summarised} messages: ${outcome.before} -> ${outcome.after} tokens`, 'grey'));
          } else {
            term.line(term.paint(`  not compacted: ${outcome.reason}`, 'yellow'));
          }
          return true;
        }
        case '/allow':
          for (const t of ['write', 'edit', 'bash']) ctx.policy.rememberAllow(t);
          term.line(term.paint('  tools will run without asking, for this session', 'grey'));
          return true;
        default:
          term.line(term.paint(`  unknown command ${command}; /help lists them`, 'yellow'));
          return true;
      }
    }

    conversation.user(line);
    turns++;
    const outcome = await runTurn(term, loop, conversation, { signal, router: ctx.router });
    conversation = outcome.conversation;
    return true;
  });

  term.line(term.paint('bye', 'grey'));
  return 0;
}

function fresh(root) {
  return new Conversation({ system: systemPrompt({ root }) });
}

function expand(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}
