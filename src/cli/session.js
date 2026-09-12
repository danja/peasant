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
import { closeServers } from '../mcp/connect.js';
import { loadCommands, expand } from './commands.js';
import { Store } from '../session/Store.js';

const COMMANDS = {
  '/help': 'list these commands',
  '/clear': 'start a new conversation, keeping the session',
  '/providers': 'show which providers are configured',
  '/tools': 'list the tools available, including any from MCP servers',
  '/tokens': 'show what this conversation costs per request',
  '/compact': 'summarise the older half of the conversation now',
  '/allow': 'stop asking before running tools, for this session',
  '/exit': 'leave',
};

export async function session(term, env, { allowAll, resume = null }) {
  const ctx = await build(term, env, { allowAll });
  if (!assertCanAsk(term, ctx.policy, ctx.prompt)) return 64;

  const loop = makeLoop(ctx);
  const store = Store.open({ env });
  const custom = loadCommands({ env, root: ctx.root });

  let conversation = fresh(ctx.root, ctx.context);
  let turns = 0;
  let record = null;
  let known = 0;

  if (resume !== null) {
    const found = resume === true ? store.latestFor(ctx.root) : { id: resume };
    if (!found) {
      term.error(term.paint(
        `no session to resume in ${ctx.root}. "peasant sessions" lists what there is.`, 'yellow'));
    } else {
      try {
        const { messages, turns: past } = store.read(found.id);
        // A session recorded before the system message was persisted, or one
        // saved by an older version, gets a fresh one rather than continuing
        // with no instructions at all.
        const restored = messages[0]?.role === 'system'
          ? messages
          : [{ role: 'system', content: systemPrompt({ root: ctx.root, context: ctx.context }) }, ...messages];
        conversation = Conversation.fromJSON(restored);
        // An interrupted session can have been saved mid-turn, with tool calls
        // that were never answered. Resuming into that state would refuse every
        // message, so the orphans are closed off first.
        conversation.abandonPending('the session was interrupted and resumed');
        record = store.open(found.id);
        known = conversation.length;
        turns = past;
        term.line(term.paint(
          `resumed ${found.id} — ${messages.length} messages, ${past} turns`, 'grey'));
      } catch (e) {
        term.error(term.paint(`could not resume: ${e.message}`, 'yellow'));
      }
    }
  }

  if (record === null) {
    record = store.create({ root: ctx.root });
    // From zero, not from the current length: the system message is part of the
    // conversation and a session resumed without it has lost its instructions.
    known = record.sync(conversation.messages, 0);
  }

  term.line(term.paint(`peasant  ${ctx.root}`, 'bold'));
  term.line(term.paint(
    `  ${ctx.clients.map((c) => c.name).join(', ')} · ${engineName()} · permissions: ${ctx.policy.mode}`
    + `${ctx.mcpTools.length > 0 ? ` · ${ctx.mcpTools.length} mcp tools from ${ctx.mcpClients.length}` : ''}`,
    'grey'));
  for (const f of ctx.contextFiles.found) {
    term.line(term.paint(`  ${f.file} (${f.chars} chars, every turn)`, 'grey'));
  }

  const historyFile = path.join(
    env.PEASANT_HOME ? expandHome(env.PEASANT_HOME) : path.join(os.homedir(), '.peasant'),
    'history',
  );

  term.line(term.paint(`  session ${record.id}`, 'grey'));

  const repl = new Repl({ terminal: term, historyFile });

  await repl.start(async (line, { signal }) => {
    if (line.startsWith('/')) {
      const [command, ...words] = line.split(/\s+/);

      // A custom command is a prompt, not a branch: it expands and then takes
      // exactly the same path as anything typed.
      const found = custom.get(command.slice(1).toLowerCase());
      if (found) {
        line = expand(found, words.join(' '));
      } else {
      switch (command) {
        case '/exit':
        case '/quit':
          return false;
        case '/help':
          for (const [name, what] of Object.entries(COMMANDS)) {
            term.line(`  ${term.paint(name.padEnd(12), 'bold')} ${term.paint(what, 'grey')}`);
          }
          for (const c of custom.values()) {
            term.line(`  ${term.paint(`/${c.name}`.padEnd(12), 'cyan')} `
              + term.paint(c.description ?? path.basename(c.file), 'grey'));
          }
          if (custom.size === 0) {
            term.line(term.paint('  a file in .peasant/commands/ becomes a command of its own', 'grey'));
          }
          return true;
        case '/clear':
          conversation = fresh(ctx.root, ctx.context);
          turns = 0;
          record = store.create({ root: ctx.root });
          known = conversation.length;
          record.sync(conversation.messages, 0);
          term.line(term.paint(`  new conversation (${record.id})`, 'grey'));
          return true;
        case '/tools': {
          const builtin = ctx.tools.filter((x) => !x.external);
          const external = ctx.tools.filter((x) => x.external);
          term.line(term.paint(`  ${builtin.map((x) => x.name).join(', ')}`, 'grey'));
          for (const t of external) {
            term.line(`  ${term.paint(t.name, 'cyan')}`
              + term.paint(t.mutates ? '  (asks first)' : '', 'yellow'));
          }
          if (external.length === 0) {
            term.line(term.paint('  no MCP servers connected; "peasant mcp" explains how', 'grey'));
          }
          return true;
        }
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
          const estimate = ctx.budget.estimate(conversation, specs(ctx.tools));
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
            record.reset(conversation.messages);
            known = conversation.length;
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
    }

    conversation.user(line);
    turns++;
    record.turn(turns);

    const before = conversation;
    const outcome = await runTurn(term, loop, conversation, { signal, router: ctx.router });
    conversation = outcome.conversation;

    if (conversation !== before) {
      // Compaction replaced the history rather than adding to it.
      record.reset(conversation.messages);
      known = conversation.length;
    } else {
      known = record.sync(conversation.messages, known);
    }
    return true;
  });

  await closeServers(ctx.mcpClients);
  term.line(term.paint('bye', 'grey'));
  return 0;
}

function fresh(root, context) {
  return new Conversation({ system: systemPrompt({ root, context }) });
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}
