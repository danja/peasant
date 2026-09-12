// The only module that writes to stdout.
//
// Every byte the user sees goes through here, so that colour can be switched
// off for a pipe in one place, so that a redraw knows what is on screen, and so
// that "why is there a stray escape code in my log" has one file to look in.
// tests/guard/no-raw-stdout.test.js enforces it.

import { CODES, CURSOR, strip } from './Ansi.js';

export class Terminal {
  #out;
  #err;
  #colour;
  #atLineStart = true;

  constructor({
    out = process.stdout,
    err = process.stderr,
    colour = null,
    env = process.env,
  } = {}) {
    this.#out = out;
    this.#err = err;
    this.#colour = colour ?? detectColour(out, env);
  }

  get colourEnabled() { return this.#colour; }
  get isTTY() { return Boolean(this.#out.isTTY); }
  get columns() { return this.#out.columns ?? 80; }
  get atLineStart() { return this.#atLineStart; }

  // Paint text in a named colour, or return it unchanged when colour is off.
  paint(text, ...names) {
    if (!this.#colour || names.length === 0) return String(text);
    const prefix = names.map((n) => {
      const code = CODES[n];
      if (!code) throw new Error(`unknown colour ${JSON.stringify(n)}; see src/ui/Ansi.js`);
      return code;
    }).join('');
    return `${prefix}${text}${CODES.reset}`;
  }

  write(text) {
    const s = this.#colour ? String(text) : strip(text);
    if (s === '') return;
    this.#out.write(s);
    this.#atLineStart = s.endsWith('\n');
  }

  line(text = '') { this.write(`${text}\n`); }

  // Ends the current line if something is part-written. Used before switching
  // from streamed output to a status line.
  endLine() { if (!this.#atLineStart) this.write('\n'); }

  error(text) { this.#err.write(`${this.#colour ? text : strip(text)}\n`); }

  hideCursor() { if (this.isTTY) this.write(CURSOR.hide); }
  showCursor() { if (this.isTTY) this.write(CURSOR.show); }

  // Overwrites the current line. A no-op off a terminal, where it would just
  // litter a log with control characters.
  status(text) {
    if (!this.isTTY) return;
    this.#out.write(`${CURSOR.lineStart}${CURSOR.clearLine}${this.#colour ? text : strip(text)}`);
    this.#atLineStart = false;
  }

  clearStatus() {
    if (!this.isTTY) return;
    this.#out.write(`${CURSOR.lineStart}${CURSOR.clearLine}`);
    this.#atLineStart = true;
  }
}

// NO_COLOR and FORCE_COLOR are the conventions; beyond that, colour goes to a
// terminal and not to a pipe, because a redirected log full of escapes is worse
// than a plain one.
export function detectColour(stream, env) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  if (env.TERM === 'dumb') return false;
  return Boolean(stream.isTTY);
}
