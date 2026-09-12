// Turning agent events into terminal output.
//
// `ask`, `run` and the interactive session all consume the same event stream,
// so they all print it the same way -- one place to change, and no chance of
// the session and the one-shot command disagreeing about what a tool call looks
// like.

import { Render } from '../ui/Render.js';
import { describe } from '../permission/Prompt.js';

export class EventPrinter {
  #terminal;
  #render;
  #showTools;
  #provider = null;
  #reasoning = false;
  #tokensIn = 0;
  #tokensOut = 0;
  #reasoningTokens = 0;

  constructor(terminal, { showTools = true } = {}) {
    this.#terminal = terminal;
    this.#render = new Render(terminal);
    this.#showTools = showTools;
  }

  get totals() {
    return { in: this.#tokensIn, out: this.#tokensOut, reasoning: this.#reasoningTokens };
  }

  handle(ev) {
    const term = this.#terminal;
    switch (ev.type) {
      case 'provider':
        // Only when it changes. Repeating the name every turn is noise that
        // hides the one case it exists for: a rotation mid-task.
        if (ev.name !== this.#provider) {
          this.#provider = ev.name;
          term.endLine();
          term.line(term.paint(`  ${ev.name}`, 'grey'));
        }
        break;

      case 'reasoning':
        // Never rendered. It is the model's private working, and on some
        // models it is most of the completion.
        if (!this.#reasoning) {
          this.#reasoning = true;
          term.status(term.paint('  thinking...', 'grey'));
        }
        break;

      case 'text':
        if (this.#reasoning) { term.clearStatus(); this.#reasoning = false; }
        this.#render.write(ev.delta);
        break;

      case 'usage':
        this.#tokensIn += ev.usage.prompt_tokens ?? 0;
        this.#tokensOut += ev.usage.completion_tokens ?? 0;
        this.#reasoningTokens += ev.usage.completion_tokens_details?.reasoning_tokens ?? 0;
        break;

      case 'tool-start':
        if (!this.#showTools) break;
        this.#render.flush();
        term.clearStatus();
        term.endLine();
        term.line(term.paint(`  ${ev.name}  ${describe({ name: ev.name }, ev.args)[0] ?? ''}`, 'cyan'));
        break;

      case 'tool-result':
        if (!this.#showTools) break;
        term.line(term.paint(`    ${firstLine(ev.content)}`, ev.ok ? 'grey' : 'yellow'));
        break;

      case 'compacted':
        this.#render.flush();
        term.endLine();
        term.line(term.paint(
          `  compacted ${ev.summarised} messages: ${ev.before} -> ${ev.after} tokens`, 'grey'));
        break;

      case 'empty-reply':
        this.#render.flush();
        term.clearStatus();
        term.endLine();
        term.line(term.paint(
          `  ${ev.provider ?? 'the model'} replied with nothing`
          + `${ev.attempt <= 1 ? ' — trying once more' : ''}`, 'yellow'));
        break;

      case 'compact-skipped':
        term.endLine();
        term.line(term.paint(`  not compacted: ${ev.reason}`, 'yellow'));
        break;

      case 'done':
        this.#render.flush();
        term.clearStatus();
        term.endLine();
        break;

      default:
        break;
    }
  }

  // The one-line footer. Reasoning tokens are shown separately because they are
  // invisible in the output and frequently most of the bill.
  summary({ model = null, reason = null, turns = null } = {}) {
    const bits = [];
    if (model) bits.push(model);
    if (reason && turns) bits.push(`${reason} in ${turns} turn${turns === 1 ? '' : 's'}`);
    bits.push(`${this.#tokensIn} in`, `${this.#tokensOut} out`);
    if (this.#reasoningTokens > 0) bits.push(`${this.#reasoningTokens} reasoning`);
    return this.#terminal.paint(`  ${bits.join(' · ')}`, 'grey');
  }

  reset() {
    this.#provider = null;
    this.#reasoning = false;
  }
}

function firstLine(text) {
  const line = String(text).split('\n')[0];
  return line.length > 100 ? `${line.slice(0, 100)}...` : line;
}
