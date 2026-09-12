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

## Next

`node bin/probe-runtime.js` on the target. Then Phase 1: `SseParser`,
`OpenAICompatClient`, `ToolCallAssembler`, profiles for Groq and Mistral,
`RateLimiter`, `Router`, and the local fake provider the later suites need.
