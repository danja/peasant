// Asking for permission: one keypress, and whose stdin it is read from.
//
// This path had no tests, which is how it shipped echoing every keypress twice.
// The question and the answer were always fine; the bug was *where* it asked.
// The REPL's readline owns stdin for the whole session and is still attached
// while a turn runs, which is exactly when permission is asked.
//
// Three approaches were measured under a pty on 2026-09-15:
//
//   second interface   two keypress listeners, both echo -- pressing `y` printed `yy`
//   rl.pause()         readline still handled the key: echoed it AND kept it in
//                      its line buffer, so the next input `second` arrived as `secondy`
//   detach             readline's keypress listeners removed for the duration and
//                      restored after -- nothing echoes, nothing is buffered
//
// The third is what the code does, so these tests hold it to the two properties
// that made it the right one: a listener that was already there must not see
// the answer, and it must still be there afterwards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { Prompt, interpret } from '../../src/permission/Prompt.js';
import { DECISION } from '../../src/permission/Policy.js';
import { Terminal } from '../../src/ui/Terminal.js';

const ESC = '';
const ETX = ''; // Ctrl-C
const EOT = ''; // Ctrl-D
const CR = '\r';

function sink() {
  const written = [];
  return {
    isTTY: false,
    columns: 80,
    write: (s) => { written.push(s); return true; },
    written,
    get text() { return written.join(''); },
  };
}

function harness() {
  const out = sink();
  const input = new PassThrough();
  input.isTTY = true;
  input.rawModes = [];
  input.setRawMode = (v) => { input.isRaw = v; input.rawModes.push(v); };
  const terminal = new Terminal({ out, err: sink(), colour: false, env: {} });
  return { out, input, prompt: new Prompt({ terminal, input }) };
}

const tool = { name: 'bash' };
const args = { command: 'ls' };

// Presses keys one at a time, each after the prompt has had a chance to listen.
function press(input, keys) {
  let i = 0;
  const next = () => {
    if (i >= keys.length) return;
    const key = keys[i++];
    setImmediate(() => { input.write(key); next(); });
  };
  next();
}

// --- what each key means ---------------------------------------------------

test('keys are interpreted, and only the ones that mean something', () => {
  for (const [key, expected] of [
    ['y', 'allow'], ['Y', 'allow'], [CR, 'allow'], ['\n', 'allow'],
    ['n', 'deny'], ['N', 'deny'],
    ['a', 'always'], ['A', 'always'],
    [ETX, 'deny'], [EOT, 'deny'], [ESC, 'deny'],
    ['z', null], ['1', null], ['', null], [' ', null],
  ]) {
    assert.equal(interpret(key), expected, `key ${JSON.stringify(key)}`);
  }
});

test('an escape sequence is not a lone Escape', () => {
  // An arrow key arrives as ESC [ A. Reading its first character as Escape
  // would turn a cursor key into a refusal, with no Enter to take it back.
  for (const seq of [`${ESC}[A`, `${ESC}[B`, `${ESC}[1;5D`, `${ESC}OP`]) {
    assert.equal(interpret(seq), null, JSON.stringify(seq));
  }
  assert.equal(interpret(ESC), 'deny', 'a lone Escape is still a refusal');
});

test('the first character of a longer chunk decides', () => {
  // A paste, or a fast typist. Taking the first key is what a terminal does.
  assert.equal(interpret('yes\n'), 'allow');
  assert.equal(interpret('no'), 'deny');
});

// --- answering -------------------------------------------------------------

test('one keypress answers, with no Enter', async () => {
  for (const [key, decision, remember, echo] of [
    ['y', DECISION.allow, false, 'yes'],
    ['a', DECISION.allow, true, 'always'],
    ['n', DECISION.deny, false, 'no'],
    [CR, DECISION.allow, false, 'yes'],
    [ETX, DECISION.deny, false, 'no'],
  ]) {
    const { prompt, input, out } = harness();
    const asking = prompt.ask(tool, args);
    press(input, [key]);
    const result = await asking;

    assert.equal(result.decision, decision, `key ${JSON.stringify(key)}`);
    assert.equal(result.remember, remember, `key ${JSON.stringify(key)} remember`);
    assert.match(out.text, new RegExp(`allow\\?[^\\n]*${echo}`), `key ${JSON.stringify(key)} echo`);
  }
});

test('the answer is echoed exactly once', async () => {
  // The whole point. Two listeners on stdin printed it twice.
  const { prompt, input, out } = harness();
  const asking = prompt.ask(tool, args);
  press(input, ['y']);
  await asking;

  const occurrences = out.text.split('yes').length - 1;
  assert.equal(occurrences, 1, `"yes" appears ${occurrences} times: ${JSON.stringify(out.text)}`);
});

test('a key that means nothing is ignored, not treated as a refusal', async () => {
  const { prompt, input } = harness();
  const asking = prompt.ask(tool, args);
  press(input, ['z', ' ', `${ESC}[A`, 'y']);
  const result = await asking;
  assert.equal(result.decision, DECISION.allow, 'a stray keystroke should not deny');
});

// --- whose stdin it is -----------------------------------------------------

test('a keypress listener already on stdin never sees the answer', async () => {
  // Models the REPL: readline translating data into keypress events and acting
  // on them. If it sees the answer it both echoes it and buffers it, and the
  // user's next line arrives with the answer stuck on the front -- measured as
  // `secondy` before this was fixed.
  const { prompt, input } = harness();
  readline.emitKeypressEvents(input);
  const seen = [];
  input.on('keypress', (ch) => seen.push(ch));

  const asking = prompt.ask(tool, args);
  press(input, ['y']);
  await asking;

  assert.deepEqual(seen, [], 'the pre-existing listener saw the answer key');
});

test('listeners are put back exactly as they were found', async () => {
  const { prompt, input } = harness();
  readline.emitKeypressEvents(input);
  const mine = () => {};
  input.on('keypress', mine);
  const before = input.listeners('keypress');

  const asking = prompt.ask(tool, args);
  press(input, ['y']);
  await asking;

  assert.deepEqual(input.listeners('keypress'), before, 'listeners were not restored');
  assert.ok(input.listeners('keypress').includes(mine));
});

test('the prompt leaves no listener of its own behind', async () => {
  const { prompt, input } = harness();
  const before = input.listenerCount('data');

  const asking = prompt.ask(tool, args);
  press(input, ['y']);
  await asking;

  assert.equal(input.listenerCount('data'), before, 'a data listener was left attached');
});

test('raw mode is turned on and put back', async () => {
  // On, because a keypress cannot be read a character at a time otherwise; back,
  // because the REPL had its own idea of the mode and has to keep it.
  const { prompt, input } = harness();
  input.isRaw = false;

  const asking = prompt.ask(tool, args);
  press(input, ['y']);
  await asking;

  assert.deepEqual(input.rawModes, [true, false], 'raw mode was not restored');
});

// --- nobody to ask ---------------------------------------------------------

test('with no terminal it refuses and names the flag that would allow it', async () => {
  const input = new PassThrough(); // no isTTY
  const terminal = new Terminal({ out: sink(), err: sink(), colour: false, env: {} });
  const result = await new Prompt({ terminal, input }).ask(tool, args);
  assert.equal(result.decision, DECISION.deny);
  assert.match(result.reason, /--allow-all/);
});
