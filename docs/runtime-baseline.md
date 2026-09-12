# Runtime baseline

<!-- baseline:engines >=22.0.0 -->
<!-- baseline:status MEASURED -->

Which Node builds run on the target CPU. This is the most load-bearing fact in
the project: the architecture in `docs/architecture.md` assumes a floor, and the
floor is a measurement, not a preference.

`tests/guard/engines.test.js` binds `package.json`'s `engines.node` to the
`baseline:engines` marker above. **Change this document first, then the
manifest** — the marker is the source of truth because it is where a measurement
lands.

## The verdict

**Node is not the problem. It never was.** Every Node major from 18 to 26 passes
all fourteen probe checks on the target — an AMD Athlon II X4 640 at
`x86-64-v1`. Measured 2026-09-12; raw output in
[`raw/2026-09-12_probe/`](raw/2026-09-12_probe/).

| Date | Machine | ISA | Node | Result |
|---|---|---|---|---|
| 2026-09-12 | target, Athlon II X4 640 | x86-64-v1 | v26.8.1 (installed) | 14/14 pass |
| 2026-09-12 | target, Athlon II X4 640 | x86-64-v1 | v26.8.2 | 14/14 pass |
| 2026-09-12 | target, Athlon II X4 640 | x86-64-v1 | v24.21.0 | 14/14 pass |
| 2026-09-12 | target, Athlon II X4 640 | x86-64-v1 | v22.23.2 | 14/14 pass |
| 2026-09-12 | target, Athlon II X4 640 | x86-64-v1 | v20.20.2 | 14/14 pass |
| 2026-09-12 | target, Athlon II X4 640 | x86-64-v1 | v18.20.8 | 14/14 pass |
| 2026-09-12 | dev box, i7-3770 | x86-64-v2 | v25.2.1 | 14/14 pass |

The checks: startup, TurboFan on a hot loop, irregexp codegen, zlib, brotli,
OpenSSL SHA-256, AES-256-GCM, EC keygen, WebAssembly compile-and-call, Atomics
over a SharedArrayBuffer, worker spawn, ICU, a live HTTPS fetch, and readline.

Two results are worth naming individually, because they were the specific fears:

- **zlib passes.** [nodejs/node#32625](https://github.com/nodejs/node/issues/32625)
  implicated zlib in the K10 SIGILL reports, and a native failure is the one kind
  no V8 flag can rescue. It does not reproduce on any tested major.
- **AES-256-GCM passes on a CPU with neither `aes` nor `pclmulqdq`.** OpenSSL's
  runtime dispatch is honest here; it is not compiled to assume AES-NI.

## Why this was in doubt

The target is an **Athlon II** (AMD K10): SSE, SSE2, SSE3, SSE4a and
POPCNT/LZCNT via ABM, and nothing above. No SSSE3, SSE4.1, SSE4.2 or AVX. That
is **x86-64-v1** — below the `x86-64-v2` baseline a great deal of prebuilt
software now assumes, which is why OpenCode and current Claude Code die here:

- Bun's `x64-baseline` build still requires SSE4.2 — [oven-sh/bun#14745](https://github.com/oven-sh/bun/issues/14745).
- Both ship as Bun-compiled binaries.
- Claude Code [#85571](https://github.com/anthropics/claude-code/issues/85571) is
  the controlled experiment: on a Xeon Harpertown (SSE4.1, no SSE4.2) the Bun
  binary dies with `SIGILL` while the last pre-Bun npm release runs fine under
  plain `node cli.js`.

The probe now confirms the other half of that experiment directly. **The rule in
`CLAUDE.md` against Bun is the whole of the CPU mitigation**; nothing else in the
codebase has to bend for the Athlon II.

## Why the floor is 22 and not 18

Every tested major works, so the floor is not set by what survives — it is set by
what is still supported and what the standard library offers. From the
[Node release schedule](https://github.com/nodejs/Release), against today:

| Line | Status on 2026-09-12 | EOL |
|---|---|---|
| v18 | **end of life** | 2025-04-30 |
| v20 | **end of life** | 2026-04-30 |
| v22 | maintenance LTS | 2027-04-30 |
| v24 | active LTS | 2028-04-30 |
| v26 | current | 2029-04-30 |

v22 is the oldest line still receiving security fixes, so it is the floor. It
also carries three things a zero-dependency project would otherwise hand-write
or forgo: `fs.glob`, a stable `node:test`, and glob patterns for `node --test`
(21+) — which the npm scripts here already use.

The target runs v26.8.1, so this costs nothing there. Revisit when v22 reaches
end of life in April 2027.

## How to re-measure

```sh
node bin/probe-runtime.js                 # the running node
node bin/probe-runtime.js --node /path    # some other binary
./bin/probe-node-matrix.sh                # official builds, 18 through 26
```

Each check runs in its own child process, because a `SIGILL` kills the process
and an in-process `try/catch` cannot report what was fatal. When a check dies on
a signal and the code involved is JavaScript rather than native, the probe
retries it under `--no-opt`, `--jitless` and `--jitless --single-threaded` and
reports which — if any — rescues it. A native failure is reported as
unrescuable, because it is.
