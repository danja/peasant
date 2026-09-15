# TODO

What the project needs. What *the user* needs to do is `MAINTAINER.md`; an
item landing in one usually changes the other.

## Blocking

- [ ] **Confirm the `thought_signature` fix against live Gemini.** Built
      2026-09-15 and unverified against Google for one reason only: the free
      tier's request quota was exhausted by the investigation that found the bug
      (five requests a minute, and a further bucket of twenty). Everything that
      can be checked without Google has been — the signature survives assembly,
      the conversation, a transcript round trip and `buildBody`, asserted in
      `tests/unit/provider-extras.test.js` against the real captured Google
      bytes — and a second turn works live on NVIDIA and Groq, which attach no
      extras. What remains is one `peasant run` against `models/gemini-3.5-flash`
      that gets past turn two. It costs about four requests and needs a clear
      quota window.

**`claude-code` and `codex` are unverified and unusable until probed.** Added
2026-09-15 and measured in no respect: not the wire format, not the header
names, not the shape of the credential files. Both are `autoEnable: false` and
cannot be reached by accident, so this blocks only them. Everything a first run
must confirm is in `MAINTAINER.md` — it needs Danja's credentials and
spends Danja's subscription, so it cannot be done from here.

Nothing else blocks. R1 remains answered: every Node major from 18 to 26 passes
all fourteen checks on the target, and the floor is `>=22.0.0`.

## Phase R, remaining

- [ ] Decide the default model per provider. `mistral-vibe-cli-with-tools` and
      `mistral-code-latest` look purpose-built; evaluate before settling. Check
      whether `groq/compound` is a chat model or an agent wrapper with its own
      tool loop — if the latter it conflicts with ours and must be excluded.
      **Needs a comparison over real tasks, not a probe**: which model is better
      at this is a judgement about output quality, and guessing from names is
      how four of six preference lists came to be wrong.

- [ ] R4: `docs/prior-art.md`. The decision it was meant to inform — exact-string
      replace against diff-apply — was taken in Phase 2 and is working, with the
      reasoning recorded in `src/tools/edit.js`. What remains is comparative
      reading, worth doing when there is a specific question rather than as an
      exercise.

- [ ] R5: terminal capability survey on the target — `TERM`, colour depth,
      unicode width, raw mode behaviour. **Needs the target machine.** An
      interactive session has since run there successfully, so nothing is known
      to be wrong; this would tell us what is merely working by luck.

## Known dialect quirks to encode in profiles

The quirks that *have* been encoded are under "Confirmed done"; they are kept
because they record why the profile fields exist. These two are not quirks to
encode — they are things deliberately left alone, and the reason matters more
than the item.

- [ ] **Groq's window semantics are still not understood.** `limit-requests: 1000` with
      `reset-requests: 1m26.4s` reads as neither clearly per-minute nor per-day.
      Treat `remaining` as authoritative and `reset` as the earliest safe retry —
      correct under either reading. Do not guess.

- [ ] **Five of the seven hosted providers publish no rate-limit headers at
      all.** Only Groq states everything; Mistral gives limits without a reset.
      NVIDIA joined the silent five on 2026-09-15. The rest are
      discovered from 429s and 413s alone. A conservative self-imposed default
      for a silent provider would trade a little throughput for far fewer
      refusals, but any number chosen here would be exactly the kind of
      unmeasured constant this project refuses elsewhere. Left open deliberately.

## Phase 2 leftovers

- [ ] **The tool schemas cost 738 tokens on every turn.** Investigated: of 4,090
      characters only ~300 is repetition, so trimming descriptions would save
      perhaps 7% and risks costing more turns than it saves. The real saving
      would be sending a subset — but a task that turns out to need `write`
      after being told it has no `write` is worse than the tokens. Left alone
      deliberately; revisit with a way to add a tool mid-conversation.

## Phase 5 remainder

- [ ] Context files are read once at startup. Editing `PEASANT.md` mid-session
      has no effect until a restart, which will surprise someone. `/clear` is
      the natural place to re-read, since it already rebuilds the system prompt.

- [ ] MCP resources and prompts. Deliberately absent for now rather than
      half-implemented; add them when something needs them.

- [ ] MCP tools are fetched once at startup. A server sending
      `notifications/tools/list_changed` is ignored.

## Known limitations worth stating

- [ ] **Google's 429 states its retry delay only in English prose**, and
      peasant's backoff is less than half of it. Measured 2026-09-15: the body
      says "Please retry in 46.547714954s" with no `retry-after` header and no
      `x-ratelimit-*`, while `PEASANT_BACKOFF_MS` defaults to 20 s — so the
      retry lands while still exhausted and spends a request finding out. The
      free tier is **5 requests per minute** on `gemini-3.5-flash`, which is the
      first provider here where the request count runs out before the tokens do.
      Parsing a number out of an error sentence is exactly the kind of brittle
      reading this project avoids, so this may be an argument for a per-profile
      floor on the backoff rather than for a parser. Left open deliberately
      until someone decides which.

- [ ] **A provider request has no timeout, so a silent provider hangs peasant
      indefinitely.** Measured 2026-09-15 against Google: of three streaming
      requests to `models/gemini-3.8-flash`, two returned 503 in about a second
      and the third accepted the connection and sent nothing for 90 seconds,
      when the client gave up only because the probe imposed its own deadline.
      `peasant ask` has no deadline, and hung past 120 s. Nothing in
      `src/provider/`, `src/agent/` or `src/cli/` sets one — the only
      `setTimeout` on that path is the router's own `#sleep`. Today's
      `PEASANT_TOOL_CHECK_TIMEOUT_MS` covers `doctor` alone. A request timeout
      wants to be a preference like the rest, and it interacts with streaming:
      the deadline should be to *first token*, not to completion, or a long
      legitimate answer gets killed at the finish line.

- [ ] **A 503 retires the provider when only one of its models is unwell.**
      `selectModel` chooses a model once, at connect time, and nothing revisits
      it. `classify()` maps 503 to `server-error`, which is retryable, so the
      router moves to the next *provider* — never to the next model on the same
      one. Measured 2026-09-15: `models/gemini-3.8-flash` served 2 of 5
      requests, while `models/gemini-3.5-flash` and `models/gemini-3.5-flash-lite`
      served 5 of 5 each. With `PEASANT_PROVIDERS=google` alone there is nowhere
      to rotate to, so the session fails with two healthy models sitting in the
      same profile's `prefer` list, one entry further down. The list already
      holds the alternatives; only availability is missing, and a 503 is exactly
      the provider telling us.

- [ ] **NVIDIA gives the budgeter nothing on either axis, so compaction never
      fires there.** Measured 2026-09-15: its `/v1/models` entries carry only
      `id`, `object`, `created` and `owned_by` — no context-window field for
      `windowOf()` to find — and no response carries a `*-ratelimit-*` header.
      `ContextBudget.limitFor()` returns null when both are null, and
      `shouldCompact()` returns false on a null limit, by design: "unknown" must
      not mean "refuse to send". The consequence is that on NVIDIA a
      conversation grows until the provider refuses it, with no compaction on
      the way. Anthropic hit half of this and was fixed by teaching `windowOf()`
      the field name; there is no field name to learn here. Options are a
      `contextWindow` in the profile (a hardcoded window, which this project
      refuses) or learning the ceiling from the first refusal, the way the Groq
      413 already teaches the limiter. Not urgent — nothing has failed yet — but
      it is a silent failure when it comes.

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

## Dialects

- [ ] **No capture stands behind either new dialect.** `tests/unit/dialects.test.js`
      proves the translation is self-consistent and that the client drives it. It
      cannot prove the shape is the shape those endpoints actually send. Record a
      capture under `docs/raw/` the first time one answers, and only then may
      `verified: true` go into a profile.

- [ ] **`bin/probe-providers.js` speaks only chat-completions.** It builds raw
      requests on purpose — that is its job — but it means the two new providers
      cannot be probed with the tool that exists for probing providers, which is
      precisely when one is most wanted. Teach it the dialect, or write the
      capture by hand and say so.

- [ ] **Neither new provider can refresh its token.** Deliberate: refreshing
      rotates it, and rotating another program's login from underneath it loses
      both. If this becomes tiresome the answer is a cached token in
      `~/.peasant/`, never a write to the other tool's file.

- [ ] **A guard for reads of undeclared profile fields.** A field renamed in
      `generic.js` while a dialect went on reading the old name sent a header as
      `undefined` (`MISTAKES.md`, 2026-09-15). One occurrence is a mistake; a
      second would mean the structure, not the reader, is wrong.

## From the harness-design reading

Source: `docs/entries/2026-09-15_claude_harness-design-reading.md`, on
<https://www.anthropic.com/engineering/harness-design-long-running-apps>. Most of
that article is priced out of this project — its headline is 20x cost for 20x
quality, which is the axis peasant exists to refuse. The reasoning for what was
taken and what was rejected is in the entry; these are the actions.

**H1 blocks H2 and H4.** All three are claims about behaviour, and CLAUDE.md
already requires that budget changes be measured rather than asserted — so the
thing to build first is the way to measure.

- [ ] **H1. Write `bin/measure-task.js`: one fixed task, run repeatably, numbers
      out.** Three items below need the same protocol, and CLAUDE.md already
      prescribes it ("record tokens used, turns and wall time for a fixed task in
      `docs/entries/`") without anything existing to do it with. A manual
      protocol needed three times is a script.
      - Takes a task prompt file, a provider, and a repeat count.
      - Runs the agent loop headless, as `peasant run` does, in a scratch copy
        of a fixture workspace so each run starts identically.
      - Emits per run: prompt/completion/reasoning tokens (from `usage`, not
        estimated), turn count, wall time, whether it hit `maxTurns`, and
        whether the task's own check passed.
      - Writes a markdown table fit to paste into `docs/entries/`.
      - Fixture task should have a machine-checkable outcome — a failing test in
        a small repo that the agent must make pass — so "finished" is not a
        judgement call.
      - **Not** part of `npm test`: it spends real tokens against a real
        provider, so it is run deliberately, like `test:live`.
      - Done when two runs of the same task on the same provider produce numbers
        close enough to tell a 20% difference from noise.

- [ ] **H2. Measure what "Token budget is tight" costs.** *Blocked on H1.*
      `src/agent/prompt.js` resends that sentence on every turn;
      `Compactor.js:164` injects `[N earlier messages dropped...]`; `Tool.js:89`
      marks every truncated tool result. The article names the failure mode this
      invites — **context anxiety**, models wrapping up prematurely because they
      believe they are running out of room — and peasant emits that signal
      harder than any harness in it.
      - Run the H1 task on the same provider, n≥5 each, under three prompts:
        the sentence as it stands; the sentence removed; the sentence replaced
        with a neutral economy instruction that does not mention scarcity
        (e.g. "Read narrow windows of files rather than whole ones.").
      - Compare completion rate first, tokens second. The hypothesis is that
        the current wording finishes fewer tasks while saving few enough tokens
        not to matter.
      - Whatever the result, record it in `docs/entries/` and put the winning
        wording in `prompt.js` with the measurement cited in a comment — the
        system prompt is 132 measured tokens and every line in it is load-bearing
        or should go.

- [ ] **H3. Prototype compaction-by-reset against the current compactor.**
      `Compactor` keeps the summary *and* the recent turns and pays for both on
      every turn after; a reset writes a handoff file and pays for it once, when
      it is read. On an 8,000 TPM budget that inverts the article's economics,
      where reset was the expensive option.
      - `session/Store` already writes a `reset` record, so the transcript
        format anticipates this — check what it currently writes before adding
        anything.
      - Write the handoff to `~/.peasant/`, never the workspace: a file that
        appears in somebody's repository mid-task is a bug report.
      - Keep it behind a preference so both paths can be run by H1 on the same
        task, rather than replacing the compactor on the strength of an argument.
      - Done when the two are compared on one task with numbers recorded; if
        reset does not win, say so in the entry and keep the compactor.

- [ ] **H4. Nothing checks the model's claim that it is finished.** *Blocked on
      H1.* The loop ends when the model says it is done, and the article is
      convincing that agents confidently praise their own work. A separate
      evaluator agent is unaffordable here at any token price; the affordable
      version is a sentence.
      - Try adding to the system prompt: before declaring a task done, run the
        project's tests with `bash` and read the output.
      - Measure with H1's machine-checkable fixture, which already distinguishes
        "said it was done" from "was done" — that gap is the whole measurement.
      - Weigh it against the cost: extra turns and a full test run's output
        through `maxToolResultChars`, on a budget where one careless read costs
        most of a minute. It may not be affordable either, and that is a result.

## Housekeeping

- [ ] **`tests/compat/` and `tests/live/` are empty directories, and every guard
      passes anyway.** Found 2026-09-15 while running the suites after the
      tool-check work; both have been empty since 2026-09-12. CLAUDE.md
      describes three suites and says what the other two do — the compat suite
      runs "the runtime probe, runnable against any Node on PATH", the live one
      "asserts that the dialect still matches the profiles, with the smallest
      prompts that can prove it". Neither contains a file. `npm run test:compat`
      reports `tests 0` and exits 0, which reads as success.
      `suite-coverage.test.js` checks that each directory is named by a script,
      that each script's directory exists, and that the suites are disjoint — it
      never asks whether a suite contains a test, so an empty one satisfies it
      perfectly. This is the documented failure mode of the project's own
      "prose is a claim" rule, and the fix is two things that should land
      together: a guard asserting a named suite holds at least one `*.test.js`,
      and the tests to satisfy it. **Adding the guard first turns `npm test`
      red**, so it is a decision rather than a tidy-up — hence this entry rather
      than a commit.

- [ ] **`npm test` takes between 3.5 and 4.1 seconds** — three consecutive runs
      on 2026-09-15 gave 4.13s, 3.52s and 3.71s over 531 tests, against 3.9s for
      490 tests before the dialect work. This entry previously claimed twenty
      seconds, which was wrong by a factor of five and is exactly the kind of
      prose nothing tests. It is not waste: the suite spawns a dozen real MCP servers,
      several real HTTP servers, runs ripgrep, and waits out a real one-second
      `bash` timeout. Measured per client: 475 ms to connect, 95 ms to close.
      Worth watching rather than fixing — a suite people stop running is worse
      than a slow one, and mocking the things that make it slow would remove
      most of what it proves.

- [ ] Extend the tool-call check to the models a provider *offers*, not only the
      one selected. `peasant doctor` now checks the selection
      (`src/provider/tool-check.js`); a `peasant models --check` that flagged
      every candidate would turn "preference lists go stale" below from a
      periodic chore into an answer. Costs one call per model, so it cannot be
      on by default the way doctor's single check is.

- [ ] Preference lists go stale: four of six were written from documentation and
      four of six were wrong (`docs/providers.md`). Worth a periodic re-probe,
      and possibly a `peasant models --check` that flags a profile whose
      preferences no longer match anything.

- [ ] Revisit the Node floor when v22 reaches end of life, 2027-04-30.

## Confirmed done

Struck rather than deleted, per CLAUDE.md: several of these record *why* a
field or a guard exists, and that reasoning is the part worth keeping. Grouped
by the section each came from.

### Phase R, remaining

- [x] ~~R1: runtime baseline~~ — done 2026-09-12. Node was never the problem;
      Bun was. See `docs/runtime-baseline.md`.

- [x] ~~R2: probe the providers~~ — done 2026-09-12 for **Groq and Mistral**,
      the two with accounts. `bin/probe-providers.js` exists; findings in
      `docs/providers.md`, evidence in `docs/raw/2026-09-12_providers/`.
      Re-run it when a key is added for any of the other six.

- [x] ~~R2 remainder: the 429 body~~ — observed on Mistral, 2026-09-12. Empty
      body, no `retry-after`, and `x-ratelimit-limit-req-minute: 0`. Recorded in
      `docs/providers.md`; the zero-limit case now has a test.

- [x] ~~R3: catalogue tool-calling dialect differences~~ — both shapes are
      captured and both are tested. Groq, Mistral and Google send a tool call
      whole in one delta; OpenRouter and Hugging Face dribble the arguments.
      `tests/unit/tool-call-assembler.test.js` asserts both remain represented,
      so half the assembler cannot quietly become untested.

- [x] ~~R6: pure-JS token estimation~~ — done. `bin/probe-tokens.js` measured the
      constants against a live provider; `TokenEstimator` calibrates against
      `usage.prompt_tokens` on every response and settled at 0.90 in a real
      session. See `docs/providers.md`.

### Known dialect quirks to encode in profiles

- [x] **Groq reset headers are duration strings** (`1m26.4s`, `644ms`), not
      seconds or timestamps. Needs a parser, with both forms tested.

- [x] **Mistral publishes no reset header.** The window is implied by the header
      name (`-minute`) and nothing states when it rolls, so its budget must be
      inferred and therefore held more conservatively than Groq's.

- [x] **`delta.reasoning` with `channel: "analysis"`** on Groq's gpt-oss models
      is not `delta.content` and must never be rendered as assistant output — but
      it *does* consume budget. 22 of 24 completion tokens in the probe were
      reasoning tokens. `TokenEstimator` must read
      `usage.completion_tokens_details.reasoning_tokens`.

- [x] Filter non-chat models out of selection — `NON_CHAT` in
      `src/provider/profiles/generic.js`.

### Design decisions not yet taken

- [x] ~~Should `grep` prefer a system `ripgrep`?~~ — yes, and it does. Two
      engines bound by `tests/unit/search-parity.test.js`.

- [x] ~~Whether a local Ollama or llama.cpp is in scope~~ — both have profiles,
      verified against a real Ollama. Still needs a CPU-baseline-safe build on
      the target; untested there.

### Phase 2 leftovers

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

### Guards

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

### Phase 5 remainder

- [x] ~~MCP~~ — done, over stdio **and** Streamable HTTP. See `docs/mcp.md`.

- [x] ~~Project-level `PEASANT.md`~~ — done, plus `AGENTS.md` and a personal
      file. Capped at 8,000 characters, with the size shown.

- [x] ~~Custom slash commands~~ — done, `.peasant/commands/*.md`.

- [x] ~~Per-server `alwaysAllow`~~ — most servers declare `readOnlyHint` on
      nothing, so without it every query prompts.

- [x] ~~NVIDIA and Together provider profiles~~ — written, both `autoEnable:
      false` and unverified until a key exists to probe them with. NVIDIA was
      probed on 2026-09-15 and is now `verified: true`; its `prefer` list had
      been selecting a content-safety classifier as the chat model, and its
      catalogue needs `unavailableWhen` because most listed models 404 for the
      account. Together remains unverified — no key.

### Dialects

- [x] ~~A second and third wire format~~ — `src/provider/dialects/`, one file
      per format, named after the format and never the vendor. The client kept
      transport, budget and failure classification; the format came out.
      `tests/guard/dialect-coverage.test.js` binds the list to the directory.

### Housekeeping

- [x] ~~`README.md`~~ — written, every figure taken from the system.

- [x] ~~`README.md` cites counts that go stale~~ — dropped. Binding a test count
      to prose would be a test that fails for being right.

- [x] ~~`bin/peasant.js` does not exist~~ — it does now.

- [x] ~~inline tunables~~ — `src/config/preferences.js` now holds every one with
      the reason for its value, read from `PEASANT_*` and refusing a value it
      cannot parse. `estimate()` in `bin/peasant.js` is still crude and is
      replaced by `TokenEstimator` in Phase 4.
