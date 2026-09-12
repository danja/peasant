# The target machine

Measured 2026-09-12 by the Stage A probe. Raw output preserved at
`raw/2026-09-12_stage-a.txt`; nothing here is from memory.

| | |
|---|---|
| CPU | AMD Athlon II X4 640 (K10, 2010) |
| CPU flags | `3dnowprefetch abm cx16 mmx pni popcnt sse sse2 sse4a` |
| ISA level | **x86-64-v1** |
| RAM | 14,970 MB |
| OS | Ubuntu 26.04 LTS, kernel 7.0.0-31-generic, x86_64 |
| glibc | 2.43 |
| Node | **v26.8.1** — present, and `node --version` exits 0 |
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

- **Node 26 starts.** That is a genuinely good result — far better than the
  worst case in `runtime-baseline.md`, which anticipated having to build from
  source. It is *not yet* a verdict: `node --version` exercises none of the JIT,
  zlib, OpenSSL or WebAssembly paths that the reported SIGILLs came from. The
  full probe is still the gate.
- **Memory is not a constraint.** 15 GB, 11 GB available. Nothing in this design
  needs to be frugal with RAM; it needs to be frugal with *tokens*.
- **A full build toolchain is present.** gcc 15.2 and make mean building Node
  from source on this machine is available as a fallback if the probe finds a
  fatal native path.
- **ripgrep 15.1.0 runs.** Rust binaries built for baseline x86-64 are fine
  here. Peasant will not *ship* a binary — that is banned — but the `grep` tool
  may prefer a system `rg` when one is on PATH and fall back to pure JS
  otherwise. See `TODO.md`; this is a design decision, not yet taken.
- **No bun, no deno**, which is exactly as it should be.

## Still outstanding

`node bin/probe-runtime.js` has not been run here. Until it has, the claim
"Node 26 works on this machine" means only that the binary loads.
