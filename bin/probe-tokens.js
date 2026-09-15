#!/usr/bin/env node
// Measuring what things actually cost in tokens -- research task R6.
//
// peasant cannot use a tokeniser: `tiktoken` is a WASM blob plus BPE tables and
// both are banned, and every provider tokenises differently anyway. So the
// budgeter estimates, and an estimate is only worth having if its error is
// known. This measures the error against real `usage.prompt_tokens`.
//
// It answers four questions the Phase 4 design depends on:
//
//   1. What does an empty request cost? (chat template overhead)
//   2. How many characters per token, for prose and for code?
//   3. What does each additional message cost?
//   4. **What do the tool schemas cost, per turn?** -- the one that matters
//      most, because they are resent on every single request.
//
// Writes docs/raw/<date>_tokens.json, which tests/unit/token-estimator.test.js
// then checks the estimator against.

import fs from 'node:fs';
import path from 'node:path';
import { load, redact } from '../src/config/Env.js';
import { resolveOrder, selectModel } from '../src/provider/ProfileRegistry.js';
import { ProviderClient } from '../src/provider/Client.js';
import { specs } from '../src/tools/registry.js';
import { systemPrompt } from '../src/agent/prompt.js';

const PROSE = `The quick brown fox jumps over the lazy dog. `
  + `Every good boy deserves favour, and the rain in Spain falls mainly on the plain. `;

const CODE = `export function add(a, b) {\n  return a + b;\n}\n\n`
  + `const xs = [1, 2, 3].map((n) => n * 2);\n`;

function repeatTo(unit, chars) {
  let s = '';
  while (s.length < chars) s += unit;
  return s.slice(0, chars);
}

const env = load();

async function measure(client, { messages, tools = null }) {
  const result = await client.complete({
    messages,
    tools: tools ?? undefined,
    maxTokens: 1,
    temperature: 0,
  });
  return result.usage?.prompt_tokens ?? null;
}

async function main() {
  const only = process.argv.includes('--provider')
    ? process.argv[process.argv.indexOf('--provider') + 1]
    : null;

  const usable = resolveOrder(env).filter((c) => c.usable && (!only || c.name === only));
  if (usable.length === 0) {
    process.stderr.write('no usable provider; set a key or pass --provider\n');
    process.exit(1);
  }

  const config = usable[0];
  const client0 = new ProviderClient(config);
  if (!config.model) config.model = selectModel(config.profile, await client0.listModels(), null);
  const client = new ProviderClient(config);

  const say = (s) => process.stdout.write(`${redact(s, env)}\n`);
  say(`measuring against ${config.name} / ${config.model}`);

  const samples = [];
  const record = async (label, body, meta = {}) => {
    const tokens = await measure(client, body);
    const chars = JSON.stringify(body.messages).length;
    samples.push({ label, tokens, chars, ...meta });
    say(`  ${label.padEnd(24)} ${String(tokens).padStart(6)} tokens  (${chars} chars of JSON)`);
    return tokens;
  };

  // 1. Baseline: the smallest possible request.
  const baseline = await record('baseline', { messages: [{ role: 'user', content: 'x' }] },
    { textChars: 1 });

  // 2. Prose and code at increasing sizes, for characters per token.
  for (const [kind, unit] of [['prose', PROSE], ['code', CODE]]) {
    for (const chars of [200, 800, 3200]) {
      await record(`${kind} ${chars}`,
        { messages: [{ role: 'user', content: repeatTo(unit, chars) }] },
        { kind, textChars: chars });
    }
  }

  // 3. Per-message overhead: the same text split across more messages.
  const text = repeatTo(PROSE, 400);
  for (const count of [1, 4]) {
    const each = Math.floor(400 / count);
    await record(`${count} message(s)`, {
      messages: Array.from({ length: count }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: repeatTo(PROSE, each),
      })),
    }, { messageCount: count, textChars: each * count });
  }

  // 4. The tool schemas, which go out on every single turn.
  const toolSpecs = specs();
  const withoutTools = await record('no tools', { messages: [{ role: 'user', content: 'x' }] });
  const withTools = await record('with tools', { messages: [{ role: 'user', content: 'x' }], tools: toolSpecs },
    { toolCount: toolSpecs.length });

  // 5. The system prompt, which also goes out on every turn.
  const sys = systemPrompt({ root: '/workspace' });
  const withSystem = await record('system prompt', {
    messages: [{ role: 'system', content: sys }, { role: 'user', content: 'x' }],
  }, { systemChars: sys.length });

  const report = {
    date: new Date().toISOString().slice(0, 10),
    provider: config.name,
    model: config.model,
    baseline,
    toolSchemaCost: withTools - withoutTools,
    toolSchemaChars: JSON.stringify(toolSpecs).length,
    toolCount: toolSpecs.length,
    systemPromptCost: withSystem - baseline,
    systemPromptChars: sys.length,
    samples,
  };

  say('');
  say(`  baseline overhead      ${report.baseline} tokens per request`);
  say(`  ${report.toolCount} tool schemas          ${report.toolSchemaCost} tokens (${report.toolSchemaChars} chars)`);
  say(`  system prompt          ${report.systemPromptCost} tokens (${report.systemPromptChars} chars)`);
  say(`  fixed cost per turn    ${report.toolSchemaCost + report.systemPromptCost + report.baseline} tokens`);

  const file = path.join('docs', 'raw', `${report.date}_tokens.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  say(`\nwrote ${file}`);
}

main().catch((e) => {
  process.stderr.write(`${redact(String(e?.stack ?? e), env)}\n`);
  process.exit(70);
});
