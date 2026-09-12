# Mistakes

Newest first. What happened, the root cause, and what now prevents it.

## 2026-09-12 — A documented figure written into the house rules as if it were a fact

**What happened.** `CLAUDE.md` stated, as part of the project's specification,
that "Groq's free tier is roughly 30 RPM / **6,000 TPM** / 14,400 RPD". The
figure came from published summaries and was never measured. On the first run of
`bin/probe-providers.js` the account reported `x-ratelimit-limit-tokens: 8000`,
and Mistral reported **625,000** tokens/minute — 78x Groq, where the same
summaries had described it vaguely as "roughly 1 req/s". Two of the three numbers
that the context-economy design rests on were wrong, and one was wrong by a
factor of 78 in the direction that changes which provider should be tried first.

**Root cause.** A number taken from a search result was repeated in a document
whose whole purpose is to be believed. `docs/plan.md` had correctly labelled
these as published rather than measured; `CLAUDE.md` dropped the qualifier, and
the qualifier was the important part.

**Prevention.** Every figure in the affected files now names its source and its
date, and the provider limits carry `MEASURED 2026-09-12` with
`docs/providers.md` and `docs/raw/2026-09-12_providers/` behind them. The
architectural rule that already existed — never hardcode a rate limit, read it
from `x-ratelimit-*` at runtime — is what kept this from reaching code. It was
written for exactly this reason and it earned its place on the first contact with
a real provider.

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
