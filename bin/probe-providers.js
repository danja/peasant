#!/usr/bin/env node
// Peasant provider probe -- research task R2.
//
// Answers the questions a provider profile is made of, by asking the provider
// rather than its documentation:
//
//   - what are the real rate-limit header names and values?
//   - does it honour `tools` / `tool_choice`, and are the arguments valid JSON?
//   - how do tool calls arrive when streaming -- index-keyed deltas, whole
//     objects, or not at all?
//   - is `stream_options: {include_usage: true}` supported? Without it a
//     streamed response reports no token count and the budgeter is blind.
//   - what does a 429 body actually look like?
//
// It writes a markdown report and keeps every raw SSE stream as a fixture, so
// ToolCallAssembler can be tested against real bytes rather than invented ones.
//
// Keys are redacted from everything written or printed. Run with --dry-run to
// see what it would do without spending any quota.
//
// Base URLs, keys and model preferences come from src/provider/profiles/ via
// ProfileRegistry -- this file keeps no table of its own. It does make its own
// raw requests rather than going through ProviderClient, because its job is
// to see below that abstraction: the raw headers and the raw SSE bytes are the
// findings.

import fs from 'node:fs';
import path from 'node:path';
import { load, redact } from '../src/config/Env.js';
import { resolveOrder, selectModel } from '../src/provider/ProfileRegistry.js';

// The one tool used for every dialect test. Deliberately trivial: the question
// is the shape of the call, not the model's judgement.
const TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
        unit: { type: 'string', enum: ['c', 'f'], description: 'Temperature unit' },
      },
      required: ['city'],
    },
  },
};

const OUT_DIR = path.join('docs', 'raw', `${new Date().toISOString().slice(0, 10)}_providers`);

let env = {};
const dryRun = process.argv.includes('--dry-run');
const only = argValue('--only');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

function say(s = '') { process.stdout.write(redact(String(s), env) + '\n'); }

function headerTable(headers) {
  const out = {};
  for (const [k, v] of headers) {
    // Authorization is never echoed back, but a proxy could; be certain.
    out[k] = /authorization|api-key|cookie/i.test(k) ? '[REDACTED]' : v;
  }
  return out;
}

// Every header a rate limiter could plausibly drive itself from. Recorded
// separately from the full dump so the report says plainly what is available.
function rateLimitHeaders(headers) {
  const out = {};
  for (const [k, v] of headers) {
    if (/ratelimit|retry-after|x-request-id|x-groq|x-envoy|quota/i.test(k)) out[k] = v;
  }
  return out;
}

async function request(provider, pathname, init = {}) {
  const url = `${provider.baseUrl}${pathname}`;
  const started = Date.now();
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${provider.key}`,
      'content-type': 'application/json',
      ...provider.extraHeaders,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(60000),
  });
  return { res, url, ms: Date.now() - started };
}

async function listModels(provider) {
  const { res, ms } = await request(provider, '/models');
  const body = await res.text();
  let ids = [];
  try {
    const parsed = JSON.parse(body);
    ids = (parsed.data ?? parsed.models ?? []).map((m) => m.id ?? m.name).filter(Boolean);
  } catch { /* reported as a parse failure below */ }
  return {
    status: res.status,
    ms,
    count: ids.length,
    ids: ids.sort(),
    headers: headerTable(res.headers),
    rateLimit: rateLimitHeaders(res.headers),
    body: ids.length ? null : body.slice(0, 400),
  };
}

async function chat(provider, body) {
  const { res, ms } = await request(provider, '/chat/completions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { res, ms };
}

async function probeNonStreaming(provider) {
  const { res, ms } = await chat(provider, {
    model: provider.model,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    max_tokens: 8,
    temperature: 0,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* recorded raw below */ }
  return {
    status: res.status,
    ms,
    headers: headerTable(res.headers),
    rateLimit: rateLimitHeaders(res.headers),
    content: parsed?.choices?.[0]?.message?.content ?? null,
    usage: parsed?.usage ?? null,
    finishReason: parsed?.choices?.[0]?.finish_reason ?? null,
    raw: parsed ? null : text.slice(0, 600),
  };
}

// Reads the byte stream exactly as ProviderClient will have to, keeping the
// raw bytes so SseParser and ToolCallAssembler can be tested against them.
async function readStream(res) {
  const chunks = [];
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function sseEvents(raw) {
  const events = [];
  for (const block of raw.toString('utf8').split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (data) events.push(data);
  }
  return events;
}

async function probeStreaming(provider, { withTools }) {
  const body = {
    model: provider.model,
    messages: withTools
      ? [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }]
      : [{ role: 'user', content: 'Count: one two three' }],
    max_tokens: withTools ? 128 : 24,
    temperature: 0,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (withTools) { body.tools = [TOOL]; body.tool_choice = 'auto'; }

  const { res, ms } = await chat(provider, body);
  if (!res.ok || !res.body) {
    const text = res.body ? await res.text() : '';
    return { status: res.status, ms, headers: headerTable(res.headers), error: text.slice(0, 600) };
  }

  const raw = await readStream(res);
  const events = sseEvents(raw);
  const parsed = events.filter((e) => e !== '[DONE]').map((e) => { try { return JSON.parse(e); } catch { return null; } });

  const usageEvent = parsed.find((e) => e?.usage);
  const toolDeltas = [];
  for (const e of parsed) {
    const tc = e?.choices?.[0]?.delta?.tool_calls;
    if (tc) toolDeltas.push(tc);
  }

  return {
    status: res.status,
    ms,
    headers: headerTable(res.headers),
    rateLimit: rateLimitHeaders(res.headers),
    bytes: raw.length,
    events: events.length,
    sawDone: events.includes('[DONE]'),
    includeUsageHonoured: Boolean(usageEvent),
    usage: usageEvent?.usage ?? null,
    text: parsed.map((e) => e?.choices?.[0]?.delta?.content ?? '').join(''),
    finishReason: parsed.map((e) => e?.choices?.[0]?.finish_reason).filter(Boolean).pop() ?? null,
    toolDeltaCount: toolDeltas.length,
    firstToolDelta: toolDeltas[0] ?? null,
    assembledToolCall: assembleToolCalls(toolDeltas),
    raw,
  };
}

// A throwaway version of what ToolCallAssembler will do properly. Its purpose
// here is to prove the deltas *can* be reassembled, and to expose the shape.
function assembleToolCalls(deltas) {
  const byIndex = new Map();
  for (const batch of deltas) {
    for (const d of batch) {
      const i = d.index ?? 0;
      if (!byIndex.has(i)) byIndex.set(i, { id: '', name: '', args: '' });
      const acc = byIndex.get(i);
      if (d.id) acc.id = d.id;
      if (d.function?.name) acc.name += d.function.name;
      if (d.function?.arguments) acc.args += d.function.arguments;
    }
  }
  return [...byIndex.values()].map((c) => {
    let argsValid = false, argsParsed = null;
    try { argsParsed = JSON.parse(c.args); argsValid = true; } catch { /* reported as invalid */ }
    return { ...c, argsValid, argsParsed };
  });
}

async function probeProvider(provider) {
  say(`\n=== ${provider.name} ===`);
  const report = { name: provider.name, baseUrl: provider.baseUrl };

  report.models = await listModels(provider);
  say(`  models        HTTP ${report.models.status}, ${report.models.count} models, ${report.models.ms} ms`);
  if (report.models.status !== 200) {
    say(`  ABORT: ${report.models.body ?? 'cannot list models'}`);
    return report;
  }

  provider.model = selectModel(provider.profile, report.models.ids, env[provider.profile.modelVar]);
  report.model = provider.model;
  say(`  model         ${provider.model}`);

  report.nonStreaming = await probeNonStreaming(provider);
  say(`  chat          HTTP ${report.nonStreaming.status}, ${report.nonStreaming.ms} ms, usage=${JSON.stringify(report.nonStreaming.usage)}`);

  report.streaming = await probeStreaming(provider, { withTools: false });
  say(`  stream        HTTP ${report.streaming.status}, ${report.streaming.events} events, ${report.streaming.bytes} bytes, include_usage=${report.streaming.includeUsageHonoured}`);

  report.toolStreaming = await probeStreaming(provider, { withTools: true });
  const asm = report.toolStreaming.assembledToolCall ?? [];
  say(`  tools+stream  HTTP ${report.toolStreaming.status}, ${report.toolStreaming.toolDeltaCount} tool deltas, assembled=${asm.length}, argsValid=${asm.map((a) => a.argsValid).join(',') || 'n/a'}`);

  // Keep the bytes. Invented fixtures test the parser you imagined.
  for (const [label, r] of [['stream', report.streaming], ['tools', report.toolStreaming]]) {
    if (r?.raw) {
      const f = path.join(OUT_DIR, `${provider.name}-${label}.sse`);
      fs.writeFileSync(f, redact(r.raw.toString('utf8'), env));
      r.fixture = f;
      delete r.raw;
    }
  }
  return report;
}

function markdown(reports) {
  const L = [];
  L.push(`# Provider probe — ${new Date().toISOString().slice(0, 10)}`);
  L.push('');
  L.push('Generated by `bin/probe-providers.js`. Every figure here came from a');
  L.push('response, not from documentation. Keys are redacted.');
  L.push('');
  L.push('| Provider | Model | Chat | Stream | `include_usage` | Tool deltas | Args valid JSON |');
  L.push('|---|---|---|---|---|---|---|');
  for (const r of reports) {
    if (!r.model) { L.push(`| ${r.name} | — | HTTP ${r.models?.status} | — | — | — | — |`); continue; }
    const asm = r.toolStreaming?.assembledToolCall ?? [];
    L.push(`| ${r.name} | \`${r.model}\` | ${r.nonStreaming?.status} | ${r.streaming?.status} | ${r.streaming?.includeUsageHonoured ? 'yes' : '**no**'} | ${r.toolStreaming?.toolDeltaCount ?? 0} | ${asm.length ? asm.map((a) => a.argsValid).join(', ') : 'n/a'} |`);
  }
  L.push('');

  for (const r of reports) {
    L.push(`## ${r.name}`);
    L.push('');
    L.push(`Base URL: \`${r.baseUrl}\``);
    L.push('');
    const rl = { ...(r.nonStreaming?.rateLimit ?? {}) };
    if (Object.keys(rl).length) {
      L.push('### Rate-limit headers');
      L.push('');
      L.push('```');
      for (const [k, v] of Object.entries(rl)) L.push(`${k}: ${v}`);
      L.push('```');
      L.push('');
      L.push('**These names are what `RateLimiter` must read.** Nothing in the codebase');
      L.push('may hardcode the values.');
    } else {
      L.push('### Rate-limit headers');
      L.push('');
      L.push('**None.** This provider gives the limiter nothing to steer by; budget for');
      L.push('it has to be inferred from 429s alone.');
    }
    L.push('');
    if (r.toolStreaming?.firstToolDelta) {
      L.push('### First streamed tool-call delta');
      L.push('');
      L.push('```json');
      L.push(JSON.stringify(r.toolStreaming.firstToolDelta, null, 2));
      L.push('```');
      L.push('');
    }
    if (r.streaming?.usage) {
      L.push(`Streamed usage: \`${JSON.stringify(r.streaming.usage)}\``);
      L.push('');
    }
    if (r.streaming?.fixture) L.push(`Raw SSE: \`${r.streaming.fixture}\`, \`${r.toolStreaming?.fixture ?? '—'}\``);
    L.push('');
  }
  return L.join('\n');
}

async function main() {
  env = load();

  const configured = resolveOrder(env);
  let chosen = configured.filter((c) => c.usable);
  if (only) chosen = chosen.filter((c) => c.name === only);

  const skipped = configured.filter((c) => !chosen.includes(c)).map((c) => `${c.name} (${c.profile.keyVar})`);

  say(`providers with a key: ${chosen.map((p) => p.name).join(', ') || 'none'}`);
  if (skipped.length) say(`skipped, no key:      ${skipped.join(', ')}`);
  if (chosen.length === 0) {
    say('\nNothing to probe. Copy example.env to .env and fill in at least one key.');
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    say('\n--dry-run: no requests made.');
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const reports = [];
  for (const p of chosen) {
    try {
      reports.push(await probeProvider(p));
    } catch (e) {
      say(`  ERROR ${redact(String(e?.message ?? e), env)}`);
      reports.push({ name: p.name, baseUrl: p.baseUrl, error: String(e?.message ?? e) });
    }
  }

  const md = path.join(OUT_DIR, 'report.md');
  fs.writeFileSync(md, redact(markdown(reports), env));
  const json = path.join(OUT_DIR, 'report.json');
  fs.writeFileSync(json, redact(JSON.stringify(reports, null, 2), env));
  say(`\nwrote ${md}`);
  say(`wrote ${json}`);
}

main().catch((e) => { process.stderr.write(redact(String(e?.stack ?? e), env) + '\n'); process.exit(70); });
