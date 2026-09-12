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
      const trimmed = line.trim();
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

  #onInterrupt() {
    if (this.#busy) {
      // Cancel the request. The session, and everything it has cost, survives.
      this.#controller?.abort();
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
