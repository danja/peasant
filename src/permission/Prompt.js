// Asking, and what to do when there is nobody to ask.
//
// The failure this is shaped around: a non-interactive run -- piped, in CI, in
// a script -- reaching a mutating tool with mode `ask`. There is no terminal,
// so the question cannot be put. Hanging forever is the worst answer, silently
// allowing is the second worst. It refuses, and says which flag would have
// permitted it.

import readline from 'node:readline';
import { DECISION } from './Policy.js';

export class Prompt {
  #terminal;
  #input;
  #interactive;

  constructor({ terminal, input = process.stdin } = {}) {
    this.#terminal = terminal;
    this.#input = input;
    this.#interactive = Boolean(input.isTTY);
  }

  get interactive() { return this.#interactive; }

  // Returns 'allow' or 'deny'. `remember` says whether the answer should stick
  // for the rest of the session.
  async ask(tool, args) {
    const term = this.#terminal;

    if (!this.#interactive) {
      return {
        decision: DECISION.deny,
        remember: false,
        reason:
          `cannot ask permission to run ${tool.name}: no terminal attached. `
          + 'Re-run with --allow-all, or set PEASANT_PERMISSION_MODE=allow, if that is what you intend.',
      };
    }

    term.endLine();
    term.line(term.paint(`  ${tool.name}`, 'bold', 'yellow'));
    for (const line of describe(tool, args)) term.line(term.paint(`    ${line}`, 'grey'));
    term.line('');

    const answer = await this.#question(term.paint('  allow? [y]es / [n]o / [a]lways: ', 'yellow'));
    const a = answer.trim().toLowerCase();

    if (a === 'a' || a === 'always') return { decision: DECISION.allow, remember: true };
    if (a === 'y' || a === 'yes' || a === '') return { decision: DECISION.allow, remember: false };
    return { decision: DECISION.deny, remember: false, reason: 'the user declined' };
  }

  #question(text) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: this.#input, output: process.stdout, terminal: true });
      rl.question(text, (answer) => { rl.close(); resolve(answer); });
    });
  }
}

// What the model is about to do, in the form a person can judge in a second.
// The full argument JSON is unreadable at a glance and hides the one field that
// matters, so each tool gets the line that actually says what will happen.
export function describe(tool, args) {
  switch (tool.name) {
    case 'bash':
      return [args.command];
    case 'write':
      return [`write ${args.path}`, `${String(args.content ?? '').split('\n').length} lines`];
    case 'edit': {
      const old = String(args.old ?? '');
      const now = String(args.new ?? '');
      return [
        `edit ${args.path}${args.all ? ' (all occurrences)' : ''}`,
        `- ${firstLine(old)}`,
        `+ ${firstLine(now)}`,
      ];
    }
    default:
      return [JSON.stringify(args)];
  }
}

function firstLine(s) {
  const [first, ...rest] = s.split('\n');
  const shown = first.length > 70 ? `${first.slice(0, 70)}...` : first;
  return rest.length > 0 ? `${shown} (+${rest.length} more lines)` : shown;
}
