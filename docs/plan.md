# Plan

What each phase delivers, and what proves it. Status is updated as phases land;
`docs/entries/` carries the worklog.

The two constraints that shape everything are in `CLAUDE.md` under "Why this
project exists". The measured runtime floor is `docs/runtime-baseline.md`.

## Phase R — Research

**R1. Runtime baseline — blocks everything else.** Establish which Node builds
run on the target CPU. `bin/probe-runtime.js` and `bin/probe-node-matrix.sh`
exist for this. Record in `docs/runtime-baseline.md` and flip its
`baseline:status` marker from `PENDING` to `MEASURED`.
**Status: tooling shipped, measurement outstanding — needs the target machine.**

**R2. Free-tier landscape.** `bin/probe-providers.js` calls each provider with a
key present and dumps every response header, so the rate-limit header names,
tool-calling fidelity, streaming tool-call shape, `stream_options.include_usage`
support and 429 body are recorded rather than assumed.

**R3. Tool-calling dialects.** The OpenAI shape is a family, not a standard.
Catalogue the differences with a fixture per case; each becomes a field in a
provider profile, never a branch in the loop.

**R4. Prior art.** OpenCode, Codex CLI, and Claude Code's pre-Bun npm package
(plain readable JS). Context compaction, permission prompts, and file editing
strategy. Write up `docs/prior-art.md` with what we do differently and why.

**R5. Terminal capabilities on the target.** `TERM`, colour depth, unicode
width, raw mode. Raw ANSI means we own this.

**R6. Token estimation without tiktoken.** A pure-JS heuristic calibrated
against `usage` returned by the APIs, with its error measured. The budgeter must
be conservative and must know how wrong it is.

## Phase 0 — Foundations — **complete**

`package.json` with no dependencies; `CLAUDE.md`; the standing documents;
`src/compat/Preflight.js`; and the guard tests, written before the code they
guard so they cost nothing:

- `no-runtime-deps` — no declared dependencies, and shipped code imports only
  `node:*` and relative paths
- `no-native` — no `.node`/`.wasm`/ELF/Mach-O by extension *or* magic number, no
  install hooks, no `binding.gyp`
- `engines` — `package.json` agrees with `docs/runtime-baseline.md`
- `suite-coverage` — every `tests/` directory is run by a script, the suites are
  disjoint, and `npm test` never touches `tests/live`
- `gitignore` — the stock `*.log` rule cannot swallow a recorded stream fixture
- `scanner` — the scraper the guards rely on still scrapes

## Phase 1 — Provider core

`SseParser`, `OpenAICompatClient`, `ToolCallAssembler`, `ProfileRegistry` with
profiles for Groq and Mistral, `RateLimiter`, `Router`, and the local fake
OpenAI-compatible server used by every later suite.

**Deliverable:** `peasant ask "..."` streams a completion from a free tier,
respects the rate limit it read from the response headers, and fails over to the
next configured provider on 429.

## Phase 2 — Agent loop and tools

`Loop`, `Conversation`, the `Tool` interface and registry, the file and shell
tools, `Policy` and the approval prompt.

**Deliverable:** `peasant run "<task>"` non-interactively reads, edits and runs
commands to completion.

## Phase 3 — Terminal UI

`Ansi`, `Terminal`, `Repl`, `Render`, `Diff`.

**Deliverable:** the interactive session — streamed output, history, multiline
input, and a Ctrl-C that cancels the in-flight request rather than the process.

## Phase 4 — Context economy

`TokenEstimator` calibrated against real `usage`, `ContextBudget`, `Compactor`,
tool-result truncation, `session/Store` with resume and fork.

**Deliverable:** a long session that survives a 6,000 TPM budget, with tokens
used, turns and wall time recorded in `docs/entries/` — measured, not asserted.

## Phase 5 — Extensibility

MCP stdio client, custom slash commands, project-level `PEASANT.md` context
files, the remaining provider profiles.

## Phase 6 — Packaging

npm publish, an install path that assumes nothing about the CPU, and a README
whose every figure was measured.
