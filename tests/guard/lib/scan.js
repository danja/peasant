// Source scanning shared by the guard tests.
//
// These functions scrape source text, and a scraper that goes wrong goes blind
// rather than red -- so scanner.test.js pins their behaviour against fixtures.
// Do not change one without the other.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(fileURLToPath(import.meta.url), '../../../..');

// Directories whose contents ship to a user's machine. Anything here is bound
// by the zero-dependency and no-native rules; tests/ and docs/ are not.
export const SHIPPED_DIRS = ['bin', 'src'];

export function listFiles(dirs = SHIPPED_DIRS, exts = ['.js', '.mjs', '.cjs']) {
  const out = [];
  for (const dir of dirs) {
    const root = path.join(REPO, dir);
    if (!fs.existsSync(root)) continue;
    walk(root, out);
  }
  return exts ? out.filter((f) => exts.includes(path.extname(f))) : out;
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
}

// One pass that answers both questions the guards need:
//
//   clean   -- source with comment bodies blanked to spaces, same length and
//              line count, string literals left intact (the specifiers live
//              inside them, so blanking strings would destroy what we read).
//   strings -- the content range of every string literal, so a match can be
//              tested for being *inside* one. Strings do not nest, so every
//              range recorded here is top level.
//
// Regular expression literals are recognised too, and must be: a quote or a
// backtick inside a character class would otherwise open a string that never
// closes and swallow the rest of the file. That happened -- a regex containing
// a backtick made every comment after it survive the strip, and the provider
// guard reported a name that was only ever in prose.
//
// Telling a regex from a division is genuinely ambiguous in JavaScript, so this
// uses the usual heuristic: a `/` begins a regex when the last meaningful
// character before it is one after which a value cannot appear.
//
// Template literals are treated as opaque strings: a `${}` hole containing an
// import is not seen. That is a deliberate limit, not an oversight -- it would
// need a real parser, and an import inside an interpolation is not a thing this
// codebase does.
export function scanSource(src) {
  let clean = '';
  const strings = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i], d = src[i + 1];

    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { clean += ' '; i++; }
      continue;
    }

    if (c === '/' && d === '*') {
      clean += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        clean += src[i] === '\n' ? '\n' : ' '; i++;
      }
      if (i < n) { clean += '  '; i += 2; }
      continue;
    }

    if (c === '/' && startsRegex(clean)) {
      clean += c; i++;
      let inClass = false;
      while (i < n) {
        const r = src[i];
        if (r === '\\') { clean += src.slice(i, i + 2); i += 2; continue; }
        if (r === '\n') break; // unterminated; bail rather than eat the file
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
        clean += r; i++;
      }
      if (i < n && src[i] === '/') { clean += '/'; i++; }
      // Flags.
      while (i < n && /[a-z]/.test(src[i])) { clean += src[i]; i++; }
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      clean += c; i++;
      const start = i;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { clean += src.slice(i, i + 2); i += 2; continue; }
        clean += src[i]; i++;
      }
      strings.push({ start, end: i });
      if (i < n) { clean += quote; i++; }
      continue;
    }

    clean += c; i++;
  }

  return { clean, strings };
}

// A `/` starts a regex when a value cannot legally precede it. Anything else --
// an identifier, a number, a closing bracket -- means division.
const BEFORE_REGEX = /[(,=:[!&|?{};+\-*%^~<>]$/;
const KEYWORD_BEFORE_REGEX = /\b(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;

function startsRegex(before) {
  const trimmed = before.replace(/\s+$/, '');
  if (trimmed === '') return true;
  return BEFORE_REGEX.test(trimmed) || KEYWORD_BEFORE_REGEX.test(trimmed);
}

const SPECIFIER = String.raw`['"]([^'"\n]*)['"]`;
const PATTERNS = [
  new RegExp(String.raw`\bimport\s[\s\S]*?\sfrom\s*${SPECIFIER}`, 'g'),
  new RegExp(String.raw`\bexport\s[\s\S]*?\sfrom\s*${SPECIFIER}`, 'g'),
  new RegExp(String.raw`\bimport\s*${SPECIFIER}`, 'g'),
  new RegExp(String.raw`\bimport\s*\(\s*${SPECIFIER}`, 'g'),
  new RegExp(String.raw`\brequire\s*\(\s*${SPECIFIER}`, 'g'),
];

// Returns the raw import specifiers of a module, deduplicated, in no particular
// order. A statement that begins inside a string literal is prose about code,
// not code, and is ignored.
export function extractImports(src) {
  const { clean, strings } = scanSource(src);
  const inString = (pos) => strings.some((s) => pos >= s.start && pos < s.end);
  const found = new Set();

  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clean)) !== null) {
      if (m[1] && !inString(m.index)) found.add(m[1]);
    }
  }
  return [...found];
}

// A specifier is permitted if it is a Node builtin under the node: prefix, or a
// path relative to the importing file. Bare specifiers mean a dependency.
export function isPermitted(spec) {
  return spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../');
}
