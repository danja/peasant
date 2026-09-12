#!/usr/bin/env node
// peasant -- an LLM coding harness for the poor.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRunnable } from '../src/compat/Preflight.js';
import { load } from '../src/config/Env.js';
import { connect } from '../src/provider/connect.js';
import { Terminal } from '../src/ui/Terminal.js';

const PKG = JSON.parse(fs.readFileSync(
  path.resolve(fileURLToPath(import.meta.url), '../../package.json'), 'utf8',
));

const USAGE = `peasant ${PKG.version} -- ${PKG.description}

  peasant ask <prompt>     ask a question, streamed
  peasant providers        show which providers are configured and what budget they report
  peasant models           list the chat models each provider offers
  peasant doctor           check the runtime and the configuration

  --version                print the version
  --help                   this

Providers are tried in PEASANT_PROVIDERS order, and peasant moves on to the next
one when the current is rate limited, unavailable or failing. Set
PEASANT_ROTATE=off to pin every request to the first provider instead.

Configuration is .env in the working directory, or the environment.
See example.env for every setting and every supported provider.`;

async function main(argv) {
  const term = new Terminal();

  if (argv.includes('--version')) { term.line(PKG.version); return 0; }
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) { term.line(USAGE); return 0; }

  assertRunnable();

  const [command, ...rest] = argv;
  const env = load();

  switch (command) {
    case 'ask': return ask(term, env, rest.join(' '));
    case 'providers': return providers(term, env);
    case 'models': return models(term, env);
    case 'doctor': return doctor(term, env);
    default:
      term.error(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
      return 64;
  }
}

async function ask(term, env, prompt) {
  if (prompt.trim() === '') { term.error('nothing to ask. Try: peasant ask "why is the sky blue?"'); return 64; }

  const controller = new AbortController();
  const onSigint = () => { controller.abort(); };
  process.on('SIGINT', onSigint);

  try {
    const { router, failed } = await connect(env, {
      signal: controller.signal,
      onProgress: (m) => term.status(term.paint(`  ${m}...`, 'grey')),
    });
    term.clearStatus();
    for (const f of failed) term.error(term.paint(`  ${f.name} unavailable: ${f.error}`, 'yellow'));

    const request = { messages: [{ role: 'user', content: prompt }], signal: controller.signal };
    let sawReasoning = false;

    for await (const ev of router.stream(request, { estimatedTokens: estimate(prompt) })) {
      switch (ev.type) {
        case 'provider':
          term.line(term.paint(`  ${ev.name}`, 'grey'));
          break;
        case 'reasoning':
          // Never rendered as assistant output. Groq's gpt-oss models spend
          // most of a completion here; showing it would print the model's
          // private working. Its existence is worth one line, though.
          if (!sawReasoning) { sawReasoning = true; term.status(term.paint('  thinking...', 'grey')); }
          break;
        case 'text':
          if (sawReasoning) { term.clearStatus(); sawReasoning = false; }
          term.write(ev.delta);
          break;
        case 'done':
          term.clearStatus();
          term.endLine();
          report(term, ev.result);
          // A provider dropped mid-request cost the user latency. Saying so is
          // cheaper than them wondering why a free tier felt slow.
          for (const [name, why] of router.retired) {
            term.error(term.paint(`  ${name} withdrawn for this session: ${why}`, 'yellow'));
          }
          break;
        default: break;
      }
    }
    return 0;
  } catch (e) {
    if (e?.name === 'AbortError') { term.endLine(); term.error(term.paint('interrupted', 'grey')); return 130; }
    term.endLine();
    term.error(term.paint(e.message, 'red'));
    return 70;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

function report(term, result) {
  const u = result.usage;
  if (!u) return;
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  const bits = [
    `${u.prompt_tokens ?? '?'} in`,
    `${u.completion_tokens ?? '?'} out`,
    ...(reasoning ? [`${reasoning} reasoning`] : []),
  ];
  term.line(term.paint(`  ${result.model ?? result.provider} · ${bits.join(' · ')}`, 'grey'));
}

async function providers(term, env) {
  const { clients, skipped, failed, prefs } = await connect(env, {
    onProgress: (m) => term.status(term.paint(`  ${m}...`, 'grey')),
  });
  term.clearStatus();

  term.line(prefs.rotate
    ? term.paint(`rotation on — a blocked provider is skipped after ${prefs.maxWaitMs} ms; order below is preference order`, 'grey')
    : term.paint('rotation OFF (PEASANT_ROTATE) — every request waits for the first provider', 'yellow'));
  term.line('');

  for (const client of clients) {
    term.line(`${term.paint(client.name.padEnd(12), 'bold')} ${client.profile.verified ? '' : term.paint('(unverified profile) ', 'yellow')}`);
    const state = client.limiter.state;
    term.line(term.paint(`  model    ${client.model}`, 'grey'));
    term.line(term.paint(`  budget   ${state.tokens.remaining === null
      ? 'not yet known -- listing models costs no tokens, so nothing has been reported'
      : `${state.tokens.remaining}/${state.tokens.limit} tokens`}`, 'grey'));
  }
  for (const f of failed) term.line(`${term.paint(f.name.padEnd(12), 'yellow')} ${f.error}`);
  for (const s of skipped) term.line(`${term.paint(s.name.padEnd(12), 'grey')} ${term.paint(`no key (${s.profile.keyVar})`, 'grey')}`);
  return 0;
}

async function models(term, env) {
  const { clients } = await connect(env, { onProgress: () => {} });
  for (const client of clients) {
    const ids = await client.listModels();
    const chat = ids.filter((id) => !client.profile.nonChat.some((re) => re.test(id)));
    term.line(term.paint(client.name, 'bold'));
    for (const id of chat) term.line(`  ${id}`);
    const hidden = ids.length - chat.length;
    if (hidden > 0) term.line(term.paint(`  (${hidden} non-chat models hidden)`, 'grey'));
  }
  return 0;
}

async function doctor(term, env) {
  term.line(term.paint('runtime', 'bold'));
  term.line(`  node ${process.version}, required ${PKG.engines.node}`);
  term.line(`  run \`node bin/probe-runtime.js\` for the full check`);
  term.line('');
  return providers(term, env);
}

// A deliberately crude estimate, pending R6. It exists so the limiter has
// something to refuse; TokenEstimator replaces it in Phase 4.
function estimate(text) {
  return Math.ceil(text.length / 4) + 512;
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    process.exitCode = 70;
    // A fresh Terminal rather than the one main() built: this path exists for
    // failures that happened before, or instead of, that one being usable.
    new Terminal().error(String(e?.stack ?? e));
  });
