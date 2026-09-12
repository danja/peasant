import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { byName } from '../../src/tools/registry.js';
import { truncate, ToolError } from '../../src/tools/Tool.js';
import { globToRegExp } from '../../src/tools/glob.js';

// A real temporary workspace. Everything except the provider is tested for
// real -- these tools exist to touch the filesystem, and a mocked filesystem
// would test the mock.
function workspace(t, files = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'peasant-ws-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return { root: dir, ctx: { root: dir } };
}

const run = (name, args, ctx) => byName(name).invoke(args, ctx);

// --- confinement -----------------------------------------------------------

test('refuses to read outside the workspace', async (t) => {
  const { ctx } = workspace(t, { 'a.txt': 'hello' });
  await assert.rejects(() => run('read', { path: '../../etc/passwd' }, ctx), /outside the workspace/);
  await assert.rejects(() => run('read', { path: '/etc/passwd' }, ctx), /outside the workspace/);
});

test('refuses to write outside the workspace', async (t) => {
  const { ctx } = workspace(t);
  await assert.rejects(() => run('write', { path: '../escaped.txt', content: 'x' }, ctx), /outside the workspace/);
});

test('a symlink is not a way out', async (t) => {
  // Resolution happens before the check, so a link and a ../ meet the same test.
  const { root, ctx } = workspace(t);
  fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'));
  await assert.rejects(() => run('ls', { path: 'escape' }, ctx), /outside the workspace/);
});

// --- read ------------------------------------------------------------------

test('read numbers lines and reports the total', async (t) => {
  const { ctx } = workspace(t, { 'a.txt': 'one\ntwo\nthree\n' });
  const out = await run('read', { path: 'a.txt' }, ctx);
  assert.match(out, /a\.txt \(3 lines\)/);
  assert.match(out, /1\tone/);
  assert.match(out, /3\tthree/);
});

test('read pages with offset and limit, and says how to continue', async (t) => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  const { ctx } = workspace(t, { 'big.txt': lines });
  const out = await run('read', { path: 'big.txt', offset: 10, limit: 5 }, ctx);
  assert.match(out, /10\tline 10/);
  assert.match(out, /14\tline 14/);
  assert.ok(!out.includes('line 15'));
  assert.match(out, /read again with offset 15/);
});

test('read refuses a directory and a binary file', async (t) => {
  const { root, ctx } = workspace(t, { 'sub/x.txt': 'x' });
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
  await assert.rejects(() => run('read', { path: 'sub' }, ctx), /is a directory/);
  await assert.rejects(() => run('read', { path: 'bin.dat' }, ctx), /binary file/);
});

test('read reports an empty file as empty rather than nothing', async (t) => {
  const { ctx } = workspace(t, { 'empty.txt': '' });
  assert.match(await run('read', { path: 'empty.txt' }, ctx), /is empty/);
});

// --- write and edit --------------------------------------------------------

test('write creates intermediate directories', async (t) => {
  // resolveInside has to walk up to the deepest existing ancestor: checking
  // only the immediate parent refused every nested create.
  const { root, ctx } = workspace(t);
  await run('write', { path: 'a/b/c/d.txt', content: 'deep' }, ctx);
  assert.equal(fs.readFileSync(path.join(root, 'a/b/c/d.txt'), 'utf8'), 'deep');
});

test('a symlinked ancestor is still not a way out', async (t) => {
  // Walking up to find an existing ancestor must not skip the containment
  // check on the ancestor that actually exists.
  const { root, ctx } = workspace(t);
  fs.symlinkSync(os.tmpdir(), path.join(root, 'out'));
  await assert.rejects(
    () => run('write', { path: 'out/deep/escaped.txt', content: 'x' }, ctx),
    /outside the workspace/,
  );
});

test('write creates and replaces, and says which', async (t) => {
  const { root, ctx } = workspace(t);
  assert.match(await run('write', { path: 'new/deep.txt', content: 'a\nb' }, ctx), /^wrote /);
  assert.equal(fs.readFileSync(path.join(root, 'new/deep.txt'), 'utf8'), 'a\nb');
  assert.match(await run('write', { path: 'new/deep.txt', content: 'c' }, ctx), /^replaced /);
});

test('edit replaces an exact unique string', async (t) => {
  const { root, ctx } = workspace(t, { 'a.js': 'const a = 1;\nconst b = 2;\n' });
  await run('edit', { path: 'a.js', old: 'const b = 2;', new: 'const b = 3;' }, ctx);
  assert.match(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), /const b = 3;/);
});

test('edit refuses a string that is not there, and says why', async (t) => {
  const { ctx } = workspace(t, { 'a.js': 'const a = 1;\n' });
  await assert.rejects(
    () => run('edit', { path: 'a.js', old: 'const a = 2;', new: 'x' }, ctx),
    /does not appear.*whitespace and indentation must match/s,
  );
});

test('edit refuses an ambiguous string rather than guessing which', async (t) => {
  // The whole safety property of exact-string replacement: not unique means
  // not unique, rather than a diff being forced somewhere plausible.
  const { ctx } = workspace(t, { 'a.js': 'x = 1;\nx = 1;\n' });
  await assert.rejects(
    () => run('edit', { path: 'a.js', old: 'x = 1;', new: 'x = 2;' }, ctx),
    /appears 2 times.*more surrounding context/s,
  );
});

test('edit all replaces every occurrence when asked', async (t) => {
  const { root, ctx } = workspace(t, { 'a.js': 'x = 1;\nx = 1;\n' });
  const out = await run('edit', { path: 'a.js', old: 'x = 1;', new: 'x = 2;', all: true }, ctx);
  assert.match(out, /2 replacements/);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'x = 2;\nx = 2;\n');
});

test('edit refuses a no-op', async (t) => {
  const { ctx } = workspace(t, { 'a.js': 'x\n' });
  await assert.rejects(() => run('edit', { path: 'a.js', old: 'x', new: 'x' }, ctx), /identical/);
});

// --- ls, glob, grep --------------------------------------------------------

test('ls marks directories and flags the ones never searched', async (t) => {
  const { root, ctx } = workspace(t, { 'a.txt': 'x', 'src/b.js': 'y' });
  fs.mkdirSync(path.join(root, 'node_modules'));
  const out = await run('ls', {}, ctx);
  // The count leads: the first line is what a one-line summary shows, and "."
  // says nothing.
  assert.match(out.split('\n')[0], /: \d+ entries/);
  assert.match(out, /src\//);
  assert.match(out, /node_modules\/\s+\(not searched\)/);
  assert.match(out, /a\.txt/);
});

test('glob translates patterns correctly', () => {
  assert.ok(globToRegExp('*.js').test('a.js'));
  assert.ok(!globToRegExp('*.js').test('src/a.js'), '* must not cross a separator');
  assert.ok(globToRegExp('src/**/*.js').test('src/deep/a.js'));
  assert.ok(globToRegExp('src/**/*.js').test('src/a.js'), '** must also match zero directories');
  assert.ok(globToRegExp('a?.js').test('ab.js'));
  assert.ok(!globToRegExp('a.js').test('axjs'), 'a dot must be literal, not any-character');
});

test('glob finds files and skips build directories', async (t) => {
  const { ctx } = workspace(t, {
    'src/a.js': '', 'src/deep/b.js': '', 'README.md': '', 'node_modules/pkg/c.js': '',
  });
  const out = await run('glob', { pattern: '**/*.js' }, ctx);
  assert.match(out, /src\/a\.js/);
  assert.match(out, /src\/deep\/b\.js/);
  assert.ok(!out.includes('node_modules'), 'node_modules must never be walked');
});

test('glob says so when nothing matches', async (t) => {
  const { ctx } = workspace(t, { 'a.txt': '' });
  assert.match(await run('glob', { pattern: '**/*.rs' }, ctx), /no files match/);
});

test('grep returns matching lines, not matching files', async (t) => {
  // A tool answering "it is in these files" costs a second round trip and
  // another read. At 8,000 tokens a minute that is the difference that matters.
  const { ctx } = workspace(t, { 'src/a.js': 'const x = 1;\nconst target = 2;\n' });
  const out = await run('grep', { pattern: 'target' }, ctx);
  assert.match(out, /src\/a\.js:2:const target = 2;/);
});

test('grep honours include and ignoreCase', async (t) => {
  const { ctx } = workspace(t, { 'a.js': 'NEEDLE', 'b.md': 'needle' });
  assert.match(await run('grep', { pattern: 'needle', ignoreCase: true }, ctx), /a\.js/);
  const scoped = await run('grep', { pattern: 'needle', ignoreCase: true, include: '**/*.md' }, ctx);
  assert.match(scoped, /b\.md/);
  assert.ok(!scoped.includes('a.js'));
});

test('grep refuses an invalid regular expression with the reason', async (t) => {
  const { ctx } = workspace(t, { 'a.js': 'x' });
  await assert.rejects(() => run('grep', { pattern: '[' }, ctx), /not a valid regular expression/);
});

// --- bash ------------------------------------------------------------------

test('bash runs in the workspace and returns output', async (t) => {
  const { ctx } = workspace(t, { 'a.txt': 'hello' });
  assert.match(await run('bash', { command: 'cat a.txt' }, ctx), /hello/);
});

test('a non-zero exit is a result, not an exception', async (t) => {
  // A failing test run is exactly what the model needs in order to fix it.
  const { ctx } = workspace(t);
  const out = await run('bash', { command: 'echo oops >&2; exit 3' }, ctx);
  assert.match(out, /stderr:/);
  assert.match(out, /oops/);
  assert.match(out, /\[exit 3\]/);
});

test('bash times out rather than hanging forever', async (t) => {
  // The elapsed assertion is the point. This passed once while taking the full
  // thirty seconds: killing the shell left `sleep` orphaned and still holding
  // the pipes, and `close` waits for stdio EOF. The command now runs in its own
  // process group and the whole group is killed.
  const { ctx } = workspace(t);
  const started = Date.now();
  const out = await run('bash', { command: 'sleep 30', timeoutMs: 1000 }, ctx);
  const elapsed = Date.now() - started;
  assert.match(out, /killed after 1000 ms/);
  assert.ok(elapsed < 5000, `timeout did not actually kill the command: took ${elapsed} ms`);
});

test('a killed command takes its children with it', async (t) => {
  const { ctx } = workspace(t);
  const started = Date.now();
  // A subshell holding the pipe open is the exact shape that broke before.
  await run('bash', { command: '(sleep 30 &) ; sleep 30', timeoutMs: 1000 }, ctx);
  assert.ok(Date.now() - started < 5000, 'a grandchild kept the command alive');
});

test('bash reports no output distinctly from empty output', async (t) => {
  const { ctx } = workspace(t);
  assert.match(await run('bash', { command: 'true' }, ctx), /\[exit 0, no output\]/);
});

// --- result truncation -----------------------------------------------------

test('truncate keeps the head and the tail', () => {
  // The end of a stack trace or a diff is usually where the answer is.
  const s = `START${'x'.repeat(5000)}END`;
  const out = truncate(s, 500);
  assert.ok(out.startsWith('START'));
  assert.ok(out.endsWith('END'));
  assert.match(out, /characters omitted of \d+/);
  assert.ok(out.length < 600);
});

test('truncate leaves a short result alone', () => {
  assert.equal(truncate('short', 500), 'short');
});

test('a tool result is capped, whatever the tool returns', async (t) => {
  const { ctx } = workspace(t, { 'big.txt': 'y'.repeat(100_000) });
  const out = await byName('read').invoke({ path: 'big.txt' }, { ...ctx, maxChars: 2000 });
  assert.ok(out.length <= 2100, `result was ${out.length} characters`);
});

// --- argument validation ---------------------------------------------------

test('invalid arguments are reported as text the model can act on', async (t) => {
  const { ctx } = workspace(t);
  await assert.rejects(() => run('read', { path: 123 }, ctx),
    (e) => e instanceof ToolError && /path must be a string/.test(e.message));
  await assert.rejects(() => run('read', { path: 'a', nonsense: 1 }, ctx),
    /has no parameter "nonsense"/);
  await assert.rejects(() => run('read', {}, ctx), /path is required/);
});

test('declared defaults are filled in', async (t) => {
  const { ctx } = workspace(t, { 'a.txt': 'x' });
  // ls has no required parameters and defaults path to '.'
  assert.match(await run('ls', {}, ctx), /a\.txt/);
});

test('an empty string means the default, where there is one', async (t) => {
  // Observed live: a model sent glob {"path":"","pattern":"greet.js"} meaning
  // "from the top", and lost a turn and a minute of budget to "path must be a
  // non-empty string".
  const { ctx } = workspace(t, { 'greet.js': 'x' });
  assert.match(await run('glob', { pattern: 'greet.js', path: '' }, ctx), /greet\.js/);
  assert.match(await run('ls', { path: '' }, ctx), /greet\.js/);
  assert.match(await run('grep', { pattern: 'x', path: '' }, ctx), /greet\.js/);
});

test('an empty string is kept where no default is declared', async (t) => {
  // edit.new = "" means delete this text, and is entirely meaningful.
  const { root, ctx } = workspace(t, { 'a.js': 'keep\nremove me\n' });
  await run('edit', { path: 'a.js', old: 'remove me\n', new: '' }, ctx);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'keep\n');
});
