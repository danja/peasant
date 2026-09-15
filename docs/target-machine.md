# The target machine

Measured 2026-09-12. Raw output preserved at `raw/2026-09-12_stage-a.txt` and
`raw/2026-09-12_probe/`; nothing here is from memory.

| | |
|---|---|
| CPU | AMD Athlon II X4 640 (K10, 2010) |
| CPU flags | `3dnowprefetch abm cx16 mmx pni popcnt sse sse2 sse4a` |
| ISA level | **x86-64-v1** |
| RAM | 14,970 MB |
| OS | Ubuntu 26.04 LTS, kernel 7.0.0-31-generic, x86_64 |
| glibc | 2.43 |
| Node | **v26.8.1** — present; passes all 14 probe checks |
| npm | 11.19.0 |
| Toolchain | gcc/g++ 15.2.0, make 4.4.1, git 2.53.0, python3 3.14.4 |
| ripgrep | 15.1.0 — present, exits 0 |
| bun / deno | absent |

## What the flags confirm

The flag list is the whole specification, so it is worth being precise about
what is *not* in it: **no `ssse3`, no `sse4_1`, no `sse4_2`, no `avx`.**

`x86-64-v2` requires `popcnt`, `sse4_1`, `sse4_2`, `ssse3` and `cx16`. This CPU
has `popcnt` (via `abm`) and `cx16` but lacks the three SSE extensions, so it
sits at **x86-64-v1** — one microarchitecture level below the floor that a great
deal of prebuilt x86-64 software now assumes, and below Bun's `x64-baseline`
build, which still needs SSE4.2
([oven-sh/bun#14745](https://github.com/oven-sh/bun/issues/14745)). That is the
whole explanation for why OpenCode and current Claude Code die here.

`sse4a` is an AMD-only extension and no portable toolchain targets it. It buys
us nothing and should not appear in any build flag.

## What this already rules in and out

- **Node works here — every major from 18 to 26, all 14 checks.** Measured, not
  assumed; see [`runtime-baseline.md`](runtime-baseline.md). The fear was zlib
  ([nodejs/node#32625](https://github.com/nodejs/node/issues/32625)) and it does
  not reproduce. AES-256-GCM passes on a CPU with neither `aes` nor `pclmulqdq`,
  which means OpenSSL's runtime dispatch is honest rather than compiled to
  assume AES-NI. **The ban on Bun is the whole of the CPU mitigation**; no other
  part of the codebase has to bend for this processor.
- **Memory is not a constraint.** 15 GB, 11 GB available. Nothing in this design
  needs to be frugal with RAM; it needs to be frugal with *tokens*.
- **A full build toolchain is present.** gcc 15.2 and make. No longer needed as
  a fallback — the probe found no fatal native path — but useful to have.
- **ripgrep 15.1.0 runs.** Rust binaries built for baseline x86-64 are fine
  here. Peasant will not *ship* a binary — that is banned — but the `grep` tool
  may prefer a system `rg` when one is on PATH and fall back to pure JS
  otherwise. See `TODO.md`; this is a design decision, not yet taken.
- **No bun, no deno**, which is exactly as it should be.

## It works

**2026-09-12: an interactive `peasant` session ran on this machine and Groq
answered.** That is the whole premise of the project demonstrated on the target
hardware — the same machine on which OpenCode and current Claude Code die with
`SIGILL` before printing anything.

Nothing had to bend for the processor beyond the rule against Bun. No V8 flags,
no build from source, no special baseline.

## Still outstanding

Nothing about the runtime. The open questions here are the terminal capability
survey (R5 — `TERM`, colour depth, unicode width, raw mode) and whether `grep`
should use the system `rg`; both are in [`../MAINTAINER.md`](../MAINTAINER.md).
