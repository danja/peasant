import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCommands, parseCommand, expand, commandDirs } from '../../src/cli/commands.js';

function dirs(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-cmd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('a markdown file becomes a command', (t) => {
  const dir = dirs(t, { 'review.md': '# Review a diff our way\nLook at the diff and comment on it.' });
  const commands = loadCommands({ dirs: [dir] });
  assert.deepEqual([...commands.keys()], ['review']);
  assert.equal(commands.get('review').description, 'Review a diff our way');
  assert.equal(commands.get('review').body, 'Look at the diff and comment on it.');
});

test('a file with no heading still works', (t) => {
  const dir = dirs(t, { 'quick.md': 'Just do the thing.' });
  const command = loadCommands({ dirs: [dir] }).get('quick');
  assert.equal(command.description, null);
  assert.equal(command.body, 'Just do the thing.');
});

test('the project overrides the personal one by name', (t) => {
  // So a repository can specialise a command without disabling it everywhere.
  const user = dirs(t, { 'review.md': 'the general one' });
  const project = dirs(t, { 'review.md': 'the specific one' });
  const commands = loadCommands({ dirs: [user, project] });
  assert.equal(commands.get('review').body, 'the specific one');
});

test('non-markdown and oddly named files are ignored', (t) => {
  const dir = dirs(t, {
    'fine.md': 'yes', 'notes.txt': 'no', '9bad.md': 'no', 'has space.md': 'no', 'UPPER.md': 'yes',
  });
  assert.deepEqual([...loadCommands({ dirs: [dir] }).keys()].sort(), ['fine', 'upper']);
});

test('an empty file is not a command', (t) => {
  const dir = dirs(t, { 'blank.md': '   \n\n' });
  assert.equal(loadCommands({ dirs: [dir] }).size, 0);
});

test('a missing directory is the normal case', () => {
  assert.equal(loadCommands({ dirs: ['/nowhere/at/all'] }).size, 0);
});

test('$ARGUMENTS is substituted wherever it appears', () => {
  const command = parseCommand('Review $ARGUMENTS carefully, then review $ARGUMENTS again.');
  assert.equal(expand(command, 'src/a.js'), 'Review src/a.js carefully, then review src/a.js again.');
});

test('arguments are appended when the command does not mention them', () => {
  // So `/review src/a.js` does something sensible without the file having
  // anticipated it.
  const command = parseCommand('Review the diff.');
  assert.equal(expand(command, 'src/a.js'), 'Review the diff.\n\nsrc/a.js');
  assert.equal(expand(command, '   '), 'Review the diff.');
});

test('$ARGUMENTS with nothing passed leaves an empty hole, not the literal', () => {
  const command = parseCommand('Look at $ARGUMENTS now.');
  assert.equal(expand(command, ''), 'Look at  now.');
});

test('commands are looked for in the conventional places', () => {
  assert.deepEqual(
    commandDirs({ env: {}, root: '/work', home: '/home/x' }),
    ['/home/x/.config/peasant/commands', '/work/.peasant/commands'],
  );
});
