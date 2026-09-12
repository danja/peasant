# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

There should be no inline fallbacks, as this leads to indeterminate code. If a value is
not successfully retrieved from config then that is an error that needs fixing.

**Whose file it is decides how strict to be about it.** That rule is right for
peasant's own configuration, where a malformed line means a setting silently
missing. It is wrong for a file belonging to the project being worked on — a
`./.env` full of shell peasant has no business understanding — where refusing to
start throws away good configuration from elsewhere. Report and skip those. The
principle is "named, not silently skipped"; being fatal was never the point.

## Why this project exists

Peasant is an LLM coding harness CLI — the same shape as OpenCode, Claude Code and
Codex — built under two constraints that are the entire point of it:

1. **It must run on an Athlon II.** That is AMD K10: SSE, SSE2, SSE3, SSE4a and
   POPCNT/LZCNT via ABM, and nothing above. No SSSE3, no SSE4.1/4.2, no AVX. In
   `gcc` terms that is **x86-64-v1**, one level below the `x86-64-v2` baseline that a
   great deal of prebuilt software now assumes.
2. **It must run on free API tiers.** Measured 2026-09-12 from the accounts we
   hold: Groq allows **8,000 tokens/minute**, Mistral **625,000**
   (`docs/providers.md`). Eight thousand is less than one generous file read.
   Note that every published summary said 6,000 — which is why **no rate limit
   or context window is ever a constant in this codebase**; they are read from
   `x-ratelimit-*` response headers, whose names differ per provider.

Neither is a preference to be optimised away later. Both are the specification.

**The CPU constraint is already handled, and the handling is one rule.** Measured
2026-09-12: every Node major from 18 to 26 passes all fourteen probe checks on
the target, zlib and AES-GCM included (`docs/runtime-baseline.md`). Node was
never the problem — Bun was. So **the ban on Bun below is the whole of the CPU
mitigation**; ordinary code here does not need to think about 2010 silicon. The
zero-dependency and no-native rules still matter, because they are what stop a
*future* dependency dragging an `x86-64-v2` binary in behind everyone's back.

**Do not suggest, and do not quietly introduce:**

- **Bun.** It is why the alternatives crash here. Bun's `x64-baseline` build still
  requires SSE4.2 ([oven-sh/bun#14745](https://github.com/oven-sh/bun/issues/14745)), and
  OpenCode and current Claude Code both ship as Bun-compiled binaries. Claude Code
  [#85571](https://github.com/anthropics/claude-code/issues/85571) is the controlled
  experiment: the Bun binary dies with `SIGILL` on a pre-SSE4.2 CPU while the last
  pre-Bun npm release runs fine under plain `node`.
- **Ink, React, or any reconciler.** The UI is raw ANSI over `node:readline`. A React
  reconciler re-rendering on every streamed token is the heaviest possible choice on the
  slowest possible hardware.
- **`tiktoken` or any tokeniser package.** WASM blob plus BPE tables — banned twice over.
- **Any runtime dependency at all.** See below.
- **Bundling a binary — ripgrep included.** peasant *uses* a `rg` already on the
  PATH, because that one was built for the machine it is on. It must never ship
  one, and `tests/guard/no-native.test.js` enforces that by magic number as well
  as by extension.

## Layout

- `bin/` — `peasant.js` (entry), `probe-runtime.js` (the CPU/runtime probe),
  `probe-node-matrix.sh` (the same probe across Node majors), `probe-providers.js`
- `src/compat/` — `Preflight.js`, the startup capability check, sharing its checks with
  `tests/compat`
- `src/config/` — `Config.js` (defaults → file → `${ENV}` → environment), `Env.js`
- `src/provider/` — `OpenAICompatClient.js`, `SseParser.js`, `ToolCallAssembler.js`,
  `RateLimiter.js`, `Router.js`, `ProfileRegistry.js` and `profiles/` (one file per
  provider)
- `src/agent/` — `Loop.js`, `Conversation.js`, `ContextBudget.js`, `Compactor.js`,
  `TokenEstimator.js` (measured constants, calibrated at runtime), `prompt.js`,
  `context-files.js` (`PEASANT.md` and `AGENTS.md`, capped and folded into the
  system prompt)
- `src/tools/` — `Tool.js` (the interface), `schema.js` (the JSON Schema subset),
  `registry.js` (the one list), `paths.js` (workspace confinement), one file per
  tool, and `search/` — two interchangeable grep engines behind one door
- `src/permission/` — `Policy.js`, `Prompt.js`
- `src/session/` — `Store.js`: append-only JSONL under `~/.peasant/sessions`,
  one record per line, with a `reset` record where compaction replaces history
- `src/ui/` — `Terminal.js` (the only module that writes to stdout), `Ansi.js`
  (the one list of escape codes), `Repl.js`, `Render.js`, `Diff.js`
- `src/cli/` — one file per command, plus `EventPrinter.js` (agent events to
  terminal), `context.js` (assembling providers, policy and workspace),
  `agent.js` and `commands.js` (custom slash commands from files).
  `bin/peasant.js` is dispatch only.
- `src/mcp/` — `JsonRpc.js`, `StdioTransport.js`, `HttpTransport.js`,
  `Client.js`, `adapt.js` (server tools become peasant tools), `config.js`,
  `connect.js`. Both transports; see `docs/mcp.md`
- `tests/guard/` — the rules below, enforced; `tests/unit/`, `tests/compat/`, `tests/live/`

The design is `docs/architecture.md`; the phased plan is `docs/plan.md`; the measured
runtime floor is `docs/runtime-baseline.md`. Read those before making structural changes.

## The rules, and what enforces each one

A rule worth stating in this file is worth a test. In the sibling project, "no inline
SPARQL" sat in CLAUDE.md from the first phase and reached **seventeen violations across
eight files** before anyone counted. When adding a rule here, ask what would notice it
being broken — and if the answer is "a careful reader", write the check instead.

| Rule | Enforced by |
|---|---|
| Zero runtime dependencies, and zero dev dependencies | `tests/guard/no-runtime-deps.test.js` |
| Shipped code imports only `node:*` and relative paths | same |
| No native addons, WASM, or prebuilt binaries — ever | `tests/guard/no-native.test.js` |
| No `install`/`postinstall` script, no `binding.gyp` | same |
| `engines.node` matches the measured floor | `tests/guard/engines.test.js` |
| Every `tests/` directory is run by some npm script, and the suites are disjoint | `tests/guard/suite-coverage.test.js` |
| No provider-specific branching outside `src/provider/profiles/` | `tests/guard/profile-coverage.test.js` |
| Every tunable lives in `src/config/preferences.js` and is documented in `example.env` | `tests/guard/example-env.test.js` |
| All terminal output goes through `src/ui/Terminal.js` | `tests/guard/no-raw-stdout.test.js` |
| A tool's advertised schema is the schema that validates | `tests/guard/tool-schema.test.js` |
| The two search engines give byte-identical answers | `tests/unit/search-parity.test.js` |
| An MCP tool not declared read-only is treated as mutating | `tests/unit/mcp.test.js` |
| Every tool declares `mutates`; the permission policy reads nothing else | same |
| No tool reads or writes outside the workspace | `tests/unit/tools.test.js` |

**Never hardcode a rate limit or a context window.** There is no guard for this
and there does not need to be: `RateLimiter` holds no limit values at all,
profiles hold only header *names*, and `src/config/preferences.js` is the only
home for a tunable. The structure leaves a hardcoded limit nowhere to live,
which is stronger than a grep that would notice one.

**An early return is a claim that there is nothing to do.** Twice now one has
been wrong: `compact()` returned early when there was nothing to *summarise*,
skipping the mechanical reduction that was the actual remedy, and `load()`
returned a file's values without asking whether an empty one should overwrite
anything. Before writing `if (x.length === 0) return`, ask whether it means the
work is done or only that one method of doing it is unavailable.

**A guard that scrapes source needs its own test that the scraping still works**, or it
goes blind rather than red. `tests/guard/scanner.test.js` is that test for
`tests/guard/lib/scan.js`; it caught the scanner blanking the very string contents it was
meant to read, on the first run. Change one and you change the other.

## The recurring failure

In the sibling project, **five times** a change was made in one file while a *second file
that had to change with it* was left alone. Nothing connected them, so nothing complained,
and each was found in production or by accident. This table starts empty here. Add a row
the moment it happens — that is what makes the next one cheap.

| Change | The file left behind | Symptom |
|---|---|---|
| *(none yet)* | | |

**When adding a runtime dependency on a path, a value, or a list, find what else has to
agree with it — and write the test that binds them.** A test asserting that two lists match
is worth more than either list being carefully reviewed.

Before finishing a change, check:

- **Does a feature that persists something have a test that reads it back?** Storing the
  file is not the feature; writing the fact is. Image upload in the sibling project had 22
  passing tests covering bytes, types, refusals and rendering, and none covering the
  write — which was the half that had never worked.
- Does a new `tests/<dir>/` appear in a `package.json` script? (`suite-coverage.test.js`
  now answers this, but only because it was written before the directory was.)
- Does `.gitignore` exclude a file a test reads? **A fixture is source, not output.** The
  stock Node `.gitignore` here excludes `*.log` and `*.pid` — recorded SSE streams and
  provider transcripts must not be saved under those names.
- Does `package.json`'s `files` array include a directory the CLI reads at runtime?
- Does anything new persist outside `~/.peasant/`? Then session resume, the backup story
  and the uninstall story all have to know, and none of them will complain.
- **A manual step that has failed twice is a script.** Where a failure has one cause, the
  error message should name the remedy.

## Prose is a claim, and nothing tests sentences

Six times in the sibling project a document said something untrue — a file count that was
wrong by a factor of three, an identity scheme that did not exist and a paid feature nearly
built on it, a README claiming a harvester that had shipped.

- **Take a figure from the system, not from memory.** A probe run, a `grep -c`, a real
  `usage` field from an API response. Every number in `README.md` and
  `docs/runtime-baseline.md` must be traceable to a command someone ran.
- **Where the prose is a commitment, bind it with a test.** A published rate limit, a
  claimed Node floor, a documented token budget.
- **A prose claim that would be expensive to get wrong deserves checking before it is
  acted on**, not after.
- **When a feature starts working, re-read what was written around it.** A feature that
  has never worked has no second case for its documentation to get wrong; shipping it is
  what makes every sentence near it suspect.

## Long files are a smell

A source file that has grown long has usually stopped being one thing. Treat length as a
signal to look, not a rule to obey: the question is whether the file still has a single
reason to change, and a long one rarely does.

- **Check periodically**, not only when touching a file: `wc -l src/**/*.js | sort -n | tail`.
- Roughly, past **~400 lines** a module is worth a look and past **~600** it almost always
  wants splitting.
- Split along the seam that already exists — a route group, a serialisation format, one
  provider's quirks — not by line count.
- The test suites are the safety net, so a refactor that needs its tests rewritten to pass
  is not a refactor. Move code, keep behaviour, and the existing tests should still hold.

## Two implementations of one thing need a test that compares them

`src/tools/search/` has two engines: ripgrep when the machine has one, pure
JavaScript otherwise. A query must give the same answer either way, or the same
question gives two people different results depending on what they happen to
have installed — the worst kind of bug, because it works on your machine and the
difference is invisible.

`tests/unit/search-parity.test.js` runs **both** engines over one deliberately
awkward tree and compares. It has already earned its place twice:

- ripgrep's `-g '**/.github/**'` found *nothing at all*, because in ripgrep any
  positive glob is a whitelist.
- An `include` glob silently re-enabled `node_modules` and `dist`, because the
  *last* matching glob wins — so a `grep --include '**/*.js'` would have searched
  a dependency tree and spent a minute of token budget in one call.

Neither was visible from either engine alone. When a second implementation of
anything appears here, the test that compares them is not optional.

## Where a list must exist, make it one list and export it

`src/tools/registry.js`, `src/provider/ProfileRegistry.js` and `src/ui/Ansi.js` are all
this — a default that cannot be forgotten, rather than a list that must be remembered.
Prefer that shape to a checklist entry whenever it is available. A tool's JSON schema is
declared once and both rendered to the provider and used to validate the call, so the
schema the model is shown and the schema enforced cannot drift.

## Testing

Three disjoint suites, kept disjoint by `suite-coverage.test.js`:

- **`npm test`** — `tests/guard/` and `tests/unit/`. No network. The agent loop is
  exercised end to end against a **local fake OpenAI-compatible server** built on
  `node:http`, replaying recorded fixtures.
- **`npm run test:compat`** — the runtime probe, runnable against any Node on PATH.
- **`npm run test:live`** — real providers. Run deliberately, **never** as part of a
  sweep. It asserts that the dialect still matches the profiles, with the smallest prompts
  that can prove it.

**Mocking the provider is the one deliberate exception** to testing against live services,
and it is a consequence of the specification: the tightest live tier we hold is
8,000 TPM, a budget a test suite would exhaust in seconds. Everything that is not the provider — the
filesystem, the shell, the session store — is tested for real.

**Retrieval and budget changes are measured, not asserted.** When `ContextBudget` or
`Compactor` change, record tokens used, turns and wall time for a fixed task in
`docs/entries/`, and never tune a fixture until a test passes.

## Development

- ES modules throughout. The Node floor is whatever `docs/runtime-baseline.md` records —
  **change that document first**, then `package.json`, or `engines.test.js` fails.
- Scripts run from the repository root.
- The test runner is `node:test` and the syntax check is `node --check`. Adding a dev
  dependency is a decision to make explicitly, not by installing one.
- Tunable constants belong in one place with a comment explaining each, never inline.
  A rate limit or context window is never a constant at all — it is read from response
  headers or the model list.

## Working rules

- **API keys are sacred.** They must not be shared, logged, or written into a fixture.
  `probe-providers.js` prints headers; check what it prints before pasting output anywhere.
- **Do not run any `git` operations unless the user explicitly approves them.**
- Use the Read tool to read files rather than `sed`/`cat`/`head`/`tail` via Bash, unless
  the session's harness directs otherwise — Bash calls need per-call approval and Read
  does not.
- **Log mistakes in `MISTAKES.md`**, newest first: what happened, root cause, prevention.
- Keep **`TODO.md`** (what the project needs) and **`docs/danja-todo.md`** (what the user
  must do — anything needing hardware access, credentials, an account, or a decision that
  is theirs) current. Revise both at the end of any session that changes them; strike
  finished items into a "Confirmed done" section rather than deleting them, and say plainly
  which things block which. `docs/danja-todo.md` is also the right place to record anything
  asserted about the target machine that has not actually been verified.

## Docs and worklog

- `docs/architecture.md`, `docs/plan.md`, `docs/runtime-baseline.md` and
  `docs/prior-art.md` are the standing documents.
- Progress reports and plans go under `docs/entries/`, named
  `YYYY-MM-DD_claude_title.md`, with the main title starting `# Claude :`, written as a
  development worklog. Start a new one when it exceeds a page or two, or the topic changes.
