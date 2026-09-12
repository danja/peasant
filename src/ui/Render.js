// Rendering streamed model output.
//
// The difficulty is that markdown arrives in pieces: a `**` can be split across
// two chunks, and a fence opener can arrive without its closer for several
// seconds. So the renderer is line-buffered -- a line is styled once it is
// complete, and held until then.
//
// One line of latency is the cost. At the rate these models stream that reads
// as natural line-at-a-time output, and the alternative is either re-printing
// styled text over unstyled text or getting the styling wrong at a boundary.

const FENCE = /^\s*(```|~~~)(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;

export class Render {
  #terminal;
  #buffer = '';
  #inFence = false;
  #fenceMarker = null;

  constructor(terminal) {
    this.#terminal = terminal;
  }

  get inFence() { return this.#inFence; }

  // Feed a streamed delta. Returns nothing; it writes through the terminal.
  write(delta) {
    this.#buffer += delta;
    let index = this.#buffer.indexOf('\n');
    while (index !== -1) {
      this.#emit(this.#buffer.slice(0, index));
      this.#buffer = this.#buffer.slice(index + 1);
      index = this.#buffer.indexOf('\n');
    }
  }

  // Whatever is left when the stream ends, and there usually is something: a
  // reply rarely ends with a newline.
  flush() {
    if (this.#buffer !== '') { this.#emit(this.#buffer); this.#buffer = ''; }
    this.#inFence = false;
    this.#fenceMarker = null;
  }

  #emit(line) {
    this.#terminal.line(this.#style(line));
  }

  #style(line) {
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      if (!this.#inFence) {
        this.#inFence = true;
        this.#fenceMarker = marker;
        // The language tag is worth keeping: it is often the only clue about
        // what a block is for.
        return this.#terminal.paint(fence[2].trim() === '' ? marker : `${marker}${fence[2]}`, 'grey');
      }
      if (marker === this.#fenceMarker) {
        this.#inFence = false;
        this.#fenceMarker = null;
        return this.#terminal.paint(marker, 'grey');
      }
      // A different marker inside a fence is content, not a closer.
    }

    // Inside a fence nothing is markup. A shell command full of asterisks must
    // not turn half the block bold.
    if (this.#inFence) return this.#terminal.paint(line, 'cyan');

    const heading = HEADING.exec(line);
    if (heading) return this.#terminal.paint(heading[2], 'bold');

    const bullet = BULLET.exec(line);
    if (bullet) {
      return `${bullet[1]}${this.#terminal.paint(bullet[2], 'grey')} ${this.#inline(bullet[3])}`;
    }

    return this.#inline(line);
  }

  // Inline spans, on a complete line only -- which is why the buffering exists.
  #inline(text) {
    const term = this.#terminal;
    return text
      // Code spans first: a `**` inside backticks is not emphasis.
      .replace(/`([^`\n]+)`/g, (_, code) => term.paint(code, 'cyan'))
      .replace(/\*\*([^*\n]+)\*\*/g, (_, bold) => term.paint(bold, 'bold'))
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, (_, pre, em) => `${pre}${term.paint(em, 'italic')}`);
  }
}
