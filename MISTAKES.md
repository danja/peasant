# Mistakes

Newest first. What happened, the root cause, and what now prevents it.

## 2026-09-12 — The dependency guard destroyed the text it was meant to read

**What happened.** `tests/guard/lib/scan.js` blanked comment *and* string bodies
to spaces before running the import regexes over the result. Import specifiers
live inside string literals, so the guard extracted `'       '` instead of
`'node:fs'`. Had it been written slightly differently it would have found no
imports at all and passed forever, while the zero-dependency rule quietly went
unenforced.

**Root cause.** Two requirements were conflated into one pass: "ignore text
inside comments" and "ignore statements written inside strings" are different
problems, and blanking strings solves the second by destroying the input to the
first.

**Prevention.** `scanSource()` now returns the comment-blanked source *with
string contents intact*, plus the content range of every string literal; a match
is discarded only if it *begins* inside a range. `tests/guard/scanner.test.js`
was written first and caught this on the first run — which is the point.
`no-runtime-deps.test.js` also asserts the scan looked at a non-zero number of
files, because a guard that silently scans nothing passes forever.

## 2026-09-12 — `node --test <dir>` no longer works

**What happened.** `package.json` declared `"test": "node --test tests/unit/
tests/guard/"`. On Node 25 this fails with `Cannot find module
'/…/tests/guard'`: a positional argument is now treated as a file or glob, not a
directory to walk.

**Root cause.** An invocation remembered from an older Node, not checked against
the one in use — in a project whose entire premise is that runtime versions
differ in ways that matter.

**Prevention.** Scripts use explicit globs (`"tests/guard/**/*.test.js"`). An
empty glob exits 0, so this does not break a suite directory that exists before
its first test. `tests/guard/suite-coverage.test.js` binds every `tests/`
directory to a script that names it, so the arrangement cannot silently rot.
