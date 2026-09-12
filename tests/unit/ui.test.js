import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Terminal, detectColour } from '../../src/ui/Terminal.js';
import { Render } from '../../src/ui/Render.js';
import { renderEdit, renderWrite } from '../../src/ui/Diff.js';
import { strip, width, CODES } from '../../src/ui/Ansi.js';

// A stream that records what was written, standing in for stdout.
function sink({ isTTY = false, columns = 80 } = {}) {
  const written = [];
  return {
    isTTY, columns,
    write: (s) => { written.push(s); return true; },
    written,
    get text() { return written.join(''); },
  };
}

function plainTerminal(opts = {}) {
  const out = sink(opts);
  return { term: new Terminal({ out, err: sink(), colour: false, env: {} }), out };
}

function colourTerminal() {
  const out = sink({ isTTY: true });
  return { term: new Terminal({ out, err: sink(), colour: true, env: {} }), out };
}

// --- Terminal --------------------------------------------------------------

test('colour follows the stream, not a preference', () => {
  assert.equal(detectColour({ isTTY: true }, {}), true);
  assert.equal(detectColour({ isTTY: false }, {}), false,
    'a redirected log full of escapes is worse than a plain one');
  assert.equal(detectColour({ isTTY: true }, { NO_COLOR: '1' }), false);
  assert.equal(detectColour({ isTTY: false }, { FORCE_COLOR: '1' }), true);
  assert.equal(detectColour({ isTTY: true }, { TERM: 'dumb' }), false);
});

test('escapes are stripped when colour is off', () => {
  const { term, out } = plainTerminal();
  term.line(`plain ${CODES.red}red${CODES.reset}`);
  assert.equal(out.text, 'plain red\n');
});

test('paint refuses a colour that is not declared', () => {
  // A mistyped colour would otherwise silently produce no styling at all.
  const { term } = colourTerminal();
  assert.throws(() => term.paint('x', 'puce'), /unknown colour "puce"/);
});

test('endLine only ends a line that was started', () => {
  const { term, out } = plainTerminal();
  term.write('half');
  term.endLine();
  term.endLine();
  assert.equal(out.text, 'half\n');
});

test('status is suppressed off a terminal', () => {
  // Otherwise a redirected log fills with cursor-control characters.
  const { term, out } = plainTerminal({ isTTY: false });
  term.status('working');
  term.clearStatus();
  assert.equal(out.text, '');
});

test('Ansi strip and width ignore escapes', () => {
  const painted = `${CODES.bold}bold${CODES.reset}`;
  assert.equal(strip(painted), 'bold');
  assert.equal(width(painted), 4);
});

// --- Render ----------------------------------------------------------------

function render(chunks) {
  const { term, out } = plainTerminal();
  const r = new Render(term);
  for (const c of chunks) r.write(c);
  r.flush();
  return out.text;
}

test('renders text split across arbitrary chunk boundaries identically', () => {
  // Markdown arrives in pieces: a ** can be split between two deltas, which is
  // the whole reason the renderer buffers by line.
  const source = 'Some **bold** and `code` here.\nA second line.\n';
  const whole = render([source]);
  for (let size = 1; size <= 12; size++) {
    const chunks = [];
    for (let i = 0; i < source.length; i += size) chunks.push(source.slice(i, i + size));
    assert.equal(render(chunks), whole, `chunk size ${size}`);
  }
});

test('flushes a final line with no trailing newline', () => {
  // A reply rarely ends with one, and without flush the last line vanishes.
  assert.equal(render(['no newline at the end']), 'no newline at the end\n');
});

test('nothing inside a code fence is treated as markup', () => {
  // A shell command full of asterisks must not turn half the block bold.
  const out = render(['```sh\nrm -rf **/*.tmp\n```\n']);
  assert.match(out, /rm -rf \*\*\/\*\.tmp/);
});

test('a fence closes only on its own marker', () => {
  const { term } = plainTerminal();
  const r = new Render(term);
  r.write('```\n');
  assert.equal(r.inFence, true);
  r.write('~~~\n');
  assert.equal(r.inFence, true, 'a different marker inside a fence is content');
  r.write('```\n');
  assert.equal(r.inFence, false);
});

test('headings and bullets survive rendering', () => {
  const out = render(['# Title\n- one\n- two\n']);
  assert.match(out, /^Title$/m);
  assert.match(out, /^- one$/m);
});

test('a code span containing asterisks is not emphasised', () => {
  const { term, out } = colourTerminal();
  const r = new Render(term);
  r.write('use `a**b` please\n');
  r.flush();
  assert.ok(out.text.includes('a**b'), 'the asterisks inside the code span survive');
});

test('an unclosed fence still flushes what it has', () => {
  assert.match(render(['```js\nconst x = 1;']), /const x = 1;/);
});

// --- Diff ------------------------------------------------------------------

test('an edit is shown as minus and plus lines', () => {
  const { term } = plainTerminal();
  const lines = renderEdit(term, { path: 'a.js', old: 'const a = 1;', replacement: 'const a = 2;' });
  assert.match(lines[0], /^a\.js$/);
  assert.match(lines[1], /^ {2}- const a = 1;$/);
  assert.match(lines[2], /^ {2}\+ const a = 2;$/);
});

test('a long edit is clipped head and tail', () => {
  // A permission prompt that fills a screen is one people stop reading.
  const { term } = plainTerminal();
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const lines = renderEdit(term, { path: 'a.js', old: long, replacement: 'x' });
  assert.ok(lines.length < 20, `showed ${lines.length} lines`);
  assert.ok(lines.some((l) => /more lines/.test(l)));
  assert.ok(lines.some((l) => /line 0$/.test(l)), 'the head is kept');
  assert.ok(lines.some((l) => /line 39$/.test(l)), 'and the tail, where the point usually is');
});

test('a write says whether it creates or replaces', () => {
  const { term } = plainTerminal();
  assert.match(renderWrite(term, { path: 'a.js', content: 'x' })[0], /^create a\.js$/);
  assert.match(renderWrite(term, { path: 'a.js', content: 'x', existed: true })[0], /^replace a\.js$/);
});
