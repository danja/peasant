# Architecture

## Principles

1. **The runtime baseline is a tested property, not an assumption.** A startup
   preflight and a compat suite, sharing their checks.
2. **Zero runtime dependencies, enforced by a test** — not by discipline.
3. **No provider-specific logic outside `src/provider/profiles/`.** The agent
   loop must not know who it is talking to.
4. **The token budget comes from response headers.** A hardcoded limit is a bug.
5. **One list, exported.** Tool schemas, provider profiles, ANSI codes.
6. **Streaming is the default path**, not an alternate one. The non-streaming
   path is the special case and gets fewer tests, so it must not be where the
   harness normally lives.
7. **Every component here encodes an assumption about what the model cannot do
   on its own.** So when a model improves, the move is to *remove* a piece and
   re-measure, not only to add one. Peasant has a harder version of this than
   most: it rotates providers mid-session, so one conversation may run on a 20B
   model and a large one within the same task, and every scaffold is therefore
   tuned to the **weakest model in the rotation**. There is no single model whose
   improvement lets a piece be dropped. That is a real limit on ever simplifying
   this codebase, and it follows from the specification rather than from a
   mistake. (Borrowed from Anthropic's harness-design piece; see
   `entries/2026-09-15_claude_harness-design-reading.md`.)

## Shape

```
bin/     peasant.js   probe-runtime.js   probe-node-matrix.sh   probe-providers.js
src/
  compat/    Preflight.js
  config/    Config.js  Env.js
  provider/  Client.js  SseParser.js  ToolCallAssembler.js  Credentials.js
             RateLimiter.js  Router.js  ProfileRegistry.js  profiles/  dialects/
  agent/     Loop.js  Conversation.js  ContextBudget.js  Compactor.js
             TokenEstimator.js
  tools/     Tool.js  registry.js  read.js write.js edit.js ls.js glob.js
             grep.js bash.js fetch.js todo.js
  permission/ Policy.js  Prompt.js
  session/   Store.js
  ui/        Terminal.js  Ansi.js  Repl.js  Render.js  Diff.js
  mcp/       Client.js
```

## The pieces that carry the weight

**`SseParser`.** `fetch()` yields a byte stream and SSE framing must be parsed
incrementally across chunk boundaries — a `data:` line can split mid-UTF-8. It
is perhaps eighty lines and it is the most likely home for a subtle bug, so it
gets a fixture suite of recorded byte streams replayed at adversarial chunk
boundaries, including one byte at a time.

**`ToolCallAssembler`.** Streaming tool calls arrive as deltas keyed by index,
with the function name in the first delta and the arguments dribbled across
many. Providers disagree on the details. One assembler, one fixture set per
provider, recorded by `probe-providers.js`.

**`dialects/`.** Three wire formats, one client. A *dialect* answers "what does
the wire look like" — chat-completions, Anthropic Messages, OpenAI Responses —
while a *profile* answers "who is on the other end". Dialects are named after
the format and never after a vendor, because more than one provider may speak
each. Each one translates in both directions and normalises everything on the
way out into the shapes the rest of peasant already reads: tool calls as
streamed OpenAI tool-call deltas, usage as `prompt_tokens`/`completion_tokens`.
Translating at the edge is what keeps `ToolCallAssembler`, `TokenEstimator` and
`EventPrinter` ignorant of who answered, and it is why adding the second and
third formats changed no file in `src/agent/`.

**`Credentials.js`.** The one place that reads a file peasant does not own —
Claude Code's and the Codex CLI's stored logins. It never writes them:
refreshing rotates a token, and rotating another program's login from underneath
it loses both. A missing, unparseable or expired file is reported and skipped
with the remedy named, never thrown, for the same reason `./.env` is.

**`RateLimiter` and `Router`.** Ask the limiter before each request; feed the
response headers back after. On 429, honour `retry-after`, then rotate to the
next configured provider that has budget. This is what makes a free-tier harness
usable rather than a novelty, and it is why provider configuration is a *list*
rather than a single setting.

**`ContextBudget` and `Compactor`.** At 8,000 TPM — Groq's measured ceiling —
the harness has to be stingy
by construction, not by a counter bolted on afterwards: tool results truncated
with a head/tail window and a byte count, file reads offset-and-limited by
default, `grep` returning matches rather than whole files, compaction triggered
on a fraction of the *model's* context rather than a fixed number. Compaction
summarises the older half of a conversation and replaces it, keeping the system
prompt and the most recent turns verbatim.

**`Tool`.** One declaration carries a tool's JSON schema, its argument validator
and its implementation. The same object is rendered into the provider `tools`
array and used to validate the call, so the schema the model is shown and the
schema enforced cannot drift.

**`Terminal`.** Every byte to stdout goes through it. Scattered
`process.stdout.write` is how a TUI becomes unfixable.

**`Preflight`.** Checks the runtime against `engines.node` — read from
`package.json`, the single runtime copy — and exits with a message that names
the remedy. It cannot catch a SIGILL; it exists so that the failures which *are*
catchable are caught before a prompt has been typed and quota spent.

## Testing

Three disjoint suites, kept disjoint by `tests/guard/suite-coverage.test.js`.
`npm test` runs `tests/guard/` and `tests/unit/` with no network, exercising the
agent loop end to end against a local fake OpenAI-compatible server built on
`node:http`. `npm run test:compat` runs the runtime probe. `npm run test:live`
talks to real providers, deliberately, never in a sweep.

Mocking the provider is the one deliberate exception to testing against live
services, and it follows from the specification: an 8,000 TPM ceiling is a budget
a test suite would exhaust in seconds. Everything that is not the provider — the
filesystem, the shell, the session store — is tested for real.
