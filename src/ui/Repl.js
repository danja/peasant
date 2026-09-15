// The interactive session.
//
// Ctrl-C is the whole design problem. It has to mean three different things
// depending on when it arrives:
//
//   mid-request   cancel the request, keep the session and everything in it
//   text typed    clear the line
//   empty prompt  leave
//
// Getting that wrong is how a harness loses a conversation that cost real
// tokens to build, so it is a state machine rather than a signal handler.

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

const MAX_HISTORY = 500;

// A line ending in a backslash continues, as a shell does.
const CONTINUATION = /\\$/;

// So does an unclosed ``` fence: pasting a code block is the common case, and
// counting fences is unambiguous where guessing at blank lines is not.
function fencesOpen(text) {
  const fences = text.match(/^\s*(?:```|~~~)/gm) ?? [];
  return fences.length % 2 === 1;
}

export function continues(line, joined) {
  return CONTINUATION.test(line) || fencesOpen(joined);
}

export function stripContinuations(text) {
  return text.replace(/\\\n/g, '\n');
}

export class Repl {
  #terminal;
  #input;
  #output;
  #historyFile;
  #rl = null;
  #busy = false;
  #controller = null;
  #closing = false;
  #exiting = false;
  #recent = [];
  #pending = [];

  constructor({ terminal, input = process.stdin, output = process.stdout, historyFile = null }) {
    this.#terminal = terminal;
    this.#input = input;
    this.#output = output;
    this.#historyFile = historyFile;
  }

  get busy() { return this.#busy; }


  // `handle(line, { signal })` does the work. It is given an AbortSignal that
  // fires when the user interrupts, so a long stream stops where it is.
  // Returning false ends the session.
  async start(handle) {
    const history = this.#loadHistory();
    // terminal: true forces readline to emit cursor-control escapes and echo
    // every line, whether or not anything is watching. Piped into a file that
    // produced "\x1b[1G\x1b[0J> " around each prompt and echoed the input
    // back. It follows the input, not a preference.
    const isTty = Boolean(this.#input.isTTY);

    this.#rl = readline.createInterface({
      input: this.#input,
      output: this.#output,
      terminal: isTty,
      history,
      historySize: MAX_HISTORY,
      prompt: this.#terminal.paint('> ', 'bold'),
      removeHistoryDuplicates: true,
    });

    if (isTty) this.#rl.on('SIGINT', () => this.#onInterrupt());
    // `close` fires at end of input, which for a pipe happens as soon as the
    // last line has been buffered. Treating that as "stop now" ended the
    // session after the first turn with every remaining line unread -- so it
    // records only that the interface is gone, and the loop ends when the
    // iterator runs out. Leaving deliberately is #exiting, which is different.
    this.#rl.on('close', () => { this.#closing = true; });

    this.#terminal.line(this.#terminal.paint(
      isTty
        ? 'Ctrl-C interrupts, Ctrl-D or /exit leaves, /help lists commands.'
        : 'reading from standard input; /help lists commands.',
      'grey'));
    this.#terminal.line('');
    this.#rl.prompt();

    // The async iterator pauses the input while the body is awaiting, which is
    // what keeps a pipe from delivering every line at once into one turn.
    for await (const line of this.#rl) {
      // Multiline input, because pasting a function into a prompt and having it
      // become eight separate turns is both useless and expensive.
      //
      // Two ways in, both explicit: a trailing backslash, and an unclosed code
      // fence. Neither guesses -- guessing whether a blank line ends a block is
      // how a REPL becomes impossible to predict.
      this.#pending.push(line);
      const joined = this.#pending.join('\n');
      if (continues(line, joined)) {
        this.#setPrompt(isTty ? this.#terminal.paint('… ', 'grey') : '');
        this.#rl.prompt();
        continue;
      }
      this.#setPrompt(isTty ? this.#terminal.paint('> ', 'bold') : '');

      const trimmed = stripContinuations(joined).trim();
      this.#pending = [];
      if (trimmed === '') { this.#rl.prompt(); continue; }

      this.#pushHistory(trimmed);
      this.#busy = true;
      this.#controller = new AbortController();

      try {
        const keepGoing = await handle(trimmed, { signal: this.#controller.signal });
        if (keepGoing === false) break;
      } catch (e) {
        if (e?.name === 'AbortError') {
          this.#terminal.endLine();
          this.#terminal.line(this.#terminal.paint('  interrupted', 'grey'));
        } else {
          this.#terminal.endLine();
          this.#terminal.error(this.#terminal.paint(e.message, 'red'));
          // A 400 is the conversation being unacceptable rather than the
          // provider being unavailable, so retrying the same thing repeats it
          // exactly. Saying so is the difference between a stuck session and a
          // recoverable one.
          if (/HTTP 400|bad request|invalid message/i.test(e.message)) {
            this.#terminal.error(this.#terminal.paint(
              '  this will repeat until the conversation changes — /clear starts a fresh one',
              'grey'));
          } else if (/no provider can serve/i.test(e.message)) {
            // Reaching this means compaction could not get the conversation
            // under the smallest available budget, so repeating the request
            // repeats the arithmetic. Say what would change it.
            this.#terminal.error(this.#terminal.paint(
              '  /compact reduces the conversation, /clear starts again, and a provider with more'
              + ' headroom in PEASANT_PROVIDERS avoids it entirely', 'grey'));
          }
        }
      } finally {
        this.#busy = false;
        this.#controller = null;
      }

      if (this.#exiting) break;
      this.#terminal.endLine();
      if (!this.#closing) this.#rl.prompt();
    }

    this.#saveHistory();
    this.#rl.close();
  }

  #setPrompt(prompt) {
    this.#rl.setPrompt(prompt);
  }

  #onInterrupt() {
    if (this.#busy) {
      // Cancel the request. The session, and everything it has cost, survives.
      this.#controller?.abort();
      return;
    }
    if (this.#pending.length > 0) {
      // A half-typed multiline block. Without this the only way out was to
      // finish the block or leave the session, because the buffer lived in the
      // loop and the signal handler could not reach it.
      this.#pending = [];
      this.#rl.write(null, { ctrl: true, name: 'u' });
      this.#setPrompt(this.#terminal.paint('> ', 'bold'));
      this.#terminal.line(this.#terminal.paint('  block abandoned', 'grey'));
      this.#rl.prompt();
      return;
    }
    if (this.#rl.line !== '') {
      // Something typed: clear it, as a shell does.
      this.#rl.write(null, { ctrl: true, name: 'u' });
      return;
    }
    this.#terminal.line('');
    this.#exiting = true;
    this.#rl.close();
  }

  #loadHistory() {
    if (!this.#historyFile) return [];
    try {
      // readline expects newest first.
      return fs.readFileSync(this.#historyFile, 'utf8').split('\n').filter(Boolean).reverse();
    } catch {
      return [];
    }
  }

  #pushHistory(line) {
    this.#recent = [...this.#recent, line].slice(-MAX_HISTORY);
  }

  #saveHistory() {
    if (!this.#historyFile || this.#recent.length === 0) return;
    try {
      fs.mkdirSync(path.dirname(this.#historyFile), { recursive: true });
      const existing = this.#loadHistory().reverse();
      const all = [...existing, ...this.#recent].slice(-MAX_HISTORY);
      fs.writeFileSync(this.#historyFile, `${all.join('\n')}\n`, { mode: 0o600 });
    } catch {
      // History is a convenience. Failing to save it must never end a session.
    }
  }
}
