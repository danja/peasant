// Asking, and what to do when there is nobody to ask.
//
// The failure this is shaped around: a non-interactive run -- piped, in CI, in
// a script -- reaching a mutating tool with mode `ask`. There is no terminal,
// so the question cannot be put. Hanging forever is the worst answer, silently
// allowing is the second worst. It refuses, and says which flag would have
// permitted it.

import readline from 'node:readline';
import { DECISION } from './Policy.js';
import { renderEdit, renderWrite } from '../ui/Diff.js';

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
    for (const line of preview(term, tool, args)) term.line(`    ${line}`);
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

// What will happen, shown the way a person can check it. `edit` and `write`
// get a real diff, because "is this the right change" is not a question anyone
// can answer from a JSON blob -- and an approval prompt nobody reads properly
// is worse than no prompt at all.
export function preview(terminal, tool, args) {
  switch (tool.name) {
    case 'edit':
      return renderEdit(terminal, {
        path: args.path, old: args.old, replacement: args.new, all: args.all,
      });
    case 'write':
      return renderWrite(terminal, { path: args.path, content: args.content });
    default:
      return describe(tool, args).map((line) => terminal.paint(line, 'grey'));
  }
}

// A single line naming the action, for the running display rather than the
// prompt. The full argument JSON is unreadable at a glance and hides the one
// field that matters.
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
