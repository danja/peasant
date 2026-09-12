# Mistakes

Newest first. What happened, the root cause, and what now prevents it.

## 2026-09-12 — Somebody else's .env stopped peasant starting

**What happened.** peasant refused to start, reporting that it could not read
the keys, with a raw stack trace. The keys were fine. A `.env` in the working
directory could not be parsed, `load()` threw, and startup died before anything
could report it properly.

Any `.env` written for a normal application does this: `export FOO`, a
multi-line value, command substitution. None of it is peasant's dialect.

**Root cause.** "No inline fallbacks" applied to the wrong file. The rule is
right for *peasant's own* configuration, where a malformed line means a setting
silently missing. It is wrong for a file that belongs to the project being
worked on, which peasant reads opportunistically and has no business
understanding. Whose file it is decides how strict to be about it, and I had not
made that distinction.

The stated principle was always "named, not silently skipped". Naming it is the
part that matters; being fatal was never the point, and `loadServers` for
`mcp.json` had already got this right by collecting problems and continuing.

**Prevention.** `load()` now reports an unreadable file and skips it, keeping
everything the other files provided. `parse()` is still strict, because that is
where the message is useful. The problems are shown at startup and by `peasant
doctor`. Tests in `tests/unit/env.test.js` cover a bad file before and after a
good one.

**Also.** The stack trace appeared because `load()` was called outside the
top-level try in `bin/peasant.js`, so a configuration error was reported as an
internal fault. Moved inside.

## 2026-09-12 — A rate limit surfaced to the user while five providers sat unused

**What happened.** Running peasant on a real repository, a turn failed with a
rate-limit message instead of rotating. Six providers were configured and
rotation was on.

Groq answers a per-minute token overflow with **HTTP 413**, not 429:

```
413  Request too large for model `openai/gpt-oss-20b` ... on tokens per minute
     (TPM): Limit 8000, Requested 13266
```

`classify()` had no case for 413, so it fell through to `bad-request`, whose
whole meaning is "our request is malformed and every provider will say the
same". The router therefore refused to rotate — while Mistral, with 625,000
tokens a minute, was next in line and would have answered without noticing.

**Root cause.** The same one as the Cerebras 402 in Phase 1: a status code
assigned to the wrong bucket because I reasoned about which codes *ought* to
appear rather than observing which ones do. Both were found by running against a
real provider, neither by a test, and both were in code with tests that passed.

**Prevention.** 413 is now its own kind, `too-large`: retryable, because a
bigger provider answers, but not a rate limit, because waiting does not make a
request smaller and the provider deserves no cooldown. `tests/unit/router.test.js`
and `tests/unit/client.test.js` pin both halves.

The 413 response carries `x-ratelimit-*` headers, so one refusal now teaches the
limiter the real budget and an over-sized request is refused before it costs a
round trip. That is tested too.

**Also found while diagnosing it.** `connect()` built a second client from the
same config after listing models, discarding whatever the first had learned.
Groq's `/models` happens to carry no rate-limit headers so nothing was lost
today, but throwing away measured state is a bug whether or not it currently
costs anything. And the comment I first wrote for the fix claimed the limiter
*did* know the budget by that point — a false statement about the system, in a
project whose rules are mostly about not making those. Corrected before it
landed.

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
