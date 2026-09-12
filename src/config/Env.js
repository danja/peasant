// Reading .env, without dotenv.
//
// Thirty lines of parsing is cheaper than a dependency, and a dependency that
// reads secrets is the last one worth taking on trust.
//
// Two rules from CLAUDE.md apply directly here:
//
//   - A real environment variable wins over anything read from a file. An
//     exported key is a deliberate act; a file is a default.
//   - No inline fallbacks. A malformed line is an error to fix, not a line to
//     skip quietly -- a silently dropped key looks exactly like a missing
//     account, and costs an hour to tell apart.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

// Returns { key: value } in file order. Throws on a line it cannot parse,
// naming the line number, because the alternative is a key that vanishes.
export function parse(text, source = '.env') {
  const out = {};
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;

    const m = LINE.exec(raw);
    if (!m) {
      throw new Error(`${source}:${i + 1}: cannot parse as NAME=value: ${truncate(raw)}`);
    }

    const [, name, rhs] = m;
    out[name] = unquote(rhs, source, i + 1);
  }
  return out;
}

function unquote(rhs, source, line) {
  if (rhs === '') return '';

  const q = rhs[0];
  if (q === '"' || q === "'") {
    const end = findClosing(rhs, q);
    if (end === -1) throw new Error(`${source}:${line}: unterminated ${q} quote`);
    const body = rhs.slice(1, end);
    const trailing = rhs.slice(end + 1).trim();
    if (trailing !== '' && !trailing.startsWith('#')) {
      throw new Error(`${source}:${line}: unexpected text after closing quote: ${truncate(trailing)}`);
    }
    // Escapes are honoured inside double quotes only, as in POSIX shells.
    return q === '"' ? body.replace(/\\([nrt"\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' }[c])) : body;
  }

  // Unquoted: an unescaped # begins a comment, as every other .env reader does.
  const hash = rhs.search(/(?:^|\s)#/);
  return (hash === -1 ? rhs : rhs.slice(0, hash)).trim();
}

function findClosing(s, q) {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\' && q === '"') { i++; continue; }
    if (s[i] === q) return i;
  }
  return -1;
}

function truncate(s) {
  const t = s.trim();
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

// Reads a .env file if it exists. A missing file is not an error -- every
// setting has an environment-variable form and none is mandatory here. An
// unreadable or malformed file *is* an error.
export function read(file = '.env') {
  if (!fs.existsSync(file)) return {};
  return parse(fs.readFileSync(file, 'utf8'), file);
}

// Where configuration is looked for, in increasing precedence.
//
// The user-level file matters more than it looks: the working directory is the
// *workspace* -- somebody's project -- and their API keys belong with peasant,
// not copied into every repository they point it at. Reading only ./.env meant
// peasant worked in its own directory and nowhere else.
//
// A project-level .env still wins, so a repository can pin a provider or a
// model for work done in it, and a real environment variable beats both.
export function configFiles({ env = process.env, cwd = process.cwd(), home = os.homedir() } = {}) {
  const userDir = env.PEASANT_HOME
    ? expandHome(env.PEASANT_HOME, home)
    : path.join(env.XDG_CONFIG_HOME ? expandHome(env.XDG_CONFIG_HOME, home) : path.join(home, '.config'), 'peasant');

  return [
    path.join(userDir, '.env'),
    path.join(home, '.peasant', '.env'),
    path.join(cwd, '.env'),
  ];
}

function expandHome(p, home) {
  return p.startsWith('~') ? path.join(home, p.slice(1)) : p;
}

// Merges every config file under the real environment, which always wins.
// Returns a plain object rather than mutating process.env, so a caller can see
// exactly what came from where and tests do not leak into each other.
//
// A file that will not parse is reported and skipped, not fatal. That is a
// deliberate exception to "no inline fallbacks", and the reason is whose file it
// is: `./.env` in a working directory usually belongs to the *project being
// worked on*, not to peasant. It is full of shell that peasant has no business
// understanding -- `export FOO`, multi-line values, command substitution -- and
// refusing to start because somebody else's environment file is not in our
// dialect throws away perfectly good keys from ~/.config/peasant/.env for no
// reason. Peasant ran into exactly that.
//
// The principle was always "named, not silently skipped". Naming it is the part
// that matters; being fatal was never the point.
export function load({ files = null, env = process.env, cwd = process.cwd(), home = os.homedir() } = {}) {
  const paths = files ?? configFiles({ env, cwd, home });
  const merged = {};
  const sources = {};
  const problems = [];

  for (const file of paths) {
    let values;
    try {
      values = read(file);
    } catch (e) {
      problems.push(`${e.message} — that file was skipped`);
      continue;
    }
    for (const [k, v] of Object.entries(values)) {
      merged[k] = v;
      sources[k] = file;
    }
  }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== '') { merged[k] = v; sources[k] = 'environment'; }
  }

  Object.defineProperty(merged, Symbol.for('peasant.sources'), { value: sources, enumerable: false });
  Object.defineProperty(merged, Symbol.for('peasant.problems'), { value: problems, enumerable: false });
  return merged;
}

// Files that could not be read, for the caller to report. Empty is the usual
// answer; a non-empty one is worth a line of output, not a crash.
export function problemsOf(values) {
  return values[Symbol.for('peasant.problems')] ?? [];
}

// Where each setting came from -- for `peasant doctor`, because "it works in
// one directory and not another" is otherwise a long afternoon.
export function sourceOf(values, name) {
  return values[Symbol.for('peasant.sources')]?.[name] ?? null;
}

// No inline fallbacks: ask for something absent and you get an error naming it,
// not an empty string that fails later somewhere less obvious.
export function require_(values, name) {
  const v = values[name];
  if (v === undefined || v === '') {
    throw new Error(`${name} is not set. Add it to .env (see example.env) or export it.`);
  }
  return v;
}

// Keys must never reach a log, a fixture or a terminal. Everything that prints
// provider traffic goes through this.
export function redact(text, values) {
  const secrets = Object.entries(values)
    .filter(([k, v]) => /(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/.test(k) && typeof v === 'string' && v.length >= 8)
    .map(([, v]) => v)
    .sort((a, b) => b.length - a.length); // longest first, so a prefix cannot mask a longer key

  let out = String(text);
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  return out;
}
