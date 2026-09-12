// Project and personal instructions, folded into the system prompt.
//
// This is the cheapest thing available for improving output quality on a weak
// model: telling it the conventions of the repository it is in beats any amount
// of prompt engineering in the abstract.
//
// It is also the easiest thing to make expensive. Everything here is resent on
// every turn of every session, against a budget of eight thousand tokens a
// minute, so there is a hard cap and it says when it bites. A context file
// nobody has read the size of is a tax on every request.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// About 1,700 tokens of prose at the measured rate. Beyond that a context file
// is competing with the conversation for room rather than helping it.
export const MAX_CHARS = 8000;

// PEASANT.md first, then AGENTS.md -- the cross-tool convention, which many
// repositories already have. CLAUDE.md is deliberately *not* read: it is
// addressed to a different agent with different tools, and following
// instructions written for someone else is worse than having none.
export const PROJECT_NAMES = ['PEASANT.md', 'AGENTS.md'];

export function userFile({ env = process.env, home = os.homedir() } = {}) {
  const dir = env.PEASANT_HOME
    ? (env.PEASANT_HOME.startsWith('~') ? path.join(home, env.PEASANT_HOME.slice(1)) : env.PEASANT_HOME)
    : path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'peasant');
  return path.join(dir, 'PEASANT.md');
}

// Returns the files that were found, read and capped, with whatever had to be
// said about them.
export function loadContext({ root, env = process.env, home = os.homedir(), maxChars = MAX_CHARS } = {}) {
  const found = [];
  const notes = [];

  const take = (file, label) => {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return; // absent is the normal case
    }
    if (text.trim() === '') return;

    let content = text;
    if (content.length > maxChars) {
      content = `${content.slice(0, maxChars)}\n\n[truncated: ${text.length - maxChars} more characters]`;
      notes.push(`${file} is ${text.length} characters; only the first ${maxChars} are sent`);
    }
    found.push({ file, label, content, chars: content.length });
  };

  take(userFile({ env, home }), 'your instructions');

  for (const name of PROJECT_NAMES) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) { take(file, `${name} from this project`); break; }
  }

  return { found, notes, chars: found.reduce((n, f) => n + f.chars, 0) };
}

// Rendered for the system prompt. Each block says where it came from, because a
// model given instructions with no provenance cannot weigh them against the
// task it was actually asked to do.
export function renderContext(found) {
  if (found.length === 0) return '';
  return found
    .map((f) => `--- ${f.label} (${f.file}) ---\n${f.content.trim()}`)
    .join('\n\n');
}
