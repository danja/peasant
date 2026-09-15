// Asking, and what to do when there is nobody to ask.
//
// The failure this is shaped around: a non-interactive run -- piped, in CI, in
// a script -- reaching a mutating tool with mode `ask`. There is no terminal,
// so the question cannot be put. Hanging forever is the worst answer, silently
// allowing is the second worst. It refuses, and says which flag would have
// permitted it.

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

    const choice = await this.#choose(term.paint('  allow? [y]es / [n]o / [a]lways: ', 'yellow'));

    if (choice === 'always') return { decision: DECISION.allow, remember: true };
    if (choice === 'allow') return { decision: DECISION.allow, remember: false };
    return { decision: DECISION.deny, remember: false, reason: 'the user declined' };
  }

  // Writes the question, waits for a key that means something, and echoes what
  // it understood. A key that means nothing is ignored rather than treated as a
  // refusal: with no Enter to correct a slip, a stray keystroke denying the
  // tool would be a bad trade, and an arrow key is not an answer.
  async #choose(question) {
    const term = this.#terminal;
    term.write(question);

    for (;;) {
      const choice = interpret(await this.#readKey());
      if (!choice) continue;
      // Nothing else echoes -- see #readKey -- so the feedback is written here,
      // once. The word rather than the letter, because `y` alone at the end of
      // that line does not read as an answer to it.
      term.write(`${ECHO[choice]}\n`);
      return choice;
    }
  }

  // One keypress, from the raw stream, with readline moved out of the way.
  //
  // Not `rl.question`, and not a readline interface of its own. The REPL's
  // interface owns stdin for the whole session and is still attached while a
  // turn runs, which is exactly when permission is asked. Two ways of coping
  // were measured under a pty on 2026-09-15:
  //
  //   pause    `rl.pause()` does *not* stop readline handling the key. It
  //            echoed it and kept it in its line buffer, so answering `y` here
  //            turned the user's next input `second` into `secondy`.
  //   detach   readline's keypress listeners removed for the duration and put
  //            back after. Nothing echoes, nothing is buffered, and the next
  //            line reads clean.
  //
  // So: detach. It also removes the original double-echo at the root, because
  // there is no longer a second interface to be a second listener.
  //
  // This assumes whatever else is listening is listening to the *same* stream,
  // which for stdin it is.
  #readKey() {
    const input = this.#input;

    return new Promise((resolve) => {
      const saved = input.listeners('keypress');
      input.removeAllListeners('keypress');

      const wasRaw = Boolean(input.isRaw);
      input.setRawMode?.(true);
      input.resume();

      const onData = (chunk) => {
        input.removeListener('data', onData);
        input.setRawMode?.(wasRaw);
        // Put readline back exactly as it was found. If there was none -- as in
        // `peasant run` -- this restores nothing, which is correct.
        for (const listener of saved) input.on('keypress', listener);
        resolve(chunk.toString('utf8'));
      };

      input.on('data', onData);
    });
  }

}

// What each key means. Enter is yes, because the question is asked on a tool the
// model has already decided to run and the common answer is agreement.
// Ctrl-C, Ctrl-D and a lone Escape are all refusals: every one of them is a
// person trying to get out of something.
const KEYS = Object.freeze({
  y: 'allow', Y: 'allow', '\r': 'allow', '\n': 'allow',
  n: 'deny', N: 'deny',
  a: 'always', A: 'always',
  '\u0003': 'deny', '\u0004': 'deny', '\u001b': 'deny',
});

const ECHO = Object.freeze({ allow: 'yes', deny: 'no', always: 'always' });

// The first character of a chunk, when it means something. Null for everything
// else, including an escape *sequence* -- an arrow key arrives as `\u001b[A`,
// and reading its first character as a lone Escape would turn a cursor key into
// a refusal.
export function interpret(chunk) {
  if (typeof chunk !== 'string' || chunk === '') return null;
  if (chunk[0] === '\u001b' && chunk.length > 1) return null;
  return KEYS[chunk[0]] ?? null;
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
      return describe(tool.name, args).map((line) => terminal.paint(line, 'grey'));
  }
}

// A single line naming the action, for the running display rather than the
// prompt. The full argument JSON is unreadable at a glance and hides the one
// field that matters.
//
// Takes a name rather than a tool, because its only caller outside this file
// has an event rather than a tool and was passing `{ name }` to satisfy the
// signature -- a seam that would break the moment this needed anything else.
export function describe(name, args) {
  switch (name) {
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
