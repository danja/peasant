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
      **Needs a comparison over real tasks, not a probe**: which model is better
      at this is a judgement about output quality, and guessing from names is
      how four of six preference lists came to be wrong.
- [x] ~~R3: catalogue tool-calling dialect differences~~ — both shapes are
      captured and both are tested. Groq, Mistral and Google send a tool call
      whole in one delta; OpenRouter and Hugging Face dribble the arguments.
      `tests/unit/tool-call-assembler.test.js` asserts both remain represented,
      so half the assembler cannot quietly become untested.
- [ ] R4: `docs/prior-art.md`. The decision it was meant to inform — exact-string
      replace against diff-apply — was taken in Phase 2 and is working, with the
      reasoning recorded in `src/tools/edit.js`. What remains is comparative
      reading, worth doing when there is a specific question rather than as an
      exercise.
- [ ] R5: terminal capability survey on the target — `TERM`, colour depth,
      unicode width, raw mode behaviour. **Needs the target machine.** An
      interactive session has since run there successfully, so nothing is known
      to be wrong; this would tell us what is merely working by luck.
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
- [ ] **Five of six providers publish no usable rate-limit headers.** Only Groq
      states everything; Mistral gives limits without a reset. The rest are
      discovered from 429s and 413s alone. A conservative self-imposed default
      for a silent provider would trade a little throughput for far fewer
      refusals, but any number chosen here would be exactly the kind of
      unmeasured constant this project refuses elsewhere. Left open deliberately.

## Design decisions not yet taken

- [x] ~~Should `grep` prefer a system `ripgrep`?~~ — yes, and it does. Two
      engines bound by `tests/unit/search-parity.test.js`.
- [x] ~~Whether a local Ollama or llama.cpp is in scope~~ — both have profiles,
      verified against a real Ollama. Still needs a CPU-baseline-safe build on
      the target; untested there.

## Phase 2 leftovers

- [ ] **The tool schemas cost 738 tokens on every turn.** Investigated: of 4,090
      characters only ~300 is repetition, so trimming descriptions would save
      perhaps 7% and risks costing more turns than it saves. The real saving
      would be sending a subset — but a task that turns out to need `write`
      after being told it has no `write` is worse than the tokens. Left alone
      deliberately; revisit with a way to add a tool mid-conversation.
- [x] ~~`session/Store`~~ — done. Append-only JSONL, `--resume`, `sessions`.
- [x] ~~`peasant run` does not persist anything~~ — it does now.
- [x] ~~Nothing prunes old sessions~~ — `Store.prune()` keeps the newest
      `PEASANT_KEEP_SESSIONS` (100), run when a session starts.
- [x] ~~The turn limit and `KEEP_RECENT` were inline constants~~ — both now in
      `preferences.js` with the reason for their values, tunable as
      `PEASANT_MAX_TURNS` and `PEASANT_KEEP_RECENT`.
- [x] ~~`EventPrinter` calls `describe()` with a fake `{ name }` object~~ —
      `describe()` takes a name now, which is all it ever wanted.
- [x] ~~The session has no multiline input~~ — a trailing `\` or an unclosed
      ``` fence continues a line.
- [x] ~~`/model` would be useful~~ — `/provider <name>` puts one first for the
      rest of the session, and gives a withdrawn provider another chance.
      Switching *model* within a provider is still a restart.
- [x] ~~Multiline input has no way to cancel a half-typed block~~ — Ctrl-C
      abandons it and returns to the prompt.
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
- [x] ~~`tool-schema.test.js`~~ — written in Phase 2 with the tools.
- [x] ~~Bind `example.env`'s base URLs to the profile defaults~~ — done, in
      `profile-coverage.test.js`.

## Phase 5 remainder

- [x] ~~MCP~~ — done, over stdio **and** Streamable HTTP. See `docs/mcp.md`.
- [x] ~~Project-level `PEASANT.md`~~ — done, plus `AGENTS.md` and a personal
      file. Capped at 8,000 characters, with the size shown.
- [x] ~~Custom slash commands~~ — done, `.peasant/commands/*.md`.
- [ ] Context files are read once at startup. Editing `PEASANT.md` mid-session
      has no effect until a restart, which will surprise someone. `/clear` is
      the natural place to re-read, since it already rebuilds the system prompt.
- [x] ~~Per-server `alwaysAllow`~~ — most servers declare `readOnlyHint` on
      nothing, so without it every query prompts.
- [ ] MCP resources and prompts. Deliberately absent for now rather than
      half-implemented; add them when something needs them.
- [ ] MCP tools are fetched once at startup. A server sending
      `notifications/tools/list_changed` is ignored.
- [x] ~~NVIDIA and Together provider profiles~~ — written, both `autoEnable:
      false` and unverified until a key exists to probe them with.

## Known limitations worth stating

- [ ] **Eliding a tool result makes the model read the file again.** Seen in a
      Groq-only run on valis: compaction elided three reads, and the model
      re-read the same three files, paying for them twice. Better than the turn
      failing, but a model that keeps re-reading what was just elided could
      loop. Worth either keeping a one-line summary of *what* a tool result
      contained, or refusing to elide a result the model has not yet responded
      to.



- [ ] **`bash` is not workspace-confined the way the file tools are.** `read`,
      `write`, `edit`, `ls`, `glob` and `grep` all resolve through
      `src/tools/paths.js` and refuse anything outside the working directory.
      `bash` runs with `cwd` set to the workspace but can write anywhere the
      user can, so `--allow-all` is genuinely "allow all". That is the honest
      behaviour for a shell and matching harnesses do the same, but it is worth
      being explicit: the confinement is a guard against accident, not a
      sandbox, and the permission prompt is the real control.
- [ ] Related: peasant editing its own repository is allowed and worked, but the
      permission prompt is the only thing between a session and its own source.

## Housekeeping

- [ ] **`npm test` takes about twenty seconds**, up from three and a half before
      MCP existed. It is not waste: the suite spawns a dozen real MCP servers,
      several real HTTP servers, runs ripgrep, and waits out a real one-second
      `bash` timeout. Measured per client: 475 ms to connect, 95 ms to close.
      Worth watching rather than fixing — a suite people stop running is worse
      than a slow one, and mocking the things that make it slow would remove
      most of what it proves.


- [x] ~~`README.md`~~ — written, every figure taken from the system.
- [x] ~~`README.md` cites counts that go stale~~ — dropped. Binding a test count
      to prose would be a test that fails for being right.
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
