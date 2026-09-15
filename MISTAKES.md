# Mistakes

Newest first. What happened, the root cause, and what now prevents it.

## 2026-09-15 — Gemini's `thought_signature` was captured on day one and read by nothing

**What happened.** A tool-using session against Google fails on its second turn
with `400 INVALID_ARGUMENT`:

```
Function call is missing a thought_signature in functionCall parts. This is
required for tools to work correctly ... function call `default_api:read`,
position 2.
```

Reported by the user as an intermittent 400 after switching models to dodge a
503. It is not intermittent: `peasant ask` has no tools and always works,
`peasant run` has tools and always fails on the turn that returns a tool result.
"Sometimes" was the difference between two commands, not two attempts.

**Root cause.** Gemini 3.x attaches an opaque `thought_signature` to every
function call and requires it back unchanged. It arrives *on the tool call*, as
`extra_content.google.thought_signature`. peasant discards it twice:
`ToolCallAssembler.push()` reads only `id`, `type`, `function.name` and
`function.arguments`, and `Conversation.assistant()` then rebuilds the message
from `{id, type, function}`. Either alone would lose it.

**The part worth remembering.** The proof was already in the repository. The
first line of `docs/raw/2026-09-12_providers/google-tools.sse` — captured,
committed and read by the test suite ever since — contains the signature in
full. Five tests run against that file on every `npm test` — three in
`sse-parser.test.js`, which parses it and asserts the events round-trip, and two
in `tool-call-assembler.test.js`, which asserts the arguments survive assembly.
Not one of them looks at a field it was not already expecting, so a capture can
carry a mandatory field for three days while the suite is green.

A recorded response is evidence of what the provider *sends*, and the tests only
ever asked whether we could read the parts we already knew about. **Nothing
compares a capture against what we consume**, so anything a provider adds is
invisible until it becomes mandatory.

**Why the probe could not catch it either.** `bin/probe-providers.js` sends one
request and reads the answer. It contains no `role: 'tool'` message at all — it
proves a tool call *arrives*, and has never once proved a conversation can
continue past one. The whole failure lives in turn two, and nothing in the
project has ever exercised turn two against a real provider.

**Prevention.** All three built the same day. `ToolCallAssembler` collects every
field it does not interpret into `extra`; `Conversation.assistant()` spreads it
back onto the outgoing message, before `id`/`type`/`function` so a provider
field cannot overwrite them; and `probe-providers.js` now answers its own tool
call, so `docs/raw/` gains a `<provider>-turn2.sse` and a second turn finally
exists to test against.

The test that matters is in `tests/unit/provider-extras.test.js`: it walks every
tool capture on disk, assembles each call, builds the message peasant would send
next, and fails if any provider field went missing in between. That is the
general form of the bug rather than this instance of it, and it would have
failed on 2026-09-12.

**The rule, stated once:** an opaque field a provider attached to a tool call
belongs to the provider and goes back untouched. Reasoning is the deliberate
exception, because that one is ours to drop — it is our own cost, no provider
requires it echoed, and it is most of the token bill.

## 2026-09-15 — A single-provider probe blanked the test suite's evidence

**What happened.** `node bin/probe-providers.js --only nvidia` wrote a fresh
`docs/raw/2026-09-15_providers/` containing two NVIDIA captures. Four unrelated
tests in `client.test.js` and `tool-call-assembler.test.js` immediately failed,
one of them with a bare `ENOENT` on `mistral-stream.sse` — a file that had not
been touched and was still sitting on disk in the September 12th directory.

**Root cause.** `tests/unit/lib/fixtures.js` resolved captures by *directory*:

```js
// Newest capture directory wins, so adding a fresh probe run updates the tests.
return path.join(RAW, dirs[dirs.length - 1]);
```

The comment's intent is right — re-probing should update the tests rather than
leave them asserting against a shape no provider produces any more. The
implementation assumed every probe run covers every provider. `--only` exists
precisely so that it does not, and the two facts lived in files that had no
connection to each other: the probe grew a flag, the loader never heard.

The failure message points away from the cause. It names a missing Mistral
fixture, so it reads as a problem with Mistral, with the September 12th
directory, or with `.gitignore` excluding a fixture — the last of which CLAUDE.md
explicitly warns about. None of the three had anything to do with it, and the
file it named had not been touched.

**Prevention.** The loader now indexes every capture directory by *filename*,
newest run of each file winning, so a run that did not ask about Mistral says
nothing about Mistral. `tests/unit/fixtures.test.js` is new and asserts the
property directly: every `.sse` on disk is visible to the loader, and at least
two providers are represented. Previously this was only testable by noticing
four other tests break for a reason that pointed elsewhere.

**The general shape**, and it is the one CLAUDE.md names: a rule of the form
"the newest X wins" is safe only when every X covers the same ground. `--only`
made the runs uneven and nothing complained. Added as a row to the recurring
failure table.

## 2026-09-15 — The permission prompt echoed every keypress twice

**What happened.** Answering `allow? [y]es / [n]o / [a]lways:` with `y` printed
`yy`. Reported by the user; nothing in the suite covered it, because nothing in
the suite covered `Prompt.ask` at all.

**Root cause.** Not the question and not the answer — *where* it was asked.
`Prompt.#question` opened its own readline interface on `process.stdin`:

```js
const rl = readline.createInterface({ input: this.#input, output: process.stdout, terminal: true });
```

The REPL's interface owns the terminal for the whole session and is **still
attached while a turn is running**, which is exactly when permission is asked.
Two interfaces on one stdin means two keypress listeners, and both echo.
Measured:

```
before          data=0 keypress=0
one interface   data=1 keypress=1
two interfaces  data=1 keypress=2    <- both echo
after closing   data=1 keypress=0
```

Note `data` goes to one and stays there for the life of the stream, because
`emitKeypressEvents` never removes it. Only `keypress` moves, so only `keypress`
can be asserted on — a test written against the obvious count would have failed
for a reason that was not the bug.

**Prevention.** The prompt stopped using readline at all. It reads one keypress
from the raw stream with readline's keypress listeners detached for the
duration and restored afterwards, so there is no second interface to be a second
listener.

The first fix was narrower — lending the prompt the REPL's own interface — and
it worked, but it was replaced within the hour when the prompt became
single-keypress, and the replacement turned up a **second** bug the first
approach would have left in place. Pausing readline (`rl.pause()`), the obvious
way to get it out of the way, does not stop it handling the key: it echoed the
answer *and* kept it in its line buffer, so answering `y` turned the user's next
input `second` into `secondy`. Detaching is the only one of the three
approaches that leaves the next line clean. Measured:

| approach | echo | next line |
|---|---|---|
| second interface | `yy` | clean |
| `rl.pause()` | `y` | **`secondy`** |
| detach listeners | none (we write it) | clean |

`tests/unit/permission-prompt.test.js` covers the path that had none: that a
keypress listener already on stdin never sees the answer, that the listeners are
restored exactly as found, that raw mode is put back, and that a key meaning
nothing is ignored rather than taken as a refusal.

**What would have caught it earlier.** Any test of `ask()`. The prompt was
written, reviewed and shipped without one because it needs a TTY, and the
reflex was to leave it alone rather than reach for a pty. An A/B under `script`
took two minutes once attempted.

## 2026-09-15 — Wrote "read off a real response" above header names I had guessed

**What happened.** Writing the `anthropic` profile I filled in a `rateLimit`
block of six `anthropic-ratelimit-*` header names from memory and captioned it:

```js
// Header names read off a real response; see docs/providers.md.
```

No response had been read. The caption was written in the same keystrokes as the
guess. The comment under it then described the reset format as "RFC 3339
timestamps" while the field said `resetFormat: 'epoch-seconds'` — two
descriptions of a thing I had not looked at, disagreeing with each other, which
is what finally made me stop.

**Root cause.** Exactly what CLAUDE.md means by "prose is a claim, and nothing
tests sentences". A profile's header names are the one thing in it that cannot
be guessed — `RateLimiter` would watch for headers that never arrive and report
a budget nobody measured — and the caption made the guess look sourced.

**Prevention.** Measured instead: **no `*-ratelimit-*` header appeared on any
response obtained**, so the profile now names none and says why, and the budget
is discovered from 429s as it is for five of the six hosted providers. Caught in
the same session, before the profile was registered, and only because the two
sentences contradicted each other. Nothing structural would have caught it — a
plausible header name that is simply wrong looks exactly like a correct one, and
the failure is silent.

## 2026-09-15 — A field renamed in one file, still read by name in another

**What happened.** Adding the Anthropic Messages format meant a new profile
field for the format's version. It was written as `anthropicVersion` in
`dialects/messages.js` and, minutes later, declared as `apiVersion` in
`profiles/generic.js` — the better name, because the field is not Anthropic's.
The declaration was renamed; the reader was not.

```js
headers: (ctx) => ({ 'anthropic-version': ctx.profile.anthropicVersion }),
```

The header went out as the string `undefined`. Nothing failed locally, because
nothing local checks a header value.

**Root cause.** Exactly the failure CLAUDE.md's recurring-failure table is for:
two files that had to agree, with nothing structural connecting them. Renaming a
field is a two-file change that looks like a one-file change.

**Prevention.** Caught by `tests/unit/dialects.test.js`, which asserts the
version header actually arrives at the fake server — written in the same session
but, importantly, written *before* the code was trusted rather than after it
broke. The dialect now also throws when a profile using that format declares no
version, so the value can be absent in exactly one place and it says so by name.
The row is in CLAUDE.md's table.

**What would have caught it earlier.** Nothing, and that is the point: a guard
that greps for reads of undeclared profile fields would be the structural fix,
and is worth writing if this happens a second time.

## 2026-09-12 — A fixed delay standing in for a real signal

**What happened.** `StdioTransport.start()` waited fifty milliseconds after
spawning an MCP server and then assumed it had started:

```js
setTimeout(() => { this.#child.off('error', onError); resolve(); }, 50);
```

**Root cause.** A race written in both directions. On a loaded machine fifty
milliseconds is not enough and a failed spawn would be reported as a working
connection; on an idle one it is pure waiting, once per server, every run.
`child_process` emits `spawn` when the process is running and `error` when it
could not start, which is exactly the question being asked.

Found while looking at why the test suite had slowed, not by a failing test.
Nothing would have caught it: the wrong behaviour is intermittent and the
slowness is invisible until someone measures.

**Prevention.** It now waits for `spawn` or `error`, whichever arrives. There is
no timer left to be wrong.

## 2026-09-12 — Stuck repeating "no provider can serve a request of about 9057 tokens"

**What happened.** A session reached a conversation larger than the only
available provider's budget, reported it, and reproduced the same error on every
retry. Forever. There was no way out except restarting.

**Root cause.** `Compactor.compact()` returned early whenever `older` was empty:

```js
if (older.length === 0) return { compacted: false, quiet: true, ... };
```

Three file reads make a conversation that does not fit, and `ContextBudget.split`
keeps the last six messages, so `older` is empty and there is no transcript to
summarise. The mechanical fallback -- elide tool results, then drop oldest --
was written for exactly this and sat behind that early return, never reached.
The Loop saw "quiet", said nothing, sent the oversized request anyway, and the
router refused it.

"Nothing old enough to summarise" is not the same as "nothing to do". I had
conflated the *method* with the *need*.

**Prevention.** The early return now happens only when the conversation actually
fits. Otherwise it goes mechanical with `older` empty, which reduces a
four-message conversation from 13,378 tokens to 138. Stage one also elides tool
results across the whole conversation rather than only the older part: the
message that makes a conversation unsendable is usually the one just read, and
refusing to touch it for being recent left nothing to do.
`tests/unit/context-budget.test.js` pins the empty-`older` case by name.

**Also.** When it does happen the session now says what would change it --
`/compact`, `/clear`, or a provider with more headroom -- rather than only
stating the arithmetic.

## 2026-09-12 — An empty placeholder erased a real key

**What happened.** Found while diagnosing the above. A later configuration file
assigning `GROQ_API_KEY=` blanked a perfectly good key from `~/.config/peasant/.env`.

**Root cause.** `load()` skipped empty values from the *environment* but not
from *files*. In a `.env`, "fill this in" and "unset this" look identical, and
only one of them is ever meant.

This is a trap of my own making: `example.env` ships with every key empty, and
the README tells people to copy it. Copying it to a project directory rather
than to `~/.config/peasant/` silently disables every provider, which reads
exactly like "peasant cannot see my keys".

**Prevention.** A later file may override a value; it may not erase one. An
empty value still registers a key nothing else has set, so "no account yet" stays
distinguishable from "the name is misspelt". Both directions are tested.

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
