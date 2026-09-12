# TODO

What the project needs. What *the user* needs to do is `docs/danja-todo.md`; an
item landing in one usually changes the other.

## Blocking

Nothing. R1 is answered: every Node major from 18 to 26 passes all fourteen
checks on the target, the floor is `>=22.0.0`, and Phase 1 can start.

## Phase R, remaining

- [x] ~~R1: runtime baseline~~ — done 2026-09-12. Node was never the problem;
      Bun was. See `docs/runtime-baseline.md`.
- [x] ~~R2: probe the providers~~ — done 2026-09-12 for **Groq and Mistral**,
      the two with accounts. `bin/probe-providers.js` exists; findings in
      `docs/providers.md`, evidence in `docs/raw/2026-09-12_providers/`.
      Re-run it when a key is added for any of the other six.
- [x] ~~R2 remainder: the 429 body~~ — observed on Mistral, 2026-09-12. Empty
      body, no `retry-after`, and `x-ratelimit-limit-req-minute: 0`. Recorded in
      `docs/providers.md`; the zero-limit case now has a test.
- [ ] Decide the default model per provider. `mistral-vibe-cli-with-tools` and
      `mistral-code-latest` look purpose-built; evaluate before settling. Check
      whether `groq/compound` is a chat model or an agent wrapper with its own
      tool loop — if the latter it conflicts with ours and must be excluded.
- [ ] R3: catalogue tool-calling dialect differences, one fixture per case.
      Started: Groq and Mistral both return a tool call **whole in one delta**
      (`docs/providers.md`), which is *not* the OpenAI incremental shape the
      assembler must also handle. Real SSE captures are in
      `docs/raw/2026-09-12_providers/*.sse`.
- [ ] R4: read OpenCode, Codex CLI and Claude Code's pre-Bun npm package; write
      `docs/prior-art.md`. Decide the file-editing strategy there — exact-string
      replace against diff-apply. Exact-string replace is cheaper in tokens,
      which matters more here than usual.
- [ ] R5: terminal capability survey on the target — `TERM`, colour depth,
      unicode width, raw mode behaviour.
- [x] ~~R6: pure-JS token estimation~~ — done. `bin/probe-tokens.js` measured the
      constants against a live provider; `TokenEstimator` calibrates against
      `usage.prompt_tokens` on every response and settled at 0.90 in a real
      session. See `docs/providers.md`.

## Known dialect quirks to encode in profiles

All of the below are now encoded and tested. Kept as the record of *why* the
profile fields exist.

- [x] **Groq reset headers are duration strings** (`1m26.4s`, `644ms`), not
      seconds or timestamps. Needs a parser, with both forms tested.
- [x] **Mistral publishes no reset header.** The window is implied by the header
      name (`-minute`) and nothing states when it rolls, so its budget must be
      inferred and therefore held more conservatively than Groq's.
- [ ] **Groq's window semantics are still not understood.** `limit-requests: 1000` with
      `reset-requests: 1m26.4s` reads as neither clearly per-minute nor per-day.
      Treat `remaining` as authoritative and `reset` as the earliest safe retry —
      correct under either reading. Do not guess.
- [x] **`delta.reasoning` with `channel: "analysis"`** on Groq's gpt-oss models
      is not `delta.content` and must never be rendered as assistant output — but
      it *does* consume budget. 22 of 24 completion tokens in the probe were
      reasoning tokens. `TokenEstimator` must read
      `usage.completion_tokens_details.reasoning_tokens`.
- [x] Filter non-chat models out of selection — `NON_CHAT` in
      `src/provider/profiles/generic.js`.
- [ ] **Three of four providers publish no rate-limit headers.** OpenRouter and
      Cerebras give the limiter nothing; its budget for them is discovered only
      from 429s. Worth considering a conservative self-imposed default for a
      provider that reports nothing.

## Design decisions not yet taken

- [ ] **Should the `grep` tool prefer a system `ripgrep`?** ripgrep 15.1.0 runs
      on the target, so Rust baseline x86-64 binaries are fine there. Peasant
      must not *ship* a binary, but using one already on PATH breaks no rule and
      would be much faster than pure JS on a large tree. The cost is two code
      paths to keep behaviourally identical — and if they diverge, a guard test
      must be what notices.
- [x] ~~Whether a local Ollama or llama.cpp is in scope~~ — both have profiles,
      verified against a real Ollama. Still needs a CPU-baseline-safe build on
      the target; untested there.

## Phase 2 leftovers

- [ ] **The tool schemas cost 738 tokens on every turn.** Investigated: of 4,090
      characters only ~300 is repetition, so trimming descriptions would save
      perhaps 7% and risks costing more turns than it saves. The real saving
      would be sending a subset — but a task that turns out to need `write`
      after being told it has no `write` is worse than the tokens. Left alone
      deliberately; revisit with a way to add a tool mid-conversation. — measured, and 78% of
      the 942-token fixed cost. Worth attacking directly: the descriptions are
      verbose, and a task that will never write a file does not need `write`,
      `edit` and `bash` described to it. Sending a subset would be the single
      largest saving available.
- [x] ~~`session/Store`~~ — done. Append-only JSONL, `--resume`, `sessions`.
- [x] ~~`peasant run` does not persist anything~~ — it does now.
- [ ] Nothing prunes old sessions. They are small, but unbounded.
- [ ] The turn limit (25) and `KEEP_RECENT` (6) are inline constants. They
      belong in `preferences.js` with the rest.
- [ ] `EventPrinter` calls `describe()` with a fake `{ name }` object rather
      than the tool. It works because `describe` only reads `.name`, but it is a
      seam that will break the first time it needs anything else.
- [x] ~~The session has no multiline input~~ — a trailing `\` or an unclosed
      ``` fence continues a line.
- [ ] `/model` would be useful — switching provider or model without restarting.
- [ ] Multiline input has no way to cancel a half-typed block except Ctrl-C.
- [x] ~~`bin/peasant.js` is 307 lines~~ — split into `src/cli/`, one file per
      command; the entry point is 99 lines of dispatch.
- [x] ~~Decide whether `grep` should use a system `ripgrep`~~ — done. It uses one
      when found on the PATH and the pure-JS engine otherwise, with
      `tests/unit/search-parity.test.js` binding them. peasant still never
      *ships* a binary.

## Guards

- [x] `profile-coverage.test.js` — every profile registered, named in
      `example.env`, `verified` only with a capture behind it, and no provider
      name anywhere outside `profiles/`.
- [x] `no-raw-stdout.test.js` — nothing outside `src/ui/` writes to the terminal,
      and no escape sequence lives outside `Ansi.js`.
- [x] ~~A grep guard against hardcoded rate limits~~ — not written, and
      deliberately. The architecture makes one impossible rather than
      detectable: `RateLimiter` holds no limit values at all, profiles hold only
      header *names*, and `src/config/preferences.js` is the only home for a
      tunable. A guard would be weaker than the structure it policed.
- [x] `example-env.test.js` binds every tunable to its documentation, in both
      directions — an undocumented setting and a documented one nothing reads
      both fail.
- [ ] `tool-schema.test.js` — a tool's advertised schema is the one that
      validates. Phase 2, with the tools.
- [ ] Bind `example.env`'s base URLs to the profile defaults. The names are
      bound; the URLs are still two copies.

## Phase 5 remainder

- [x] ~~MCP~~ — done, over stdio **and** Streamable HTTP. See `docs/mcp.md`.
- [x] ~~Project-level `PEASANT.md`~~ — done, plus `AGENTS.md` and a personal
      file. Capped at 8,000 characters, with the size shown.
- [x] ~~Custom slash commands~~ — done, `.peasant/commands/*.md`.
- [ ] Context files are read once at startup. Editing `PEASANT.md` mid-session
      has no effect until a restart, which will surprise someone.
- [ ] MCP resources and prompts. Deliberately absent for now rather than
      half-implemented; add them when something needs them.
- [ ] MCP tools are fetched once at startup. A server sending
      `notifications/tools/list_changed` is ignored.
- [ ] NVIDIA and Together provider profiles — a file each, when keys exist.

## Housekeeping

- [x] ~~`README.md`~~ — written, every figure taken from the system.
- [ ] `README.md` cites 412 tests, 59 files and ~5,300 lines. Those go stale the
      moment anything is added. Either bind them with a test or drop them.
- [x] ~~`bin/peasant.js` does not exist~~ — it does now.
- [x] ~~inline tunables~~ — `src/config/preferences.js` now holds every one with
      the reason for its value, read from `PEASANT_*` and refusing a value it
      cannot parse. `estimate()` in `bin/peasant.js` is still crude and is
      replaced by `TokenEstimator` in Phase 4.
- [ ] `peasant doctor` should verify that each provider's selected model can
      actually make a tool call. Hugging Face's first choice returned
      `422 UNSUPPORTED_OPENAI_PARAMS` — tool support is a property of the model,
      not the provider, and a coding harness without it is useless. Cheap to
      check, and the alternative is discovering it mid-task.
- [ ] Preference lists go stale: four of six were written from documentation and
      four of six were wrong (`docs/providers.md`). Worth a periodic re-probe,
      and possibly a `peasant models --check` that flags a profile whose
      preferences no longer match anything.
- [ ] Revisit the Node floor when v22 reaches end of life, 2027-04-30.
