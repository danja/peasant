#!/usr/bin/env node
// peasant -- an LLM coding harness for the poor.
//
// Dispatch only. Each command lives in src/cli/, because five commands in one
// file is five reasons for it to change.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRunnable } from '../src/compat/Preflight.js';
import { load } from '../src/config/Env.js';
import { Terminal } from '../src/ui/Terminal.js';
import { ask } from '../src/cli/ask.js';
import { run } from '../src/cli/run.js';
import { session } from '../src/cli/session.js';
import { providers, models, doctor } from '../src/cli/info.js';
import { sessions } from '../src/cli/sessions.js';
import { mcp } from '../src/cli/mcp.js';

const PKG = JSON.parse(fs.readFileSync(
  path.resolve(fileURLToPath(import.meta.url), '../../package.json'), 'utf8',
));

const USAGE = `peasant ${PKG.version} -- ${PKG.description}

  peasant                  start an interactive session
  peasant --resume [id]    continue the last session in this directory, or one by id
  peasant sessions         list kept sessions
  peasant mcp              list configured MCP servers and the tools they offer
  peasant ask <prompt>     ask a question, streamed -- no tools, no file access
  peasant run <task>       work on a task, using the tools
  peasant providers        show which providers are configured and what they report
  peasant models           list the chat models each provider offers
  peasant doctor           check the runtime, the search engine and the configuration

  --allow-all              run tools without asking
  --version                print the version
  --help                   this

Providers are tried in PEASANT_PROVIDERS order, and peasant moves on to the next
when the current one is rate limited, unavailable or failing. Set
PEASANT_ROTATE=off to pin every request to the first provider instead.

Configuration is read from ~/.config/peasant/.env, then ./.env, then the
environment -- later wins. Keys belong in the user-level file; the working
directory is the workspace peasant works ON. Run "peasant doctor" to see which
files were found. See example.env for every setting and every provider.`;

async function main(argv) {
  const term = new Terminal();

  if (argv.includes('--version')) { term.line(PKG.version); return 0; }
  if (argv.includes('--help') || argv.includes('-h')) { term.line(USAGE); return 0; }

  assertRunnable();

  const env = load();
  const allowAll = argv.includes('--allow-all');
  const resumeAt = argv.indexOf('--resume');
  // `--resume` alone means the latest here; `--resume <id>` names one. The id
  // is only the next argument if it is not itself a flag or a command.
  const resume = resumeAt === -1
    ? null
    : (argv[resumeAt + 1] && !argv[resumeAt + 1].startsWith('--') && /^\d{8}T\d{6}-/.test(argv[resumeAt + 1])
      ? argv[resumeAt + 1]
      : true);
  const rest = argv.filter((a) => !a.startsWith('--') && a !== resume);
  const [command, ...words] = rest;

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  const signal = controller.signal;

  // The interactive session handles Ctrl-C itself, per prompt: there, an
  // interrupt cancels the request and keeps the conversation.
  const interactive = command === undefined;
  if (!interactive) process.on('SIGINT', onSigint);

  try {
    switch (command) {
      case undefined: return await session(term, env, { allowAll, resume });
      case 'ask': return await ask(term, env, words.join(' '), { signal });
      case 'run': return await run(term, env, words.join(' '), { allowAll, signal });
      case 'providers': return await providers(term, env, { signal });
      case 'models': return await models(term, env, { signal });
      case 'sessions': return await sessions(term, env);
      case 'mcp': return await mcp(term, env, { signal });
      case 'doctor': return await doctor(term, env, PKG, { signal });
      default:
        term.error(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
        return 64;
    }
  } catch (e) {
    if (e?.name === 'AbortError') {
      term.endLine();
      term.error(term.paint('interrupted', 'grey'));
      return 130;
    }
    term.endLine();
    term.error(term.paint(e.message, 'red'));
    return 70;
  } finally {
    if (!interactive) process.off('SIGINT', onSigint);
  }
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    process.exitCode = 70;
    // A fresh Terminal rather than the one main() built: this path exists for
    // failures that happened before, or instead of, that one being usable.
    new Terminal().error(String(e?.stack ?? e));
  });
