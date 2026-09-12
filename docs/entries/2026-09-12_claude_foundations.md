# Claude : foundations, and what the target machine turned out to be

## The question that shaped the day

`docs/plan-starter.md` asks for a coding harness that runs on an Athlon II
because "OpenCode etc crash on this". Before designing anything it was worth
knowing *why* they crash, because the answer decides whether Node is a viable
base at all.

It is Bun. Bun's `x64-baseline` build still requires SSE4.2
([oven-sh/bun#14745](https://github.com/oven-sh/bun/issues/14745)), and OpenCode
and current Claude Code both ship as Bun-compiled binaries. Claude Code
[#85571](https://github.com/anthropics/claude-code/issues/85571) is the
controlled experiment: on a pre-SSE4.2 Xeon the Bun binary dies with `SIGILL`
while the last pre-Bun npm release runs fine under plain `node cli.js`.

That is good news, but not a licence to assume Node is safe.
[nodejs/node#48700](https://github.com/nodejs/node/issues/48700) was closed *not
planned* and [#32625](https://github.com/nodejs/node/issues/32625) reports
`SIGILL` on K10-era AMD with **zlib** implicated — a native path no V8 flag can
rescue. So the runtime floor became R1, a blocking gate, and the first code
written was the probe that answers it.

## What the target is

Stage A came back mid-session:

**AMD Athlon II X4 640, x86-64-v1, Ubuntu 26.04, glibc 2.43, 15 GB RAM, Node
v26.8.1 installed and starting.**

Flags: `3dnowprefetch abm cx16 mmx pni popcnt sse sse2 sse4a`. It has `popcnt`
and `cx16` but none of `ssse3`, `sse4_1`, `sse4_2` — so it misses `x86-64-v2` by
three extensions, which is the entire story.

Node 26 *starting* is much better than the worst case the plan allowed for. It is
not yet a verdict: `node --version` touches none of the JIT, zlib, OpenSSL or
WebAssembly paths every reported SIGILL came from. `bin/probe-runtime.js` on the
target is the outstanding item and the only thing blocking Phase 1.

Two incidental findings worth keeping. gcc 15.2 and make are present, so
building Node from source stays available as a fallback. And **ripgrep 15.1.0
runs**, which means Rust binaries built for baseline x86-64 are fine here —
relevant to whether the `grep` tool should use a system `rg` when it finds one.
Recorded as an open decision, not taken.

## The second constraint is the tighter one

Groq's free tier is around 30 RPM / **6,000 TPM** / 14,400 RPD. Six thousand
tokens per minute is less than one generous file read. That makes context
economy a property of the architecture rather than a counter added later, and it
settled two design choices immediately: tool results truncate by construction,
and no rate limit or context window is ever a constant — both are read from
response headers or the model list.

## What was built

The probe first, since it is the gate. Each check runs in **its own child
process**, because a `SIGILL` kills the process and an in-process `try/catch`
cannot report what was fatal; the parent reads the exit signal and names the
culprit. Where a JavaScript check dies on a signal it is retried under
`--no-opt`, `--jitless` and `--jitless --single-threaded`, so the output
distinguishes "Node does not work here" from "Node works here with
`NODE_OPTIONS=--jitless`". Native failures are reported as unrescuable, because
they are. Fourteen checks: startup, JIT, irregexp, zlib, brotli, three OpenSSL
paths, WebAssembly, Atomics, workers, ICU, TLS fetch, readline.

Then Phase 0: `package.json` with no dependencies and no dev dependencies (the
runner is `node:test`, the linter is `node --check`), `CLAUDE.md`,
`src/compat/Preflight.js`, and the standing documents.

And the guards — written before the code they guard, which is when they are
free. Thirty-nine tests: no declared dependencies and no non-`node:` imports; no
`.node`/`.wasm`/ELF/Mach-O by extension *or* magic number; `engines.node` bound
to `docs/runtime-baseline.md`; every `tests/` directory bound to a script that
runs it, with the suites kept disjoint so `npm test` can never spend live quota;
`.gitignore`'s stock `*.log` rule prevented from swallowing a recorded stream
fixture; and `docs/index.md` bound to the directory it indexes.

## Two mistakes, both caught by the guards

The scanner behind the dependency guard blanked string *contents* along with
comments — and import specifiers live inside strings, so it extracted whitespace
instead of module names. Written slightly differently it would have found
nothing and passed forever while the zero-dependency rule went unenforced.
`scanner.test.js` had been written first and caught it on the first run. That is
the whole argument for "a guard that scrapes source needs its own test", and it
paid for itself within the hour.

The other: `node --test <dir>` no longer works on Node 25 — a positional
argument is now a file or glob. An invocation remembered rather than checked, in
a project whose premise is that runtime versions differ in ways that matter.

Both are in `MISTAKES.md`.

Separately, a test asserting that every preflight problem names a remedy failed
on `'Use WSL.'` — technically a remedy, useless as one. The message was fixed
rather than the test.

## The gate, answered

The probes came back the same afternoon, and the answer was better than the best
case the plan allowed for. **Every Node major from 18 to 26 passes all fourteen
checks on the Athlon II.** Not a warning, not a rescuing V8 flag — fourteen for
fourteen, six times over.

Two results are worth naming because they were the specific fears. **zlib
passes**, on every major, so the K10 report in
[nodejs/node#32625](https://github.com/nodejs/node/issues/32625) does not
reproduce — and a native failure would have been the one kind no flag could
rescue. And **AES-256-GCM passes on a CPU with neither `aes` nor `pclmulqdq` in
its flag list**, which says OpenSSL's runtime dispatch here is honest rather than
compiled to assume AES-NI.

The consequence is a simplification, and worth stating plainly so nobody
re-litigates it later: **the ban on Bun is the entire CPU mitigation.** Nothing
else in the codebase has to bend for this processor. The zero-dependency and
no-native rules still earn their place — they are what stop a *future* dependency
dragging an `x86-64-v2` blob in — but the day-to-day code can be written without
thinking about 2010 silicon at all.

So the floor is not set by what survives, since everything survives. It is set by
Node's own support schedule. Against today, 2026-09-12: v18 died 2025-04-30, v20
died 2026-04-30, v22 runs to 2027-04-30. **`>=22.0.0`** — the oldest line still
getting security fixes, and it brings `fs.glob`, a stable `node:test` and the
`--test` glob patterns the npm scripts already use. The target runs v26.8.1, so
it costs nothing there.

`docs/runtime-baseline.md` went to `MEASURED`, then `package.json` followed — in
that order, because `engines.test.js` binds them and the document is where a
measurement lands. Raw output is in `docs/raw/2026-09-12_probe/`.

There was also a false start: the first "results" pasted back were Stage A again,
byte-identical to what was already recorded. The cause was mine — I asked for
`node bin/probe-runtime.js` on a machine that had never seen the file, since it
was untracked in a checkout on a different box. Worth remembering when asking
anyone to run something: check that they have it.

## R2, and what the providers actually said

Keys arrived for Groq and Mistral, so `bin/probe-providers.js` got written and
run. Eight requests, trivial prompts. The findings were worth more than the
quota.

**The published free-tier numbers were wrong in both directions.** Groq reports
`x-ratelimit-limit-tokens: 8000`, not the 6,000 every summary quotes. Mistral
reports **625,000** tokens/minute and 125 requests/minute — seventy-eight times
Groq's headroom, where the write-ups had said only "roughly 1 req/s". That is a
large enough gap to change which provider should be tried first, and
`example.env` now leads with Mistral on those grounds. The rule that no rate
limit is ever a constant was written before any of this was known, for exactly
this reason; it earned its place on first contact.

**The two providers share a header prefix and agree on nothing else.** Groq says
`x-ratelimit-limit-tokens`, Mistral says `x-ratelimit-limit-tokens-minute`. Groq
expresses reset as a duration string — `1m26.4s`, `644ms` — which needs a parser.
Mistral publishes no reset at all, so its window has to be inferred from the
header *name*. Mistral alone reports what a query cost. This is the entire
justification for `src/provider/profiles/`, arriving before a line of the
provider core was written.

**Tool calls came back whole.** Both returned id, name and complete argument JSON
in a single streamed delta at `index: 0`, not dribbled across many as the OpenAI
API does, and both parsed as valid JSON first time. `ToolCallAssembler` still has
to handle the incremental case — other providers do it, and longer arguments
surely will — but the whole-in-one-delta case now has real bytes behind it rather
than an imagined fixture.

**And Groq's `gpt-oss-20b` streams a non-standard `reasoning` field** with
`channel: "analysis"`, separate from `content`. Rendering it would print the
model's private working to the user. Worse for our purposes, it still costs:
the probe's 24-token completion was **22 reasoning tokens**. On an 8,000 TPM
budget a reasoning model spends nearly all of the allowance on text nobody sees,
and a budgeter counting only visible output would be wrong by an order of
magnitude.

One correction fell out of this. `CLAUDE.md` had stated the 6,000 TPM figure as
specification rather than as something read on a website. `docs/plan.md` had
labelled it correctly as published-not-measured; `CLAUDE.md` dropped the
qualifier, and the qualifier was the whole point. Logged in `MISTAKES.md`, and
every figure in those files now carries its source and date.

Incidentally, the catalogues do not match the write-ups either: Groq lists 14
models and neither Kimi K2 nor Qwen3-Coder is among them. Mistral lists 46,
including `mistral-vibe-cli-with-tools` and `mistral-code-latest` — models
apparently built for this exact job, and worth evaluating before a default is
settled.

## Phase 1

Built in the order the risk sat: `SseParser` first, because incremental SSE
decoding across arbitrary chunk boundaries is the most bug-prone thing here and
there were now real bytes to test it against. Its tests replay every capture at
every chunk size from 1 to 64 and assert the result is identical — plus a
multi-byte character split mid-sequence, which is the bug that would otherwise
corrupt someone's source code silently.

Then `ToolCallAssembler`, `RateLimiter`, `OpenAICompatClient`, `Router`, the
profiles, a local fake provider on `node:http`, and `Terminal`/`Ansi` with the
guard that keeps stdout in one place. `peasant ask` streams from a free tier and
reports provider, model and usage. 201 tests.

### Two more keys, and what they exposed

Cerebras and OpenRouter keys appeared mid-session, and re-probing was worth far
more than the eight requests it cost.

**OpenRouter streams tool calls incrementally** — id and name in the first delta
with `arguments: ""`, the arguments in a second. That is the OpenAI shape, and
the opposite of the whole-in-one-delta shape Groq and Mistral use. The assembler
had been written to handle both on the argument that the incremental form is a
superset and special-casing the easy one is how a harness breaks on its third
provider. Getting a third provider the same afternoon, and having it take the
untested path correctly, was luckier than it deserved. There is now a test
asserting *both* shapes remain represented in the captures, so half the
assembler cannot quietly become untested.

**Cerebras returns 402 on every completion** — "Visit your billing tab" — while
`/models` answers fine. That exposed a real bug: 402 was classified as a bad
request, so the router refused to rotate and one account's billing problem would
have taken down every session. The fix distinguishes *our request is wrong*
(400: everyone will say so, do not rotate) from *this provider will not serve
us* (401/402/403: rotate, and retire it for the session rather than paying the
latency of a refusal every turn). Verified live:
`PEASANT_PROVIDERS=cerebras,groq peasant ask ...` is answered by Groq, with the
reason shown rather than swallowed.

**Mistral returned the 429 we had not been able to observe**, and it carried
`x-ratelimit-limit-req-minute: 0` — having reported 125 that morning. A second
bug: a limit of zero was read as "smaller than the request, therefore
impossible forever", which would have dropped the provider permanently over a
momentary condition. Zero means exhausted now; only a non-zero limit smaller
than the request is impossible.

Both bugs were in code that passed every test I had written. Neither would have
been found without live keys, and neither is exotic — they are just the two
cases you do not think of until a real provider does them to you.

### The shape of the finding

Three of the four keyed providers publish **no rate-limit headers at all**. Only
Groq says everything; Mistral gives limits without a reset; OpenRouter and
Cerebras say nothing. So *unknown* is the normal state, not the exception, and
the limiter's insistence that `null` means unknown rather than empty turns out
to be load-bearing rather than fastidious.

And reasoning tokens keep being most of the bill: 22 of 24, 39 of 66, and on
OpenRouter 31 reasoning against 24 completion tokens — more reasoning than
output. A budgeter counting visible text would be wrong by an order of
magnitude.

## Next

Phase 2: the agent loop, the tool interface and registry, the file and shell
tools, and the permission policy. `peasant run "<task>"` reading, editing and
running commands to completion.
