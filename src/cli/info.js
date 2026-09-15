// The commands that answer "what is peasant going to do", without doing it.

import fs from 'node:fs';
import { configFiles, sourceOf, problemsOf } from '../config/Env.js';
import { PROFILES } from '../provider/ProfileRegistry.js';
import { engineName } from '../tools/search/index.js';
import { build } from './context.js';
import { estimateRequest } from '../agent/TokenEstimator.js';
import { specs } from '../tools/registry.js';
import { systemPrompt } from '../agent/prompt.js';
import { loadContext, renderContext } from '../agent/context-files.js';

export async function providers(term, env, { signal } = {}) {
  const { clients, failed, skipped, prefs, router } = await build(term, env, { signal, mcp: false });

  term.line(prefs.rotate
    ? term.paint(`rotation on — a blocked provider is skipped after ${prefs.maxWaitMs} ms; order below is preference order`, 'grey')
    : term.paint('rotation OFF (PEASANT_ROTATE) — every request waits for the first provider', 'yellow'));
  term.line('');

  for (const client of clients) {
    const unverified = client.profile.verified ? '' : term.paint(' (unverified profile)', 'yellow');
    term.line(`${term.paint(client.name.padEnd(12), 'bold')}${unverified}`);
    term.line(term.paint(`  model    ${client.model}`, 'grey'));
    const state = client.limiter.state;
    term.line(term.paint(`  budget   ${state.tokens.remaining === null
      ? 'not yet known — listing models costs no tokens, so nothing has been reported'
      : `${state.tokens.remaining}/${state.tokens.limit} tokens`}`, 'grey'));
    if (router.retired.has(client.name)) {
      term.line(term.paint(`  withdrawn ${router.retired.get(client.name)}`, 'yellow'));
    }
  }
  for (const f of failed) term.line(`${term.paint(f.name.padEnd(12), 'yellow')} ${f.error}`);
  for (const s of skipped) {
    // A provider whose credential could not be read says why and names the
    // remedy. "no key (CLAUDE_CODE_OAUTH_TOKEN)" is a true sentence and a
    // useless one when the real answer is that another tool has not been signed
    // into -- and the variable it names is the override, not the usual route.
    const why = s.problem ?? `no key (${s.profile.keyVar})`;
    term.line(`${term.paint(s.name.padEnd(12), 'grey')} ${term.paint(why, 'grey')}`);
  }
  return 0;
}

export async function models(term, env, { signal } = {}) {
  const { clients } = await build(term, env, { signal, quiet: true, mcp: false });
  for (const client of clients) {
    const ids = await client.listModels({ signal });
    const chat = ids.filter((id) => !client.profile.nonChat.some((re) => re.test(id)));
    term.line(term.paint(client.name, 'bold'));
    for (const id of chat) {
      term.line(id === client.model ? term.paint(`  ${id}  (selected)`, 'bold') : `  ${id}`);
    }
    const hidden = ids.length - chat.length;
    if (hidden > 0) term.line(term.paint(`  (${hidden} non-chat models hidden)`, 'grey'));
  }
  return 0;
}

export async function doctor(term, env, pkg, { signal } = {}) {
  term.line(term.paint('runtime', 'bold'));
  term.line(`  node ${process.version}, required ${pkg.engines.node}`);
  term.line('  run `node bin/probe-runtime.js` for the full check');
  term.line('');

  term.line(term.paint('search', 'bold'));
  const engine = engineName();
  term.line(term.paint(
    engine === 'javascript'
      ? '  javascript (no ripgrep on PATH; install it for faster grep on large trees)'
      : `  ${engine} (found on PATH; peasant never bundles a binary)`,
    'grey'));
  term.line('');

  term.line(term.paint('cost per turn', 'bold'));
  const toolSpecs = specs();
  const contextFiles = loadContext({ root: process.cwd(), env });
  const sys = systemPrompt({ root: process.cwd(), context: renderContext(contextFiles.found) });
  const fixed = estimateRequest({ messages: [{ role: 'system', content: sys }], tools: toolSpecs });
  term.line(term.paint(
    `  ~${fixed} tokens before anything is said (${toolSpecs.length} tool schemas + system prompt),`
    + ' resent on every turn', 'grey'));
  term.line(term.paint(
    '  the schemas alone measured 738 tokens against a live provider — see docs/providers.md', 'grey'));
  for (const f of contextFiles.found) {
    term.line(term.paint(`  including ${f.chars} chars from ${f.file}`, 'grey'));
  }
  for (const note of contextFiles.notes) term.line(term.paint(`  ${note}`, 'yellow'));
  term.line('');

  term.line(term.paint('configuration', 'bold'));
  for (const file of configFiles()) {
    term.line(term.paint(`  ${fs.existsSync(file) ? 'found  ' : 'absent '} ${file}`, 'grey'));
  }
  for (const problem of problemsOf(env)) term.line(term.paint(`  ${problem}`, 'yellow'));
  // Only the keys peasant reads: the environment is full of other tools'
  // tokens, and listing them is noise at best.
  const keyVars = PROFILES.map((p) => p.keyVar).filter((k) => (env[k] ?? '') !== '');
  if (keyVars.length === 0) {
    term.line(term.paint('  no keys found — copy example.env to ~/.config/peasant/.env', 'yellow'));
  } else {
    for (const k of keyVars.sort()) {
      term.line(term.paint(`  ${k.padEnd(20)} from ${sourceOf(env, k) ?? 'unknown'}`, 'grey'));
    }
  }
  term.line('');
  return providers(term, env, { signal });
}
