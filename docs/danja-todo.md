# Danja's list

Things needing your hands, your hardware, your accounts or your decision.
Kept current at the end of any session that changes it.

## Blocking the project

1. **Which free-tier API keys do you already have?** Groq and Mistral are the
   two named in the brief. Cerebras, OpenRouter and Google AI Studio are all
   OpenAI-compatible and cost nothing, so they widen the failover pool for free.
   `cp example.env .env` and fill in whatever you have — that file lists all
   eight known free providers with a signup link for each, and every base URL in
   it was probed on 2026-09-12 rather than recalled. Do not paste keys into chat,
   and fill in `.env`, not `example.env` (a guard test fails if a key lands in
   the committed one).

   This is now the only thing gating Phase 1 finishing — I can build and test
   the provider core against the local fake server without any key, but R2
   (recording each provider's real rate-limit headers and tool-call dialect)
   needs one key per provider.

## Decisions I need from you, not urgently

3. **Should `grep` use the system `ripgrep` when it is installed?** ripgrep
   15.1.0 already runs on the target. We would never ship a binary, but using
   one already present would be much faster on a large tree. The cost is a
   second code path that must behave identically to the pure-JS one.

4. **Is a local model in scope?** Ollama or llama.cpp on the target as a
   fallback provider would need its own CPU-baseline-safe build, and an Athlon
   II will be slow — but it would make the harness work with no network and no
   quota at all.

## Things I have asserted but not verified

- That a session is *usable* on this hardware — the probe proves Node runs, not
  that a streaming TUI feels acceptable at 3.0 GHz K10. Phase 3 finds out.

## Confirmed done

- **Added Google AI Studio and Hugging Face keys** (2026-09-12). Both work and
  are now verified profiles; six providers are configured. Both needed their
  model preferences rewritten first — Google's listed model was retired for new
  users, and the Hugging Face model chosen refused `tools` outright. Neither was
  a transport problem, and in both cases the code refused rather than guessing,
  which made each a one-line fix.
- **Added Cerebras and OpenRouter keys** (2026-09-12). OpenRouter works and is
  now a verified profile — and it turned out to be the one provider that streams
  tool calls *incrementally* rather than whole, which means the assembler's
  harder path is now tested against real bytes instead of an invented fixture.
  Cerebras is item 1 above.
- **Supplied Groq and Mistral keys** (2026-09-12), which unblocked R2. Worth
  knowing what they bought: the published free-tier figures were wrong in both
  directions. Groq is 8,000 tokens/minute, not the 6,000 every write-up quotes;
  Mistral is 625,000, where the same write-ups said only "roughly 1 req/s". See
  `docs/providers.md`. Nothing in the code was ever going to depend on those
  numbers — they are read from response headers at runtime — but the plan's
  ordering did, and it changed.
- **Ran the runtime probes on the target** (2026-09-12). This was the gate on
  everything, and the answer was better than the best case anticipated: **every
  Node major from 18 to 26 passes all fourteen checks.** Node was never the
  problem — Bun was. The floor is now `>=22.0.0`, chosen by Node's support
  schedule rather than by what survives. Results in
  `docs/runtime-baseline.md`, raw output in `docs/raw/2026-09-12_probe/`.
