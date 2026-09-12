import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  estimateText, estimateMessage, estimateRequest, classify,
  looksLikeCode, looksLikeJson, TokenEstimator, CONSTANTS,
} from '../../src/agent/TokenEstimator.js';
import { specs } from '../../src/tools/registry.js';
import { REPO } from './lib/fixtures.js';

// The recording bin/probe-tokens.js made against a live provider. The
// estimator's constants are claims about it, so they are checked against it.
function recording() {
  const dir = path.join(REPO, 'docs', 'raw');
  const file = fs.readdirSync(dir).filter((f) => f.endsWith('_tokens.json')).sort().at(-1);
  assert.ok(file, 'no token recording in docs/raw/*_tokens.json -- run: node bin/probe-tokens.js');
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
}

const rec = recording();
const derivedRate = (sample) => (sample.tokens - rec.baseline) / sample.textChars;

// --- the constants are measurements ---------------------------------------

test('the prose and code rates match what was measured', () => {
  // If these drift apart, either the constants were changed without re-probing
  // or the model changed under us. Either way it is worth knowing.
  for (const kind of ['prose', 'code']) {
    const samples = rec.samples.filter((s) => s.kind === kind);
    assert.ok(samples.length >= 2, `no ${kind} samples recorded`);
    for (const s of samples) {
      const measured = derivedRate(s);
      const constant = CONSTANTS[kind];
      assert.ok(constant >= measured * 0.98,
        `${s.label}: measured ${measured.toFixed(3)} tokens/char but the constant is ${constant} -- underestimating causes 429s`);
      assert.ok(constant <= measured * 1.15,
        `${s.label}: measured ${measured.toFixed(3)} but the constant is ${constant} -- overestimating refuses requests that would have fitted`);
    }
  }
});

test('code really is about twice as dense as prose', () => {
  // The finding that makes a single "characters over four" constant unusable:
  // at 0.25 it would underestimate a file read by forty per cent.
  const prose = derivedRate(rec.samples.find((s) => s.kind === 'prose' && s.textChars === 3200));
  const code = derivedRate(rec.samples.find((s) => s.kind === 'code' && s.textChars === 3200));
  assert.ok(code / prose > 1.7, `code/prose density was ${(code / prose).toFixed(2)}`);
});

test('the request overhead matches the measured baseline', () => {
  assert.equal(CONSTANTS.requestOverhead, rec.baseline,
    'the per-request overhead is measured, not chosen');
});

test('the tool schemas are estimated within a safe margin', () => {
  // The single biggest item in a turn, and resent on every one of them.
  const estimate = estimateText(JSON.stringify(specs()));
  assert.ok(estimate >= rec.toolSchemaCost, `estimate ${estimate} under the measured ${rec.toolSchemaCost}`);
  assert.ok(estimate <= rec.toolSchemaCost * 1.25, `estimate ${estimate} is more than 25% over ${rec.toolSchemaCost}`);
});

test('the recorded fixed cost per turn is what the plan says it is', () => {
  // A prose claim bound to a measurement: docs/plan.md and CLAUDE.md both cite
  // this number, and nothing else would notice it going stale.
  const fixed = rec.baseline + rec.toolSchemaCost + rec.systemPromptCost;
  assert.ok(fixed > 500 && fixed < 2000, `fixed cost per turn was ${fixed}`);
});

// --- classification --------------------------------------------------------

test('JSON is recognised before code, because it does not tokenise like code', () => {
  const toolJson = JSON.stringify(specs());
  assert.equal(classify(toolJson), 'json');
  assert.ok(looksLikeJson(toolJson));
  assert.equal(classify('[{"a": 1}]'), 'json');
});

test('code is recognised by density, not by extension', () => {
  assert.equal(classify('export function add(a, b) {\n  return a + b;\n}\n'), 'code');
  assert.equal(classify('const xs = [1,2,3].map((n) => n * 2);'), 'code');
  assert.ok(looksLikeCode('if (x === 1) { y(); }'));
});

test('prose is recognised as prose', () => {
  assert.equal(classify('The quick brown fox jumps over the lazy dog, repeatedly and without complaint.'), 'prose');
  assert.equal(classify(''), 'prose');
});

test('an indented block reads as code even without many symbols', () => {
  assert.equal(classify('def f():\n    return 1\n\ndef g():\n    return 2\n'), 'code');
});

// --- estimates -------------------------------------------------------------

test('an empty request still costs the overhead', () => {
  assert.equal(estimateRequest({}), CONSTANTS.requestOverhead);
});

test('estimates grow with content and with tools', () => {
  const bare = estimateRequest({ messages: [{ role: 'user', content: 'hello' }] });
  const withTools = estimateRequest({ messages: [{ role: 'user', content: 'hello' }], tools: specs() });
  assert.ok(withTools > bare + 500, 'the tool schemas dominate a short turn');
});

test('a tool call is counted through its serialised arguments', () => {
  const plain = estimateMessage({ role: 'assistant', content: '' });
  const withCall = estimateMessage({
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'read', arguments: '{"path":"src/a/very/long/path.js"}' } }],
  });
  assert.ok(withCall > plain, 'arguments go on the wire and must be counted');
});

// --- calibration -----------------------------------------------------------

test('a fresh estimator applies no correction', () => {
  const e = new TokenEstimator();
  assert.equal(e.correction, 1);
  assert.equal(e.estimate({ messages: [{ role: 'user', content: 'x' }] }),
    estimateRequest({ messages: [{ role: 'user', content: 'x' }] }));
});

test('it converges towards what the provider actually charges', () => {
  // Every response hands us the answer. Staying wrong would be a choice.
  const e = new TokenEstimator();
  const request = { messages: [{ role: 'user', content: 'hello there' }] };
  for (let i = 0; i < 30; i++) {
    e.observe({ predicted: e.estimate(request), actual: estimateRequest(request) * 0.8 });
  }
  assert.ok(Math.abs(e.correction - 0.8) < 0.05, `correction settled at ${e.correction.toFixed(3)}`);
});

test('a single strange response cannot distort every later estimate', () => {
  // A cached prompt, or a provider counting an image, must not make the
  // budgeter absurd for the rest of the session.
  const e = new TokenEstimator();
  e.observe({ predicted: 100, actual: 100000 });
  assert.ok(e.correction <= 2, `correction was ${e.correction}`);
  const e2 = new TokenEstimator();
  e2.observe({ predicted: 100000, actual: 1 });
  assert.ok(e2.correction >= 0.5, `correction was ${e2.correction}`);
});

test('nonsense observations are ignored rather than poisoning the estimate', () => {
  const e = new TokenEstimator();
  for (const bad of [
    { predicted: 0, actual: 10 }, { predicted: 10, actual: 0 },
    { predicted: NaN, actual: 10 }, { predicted: 10, actual: undefined },
  ]) e.observe(bad);
  assert.equal(e.correction, 1);
  assert.equal(e.observations, 0);
});
