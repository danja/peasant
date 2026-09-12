# TODO

What the project needs. What *the user* needs to do is `docs/danja-todo.md`; an
item landing in one usually changes the other.

## Blocking

- [ ] **R1: run `node bin/probe-runtime.js` on the target machine.** Node
      v26.8.1 is installed there and starts, but starting is not surviving —
      every reported SIGILL in this class came from JIT, zlib, OpenSSL or
      WebAssembly, none of which `node --version` touches. Until this runs,
      `docs/runtime-baseline.md` stays `PENDING` and the Node floor is a guess.
- [ ] Once measured: set `baseline:engines` in `docs/runtime-baseline.md`, then
      `engines.node` in `package.json`, in that order. `engines.test.js` enforces
      that they agree; the document is the source of truth because it is where
      the measurement lands.

## Phase R, remaining

- [ ] R2: write `bin/probe-providers.js` and run it against whichever keys exist.
      Record real rate-limit header names, tool-calling fidelity, streaming
      tool-call shape, `stream_options.include_usage` support, and the 429 body.
- [ ] R3: catalogue tool-calling dialect differences, one fixture per case.
- [ ] R4: read OpenCode, Codex CLI and Claude Code's pre-Bun npm package; write
      `docs/prior-art.md`. Decide the file-editing strategy there — exact-string
      replace against diff-apply. Exact-string replace is cheaper in tokens,
      which matters more here than usual.
- [ ] R5: terminal capability survey on the target — `TERM`, colour depth,
      unicode width, raw mode behaviour.
- [ ] R6: pure-JS token estimation calibrated against reported `usage`, with its
      error measured. No tokeniser package: WASM and BPE tables are both banned.

## Design decisions not yet taken

- [ ] **Should the `grep` tool prefer a system `ripgrep`?** ripgrep 15.1.0 runs
      on the target, so Rust baseline x86-64 binaries are fine there. Peasant
      must not *ship* a binary, but using one already on PATH breaks no rule and
      would be much faster than pure JS on a large tree. The cost is two code
      paths to keep behaviourally identical — and if they diverge, a guard test
      must be what notices.
- [ ] Whether a local Ollama or llama.cpp on the target is in scope as a
      fallback provider. It would need a CPU-baseline-safe build of its own.

## Guards still to write (each named in CLAUDE.md's table)

- [ ] `profile-coverage.test.js` — every provider profile is registered and has a
      fixture; no provider-specific branching outside `src/provider/profiles/`.
- [ ] A grep guard against hardcoded rate limits and context windows.
- [ ] `no-raw-stdout.test.js` — nothing outside `src/ui/` writes to stdout.
- [ ] `tool-schema.test.js` — a tool's advertised schema is the one that validates.

## Housekeeping

- [ ] `README.md` still says only "an LLM harness for the poor". Rewrite when
      there is something to describe, and measure every figure in it.
- [ ] `bin/peasant.js` does not exist yet; `package.json` `bin` points at it.
      Harmless until publish, fatal at publish.
