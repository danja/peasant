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

## Shape

```
bin/     peasant.js   probe-runtime.js   probe-node-matrix.sh   probe-providers.js
src/
  compat/    Preflight.js
  config/    Config.js  Env.js
  provider/  OpenAICompatClient.js  SseParser.js  ToolCallAssembler.js
             RateLimiter.js  Router.js  ProfileRegistry.js  profiles/
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
