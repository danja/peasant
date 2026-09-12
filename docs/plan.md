# Plan

What each phase delivers, and what proves it. Status is updated as phases land;
`docs/entries/` carries the worklog.

The two constraints that shape everything are in `CLAUDE.md` under "Why this
project exists". The measured runtime floor is `docs/runtime-baseline.md`.

## Phase R — Research

**R1. Runtime baseline — complete.** Every Node major from 18 to 26 passes all
fourteen probe checks on the target. The floor is **>=22.0.0**, set by Node's
own support schedule rather than by what survives, since everything survives.
`docs/runtime-baseline.md` carries the measurement and the reasoning.
**Status: done, 2026-09-12.**

**R2. Free-tier landscape — done** for Groq, Mistral, Cerebras and OpenRouter.
`bin/probe-providers.js` reads the provider list from `ProfileRegistry` and
dumps every response header and the raw SSE bytes. Findings in
`docs/providers.md`. The 429 body has now been observed too.

**R3. Tool-calling dialects — done** for the keyed providers. Both shapes are
captured: whole-in-one-delta (Groq, Mistral) and incremental (OpenRouter). A
guard test asserts both remain represented, so half the assembler cannot become
untested.

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

## Phase 1 — Provider core — **complete**

`SseParser`, `OpenAICompatClient`, `ToolCallAssembler`, `RateLimiter`, `Router`,
`ProfileRegistry` with five profiles, `connect`, `Env`, `Terminal`/`Ansi`, and
the local fake OpenAI-compatible server the later suites need.

**Deliverable, verified live:** `peasant ask "..."` streams from a free tier,
reports provider, model and token usage including reasoning tokens, and rotates
past a provider that will not serve. `PEASANT_PROVIDERS=cerebras,groq peasant
ask ...` was answered by Groq after Cerebras returned 402, with the reason shown
rather than swallowed.

Also `peasant providers`, `peasant models`, `peasant doctor`.

**R2 and R3 closed alongside it** for the four keyed providers — see
`docs/providers.md`. The findings shaped the code rather than following it:
both tool-call dialects are represented in the captures, three of four providers
publish no rate-limit headers at all, and a live 402 exposed two bugs (a zero
limit read as impossible-forever, and a provider's billing failure classified as
a bad request, which would have taken the whole session down).

## Phase 2 — Agent loop and tools — **complete**

`Loop`, `Conversation`, `Tool` + `schema` + `registry`, seven tools (`read`,
`write`, `edit`, `ls`, `glob`, `grep`, `bash`), workspace confinement in
`paths.js`, `Policy` and `Prompt`, and a terse system prompt.

**Deliverable, verified live:** `peasant run "<task>"` reads, edits, writes and
runs commands to completion. Two real tasks in a scratch workspace:

- adding a function to an existing file without disturbing it — 5 turns;
- writing a `node:test` file and running it — 8 turns, **rotating from Groq to
  OpenRouter mid-task** when Groq's 8,000 TPM ran out, with Cerebras retired on
  its 402. The test it wrote passes when run independently.

The second run is the one worth noting: the task completed across two providers
without the user doing anything, which is the entire argument for the router.

## Phase 3 — Terminal UI

`Ansi`, `Terminal`, `Repl`, `Render`, `Diff`.

**Deliverable:** the interactive session — streamed output, history, multiline
input, and a Ctrl-C that cancels the in-flight request rather than the process.

### What Phase 2 exposed

- **Config was read only from the working directory**, which is the *workspace* —
  somebody else's project. Keys belong with peasant. `Env.configFiles()` now
  searches `~/.config/peasant/.env`, `~/.peasant/.env` and `./.env` in
  increasing precedence, and `peasant doctor` says which were found.
- **A `bash` timeout did not actually kill anything.** Killing the shell left
  its children holding the pipes, and `close` waits for stdio EOF, so `sleep 30`
  with a one-second timeout took the full thirty. Commands now run in their own
  process group. The test suite went from 30 seconds to 2.
- **An empty string is a model saying "default".** `glob {"path":""}` cost a
  turn and a minute of budget on "path must be a non-empty string". Empty now
  means the default where one is declared, and is kept where none is — `edit.new`
  of `""` means delete.
- **Turn cost is dominated by resending everything.** 14,000 input tokens over 8
  turns, against Groq's 8,000/minute. The system prompt and seven tool schemas
  go out on every turn. This is what Phase 4 is for.

## Phase 4 — Context economy

`TokenEstimator` calibrated against real `usage`, `ContextBudget`, `Compactor`,
tool-result truncation, `session/Store` with resume and fork.

**Deliverable:** a long session that survives an 8,000 TPM budget, with tokens
used, turns and wall time recorded in `docs/entries/` — measured, not asserted.

## Phase 5 — Extensibility

MCP stdio and HTTP clients, custom slash commands, project-level `PEASANT.md` context
files, the remaining provider profiles.

## Phase 6 — Packaging

npm publish, an install path that assumes nothing about the CPU, and a README
whose every figure was measured.
