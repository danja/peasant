# peasant

An LLM coding harness for the poor.

The same shape as OpenCode, Claude Code or Codex, built under two constraints
that are the whole point of it:

1. **It runs on an Athlon II.** A 2010 AMD K10 at `x86-64-v1` — no SSSE3, no
   SSE4.1, no SSE4.2, no AVX. The alternatives die there with `SIGILL` before
   printing anything.
2. **It runs on free API tiers.** Where the budget is 8,000 tokens a *minute*,
   not a context window you will never reach.

Zero runtime dependencies. Zero dev dependencies. Node ≥ 22.

## Why the alternatives crash, and this does not

It is Bun, not Node. Bun's `x64-baseline` build still requires SSE4.2
([oven-sh/bun#14745](https://github.com/oven-sh/bun/issues/14745)), and OpenCode
and current Claude Code both ship as Bun-compiled binaries. Claude Code
[#85571](https://github.com/anthropics/claude-code/issues/85571) is the
controlled experiment: on a pre-SSE4.2 CPU the Bun binary dies while the last
pre-Bun npm release runs fine under plain `node`.

Measured on the target machine, 2026-09-12: **every Node major from 18 to 26
passes all fourteen probe checks**, zlib and AES-GCM included, and an
interactive session runs and answers. Nothing bends for the processor beyond
the rule against Bun — no V8 flags, no build from source.

```sh
node bin/probe-runtime.js     # fourteen checks, each in its own process
./bin/probe-node-matrix.sh    # the same against Node 18 through 26
```

## Getting started

```sh
git clone https://github.com/danja/peasant && cd peasant
mkdir -p ~/.config/peasant && cp example.env ~/.config/peasant/.env
$EDITOR ~/.config/peasant/.env        # add one key; Groq and Mistral are free

node bin/peasant.js doctor            # what it found and what it will use
node bin/peasant.js                   # an interactive session
```

Keys belong in `~/.config/peasant/.env`, not in the project you are working on —
the working directory is the workspace peasant works *on*. A project `.env` can
still pin a model or provider for work done there, and a real environment
variable beats both.

### Using it on another repository

peasant works on whatever directory it is started in, so there is nothing to
set up per project:

```sh
cd ~/some/other/repo
node /path/to/peasant/bin/peasant.js
```

For a shorter command, `peasant` is declared as a bin, so either of these works:

```sh
cd /path/to/peasant && npm link                      # puts `peasant` on PATH
alias peasant='node /path/to/peasant/bin/peasant.js' # or just this
```

**Check what a repository costs you before settling in.** `peasant doctor` in
that directory reports the fixed per-turn cost, which includes any context file
it found:

```
~2680 tokens before anything is said (7 tool schemas + system prompt), resent on every turn
  including 6661 chars from /some/other/repo/AGENTS.md
```

That example is real, and 2,680 tokens is a third of Groq's per-minute budget
spent before you have said anything. Two ways out, if turns start stalling:
put a provider with headroom first, or give peasant a shorter file of its own —
`PEASANT.md` wins over `AGENTS.md`, so the long one can stay for other tools.

```sh
PEASANT_PROVIDERS=mistral,groq peasant        # 625,000 tokens/minute, measured
```

## Commands

```
peasant                  an interactive session
peasant --resume [id]    continue the last session here, or one by id
peasant ask <prompt>     one question, streamed — no tools, no file access
peasant run <task>       one task, with tools, non-interactively
peasant sessions         list kept sessions
peasant mcp              configured MCP servers and the tools they offer
peasant providers        which providers are configured, and their budgets
peasant models           the chat models each provider offers
peasant doctor           runtime, search engine, configuration, cost per turn
```

In a session: `/help`, `/clear`, `/compact`, `/providers`, `/tools`, `/tokens`,
`/allow`, `/exit`. A trailing `\` or an unclosed ``` fence continues a line, so pasting a
function is one turn rather than eight.

## Providers

Eight profiles: Groq, Mistral, Cerebras, OpenRouter, Google AI Studio, Hugging
Face, and local Ollama and llama.cpp. Anything speaking the OpenAI shape works;
adding one is a file.

**Providers rotate automatically.** They are tried in `PEASANT_PROVIDERS` order
and peasant moves on when the current one is rate limited, unavailable or
failing — because Groq allows 8,000 tokens a minute and Mistral 625,000
(measured), so the difference between stalling and not is usually just asking
someone else. A provider answering 401, 402 or 403 is retired for the session;
a 400 is not retried anywhere, because every provider would say the same.
`PEASANT_ROTATE=off` pins everything to the first.

Rotation has been seen finishing a task the first provider ran out of budget
halfway through, without the user doing anything.

**No rate limit is ever a constant here.** Every published figure for these
tiers turned out to be wrong — Groq documents 6,000 tokens a minute and reports
8,000 — so limits are read from `x-ratelimit-*` response headers, whose names
differ per provider and which five of the six hosted providers do not send at
all. See [`docs/providers.md`](docs/providers.md).

## Token economy

Measured against a live provider, not estimated:

| | tokens |
|---|---|
| Empty request | 72 |
| System prompt | 132 |
| Seven tool schemas | **738** |
| Fixed cost, every turn | **942** |

Nearly 12% of a per-minute budget before a word is said. So:

- tool results are truncated head-and-tail, and file reads are windowed;
- `grep` returns matching *lines*, not matching files, because "it is in these
  twelve files" costs a second round trip;
- the conversation is compacted when it passes a fraction of whichever limit
  binds — the rate limit or the context window, whichever is smaller;
- the token estimator starts from measured constants (code is **twice** as dense
  as prose) and then calibrates against `usage.prompt_tokens` on every response.
  In a live session it settled at a 0.90 correction after sixteen responses.

## Telling it about your project

A `PEASANT.md` in the repository — or an `AGENTS.md`, the cross-tool convention
— is folded into the system prompt, as is a personal
`~/.config/peasant/PEASANT.md` that applies everywhere. This is the cheapest
thing available for improving output on a weak model: telling it the conventions
of the repository it is in beats any amount of prompt engineering in the
abstract.

It is capped at 8,000 characters and the session header states the size, because
all of it is resent on every turn — see "Using it on another repository" above
for what that costs in practice.

`CLAUDE.md` is deliberately not read: it is addressed to a different agent with
different tools, and following instructions written for someone else is worse
than having none. Where a repository symlinks `CLAUDE.md` to `AGENTS.md` the
content is shared anyway, which is fine — the rule is about not *assuming* one
file speaks for another.

## Commands of your own

A markdown file under `.peasant/commands/` becomes a slash command:
`review.md` is `/review`. A leading `# ` line is its description for `/help`,
and `$ARGUMENTS` is replaced by whatever followed the name — or appended, if the
file does not mention it.

```markdown
# Review a diff our way
Look at the staged diff. Comment only on correctness and naming.
$ARGUMENTS
```

## MCP

Both transports: **stdio** for a local server and **Streamable HTTP** for a
remote one. About 400 lines, no dependency. Configure in
`~/.config/peasant/mcp.json` or `.peasant/mcp.json` using the same shape every
other MCP client uses — see `example.mcp.json` — and run `peasant mcp` to see
what loaded.

A server's tools become indistinguishable from built-in ones: same permission
policy, same token accounting. Anything a server does not declare read-only is
treated as mutating and asks before running, because `readOnlyHint` is optional
in MCP and the cost of guessing wrong that way is one extra prompt. Most servers
declare it on nothing, so a server's block can list `alwaysAllow` for the tools
you are happy to run unattended.

`docs/mcp.md` has a worked example translating a real Claude Code configuration,
including the table for `~/.claude.json` → peasant.

Only tools are implemented. Resources and prompts are absent rather than
half-present. See [`docs/mcp.md`](docs/mcp.md).

## Search

`grep` uses a ripgrep already on your PATH, and a pure-JavaScript engine
otherwise. It never *ships* a binary — a prebuilt binary is the thing this
project exists to avoid. `tests/unit/search-parity.test.js` runs both engines
over the same tree and asserts identical output, because otherwise the same
question would give two people different answers.

## The rules, and what enforces each

Nothing here is enforced by good intentions. 11 guard files, 438 tests, 0
dependencies.

| Rule | Enforced by |
|---|---|
| Zero dependencies, runtime and dev | `tests/guard/no-runtime-deps.test.js` |
| No native addons, WASM or prebuilt binaries — by magic number, not extension | `tests/guard/no-native.test.js` |
| `engines.node` matches the measured floor | `tests/guard/engines.test.js` |
| No provider named outside `src/provider/profiles/` | `tests/guard/profile-coverage.test.js` |
| A tool's advertised schema is the one that validates | `tests/guard/tool-schema.test.js` |
| All terminal output through `src/ui/Terminal.js` | `tests/guard/no-raw-stdout.test.js` |
| Every tunable documented in `example.env`, both directions | `tests/guard/example-env.test.js` |
| Every `tests/` directory run by a script, suites disjoint | `tests/guard/suite-coverage.test.js` |
| `.gitignore` cannot swallow a fixture | `tests/guard/gitignore.test.js` |
| Every standing document listed in `docs/index.md` | `tests/guard/docs-index.test.js` |

Rate limits and context windows have no guard because they have nowhere to
live: `RateLimiter` holds no limit values, profiles hold only header *names*,
and `src/config/preferences.js` is the only home for a tunable.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — the design
- [`docs/plan.md`](docs/plan.md) — phases and what each delivered
- [`docs/providers.md`](docs/providers.md) — what the providers actually do, measured
- [`docs/runtime-baseline.md`](docs/runtime-baseline.md) — which Node builds run, and how that was measured
- [`docs/target-machine.md`](docs/target-machine.md) — the hardware
- [`CLAUDE.md`](CLAUDE.md) — house rules
- [`MISTAKES.md`](MISTAKES.md) — what went wrong and what now prevents it

MIT.
