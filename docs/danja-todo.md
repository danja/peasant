# Danja's list

Things needing your hands, your hardware, your accounts or your decision.
Kept current at the end of any session that changes it.

## Blocking the project

1. **Run the full probe on the target machine.** This is the one thing standing
   between the plan and Phase 1.

   ```sh
   cd /path/to/peasant && git pull      # or copy bin/probe-runtime.js across
   node bin/probe-runtime.js
   ```

   It takes well under a minute. Each check runs in its own process, so if
   something dies the output names which check and whether a V8 flag rescues it.
   Paste the output back.

   If you would rather also test other Node majors:
   `./bin/probe-node-matrix.sh` — downloads official builds for 18/20/22/24/26
   into `/tmp` and probes each. Only worth it if v26 fails something.

2. **Which free-tier API keys do you already have?** Groq and Mistral are the
   two named in the brief. Cerebras, OpenRouter and Google AI Studio are all
   OpenAI-compatible and cost nothing, so they widen the failover pool for free.
   Keys go in `.env`, which is gitignored; do not paste them into chat.

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

- That Node v26.8.1 **works** on the target. What is actually measured is that
  it *starts*. Item 1 is what turns one into the other.
- Every free-tier rate limit quoted in `CLAUDE.md` and `docs/plan.md` comes from
  published documentation, not from a response header this project has seen.
  Item 2 and `bin/probe-providers.js` are what fix that.

## Confirmed done

- *(nothing yet)*
