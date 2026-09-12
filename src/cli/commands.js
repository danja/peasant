// Custom slash commands: a file that becomes a prompt.
//
// The point is repetition. "Review this diff the way we review diffs" is worth
// writing once per repository rather than retyping, and a file in the project
// is reviewable and versioned where a habit is neither.
//
//   .peasant/commands/review.md       ->  /review
//   ~/.config/peasant/commands/x.md   ->  /x
//
// The project's own commands win by name, so a repository can specialise one
// without disabling it everywhere.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_CHARS = 16_000;

export function commandDirs({ env = process.env, root = process.cwd(), home = os.homedir() } = {}) {
  const userDir = env.PEASANT_HOME
    ? (env.PEASANT_HOME.startsWith('~') ? path.join(home, env.PEASANT_HOME.slice(1)) : env.PEASANT_HOME)
    : path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'peasant');

  return [path.join(userDir, 'commands'), path.join(root, '.peasant', 'commands')];
}

// A leading `# ` line is the command's description, for /help. Everything after
// is the prompt.
export function parseCommand(text) {
  const lines = text.split('\n');
  if (lines[0]?.startsWith('# ')) {
    return { description: lines[0].slice(2).trim(), body: lines.slice(1).join('\n').trim() };
  }
  return { description: null, body: text.trim() };
}

export function loadCommands(options = {}) {
  const commands = new Map();

  for (const dir of options.dirs ?? commandDirs(options)) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // absent is the normal case
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const name = entry.name.replace(/\.md$/, '').toLowerCase();
      if (!/^[a-z][a-z0-9_-]*$/.test(name)) continue;

      const file = path.join(dir, entry.name);
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      if (text.trim() === '') continue;

      const { description, body } = parseCommand(text.slice(0, MAX_CHARS));
      commands.set(name, { name, description, body, file });
    }
  }
  return commands;
}

// `$ARGUMENTS` is whatever followed the command name. A command that does not
// mention it gets the arguments appended, so `/review src/a.js` does something
// sensible without the file having anticipated it.
export function expand(command, args) {
  const trimmed = args.trim();
  if (command.body.includes('$ARGUMENTS')) {
    return command.body.split('$ARGUMENTS').join(trimmed);
  }
  return trimmed === '' ? command.body : `${command.body}\n\n${trimmed}`;
}
