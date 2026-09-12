# Runtime baseline

<!-- baseline:engines >=18.0.0 -->
<!-- baseline:status PENDING -->

Which Node builds actually run on the target CPU. This is the most load-bearing
fact in the project: the architecture in `docs/architecture.md` assumes a floor,
and the floor is a measurement, not a preference.

`tests/guard/engines.test.js` binds `package.json`'s `engines.node` to the
`baseline:engines` marker above. **Change this document first, then the
manifest** — the marker is the source of truth because it is where a measurement
lands.

Status is `PENDING` until the matrix has been run on the target machine. The
current `>=18.0.0` is a placeholder chosen because `fetch`, `node:test` and
`AbortSignal.timeout` all need it — it is not yet a measured claim.

## Why this document exists

The target is an **Athlon II** (AMD K10). It has SSE, SSE2, SSE3, SSE4a and
POPCNT/LZCNT via ABM. It does **not** have SSSE3, SSE4.1, SSE4.2, AVX or
anything above. That places it at **x86-64-v1** — below the `x86-64-v2` baseline
that a great deal of prebuilt software now assumes.

This is why OpenCode and current Claude Code crash on it, and the cause is
specific and known:

- Bun's `x64-baseline` build still requires SSE4.2 — [oven-sh/bun#14745](https://github.com/oven-sh/bun/issues/14745).
- Both ship as Bun-compiled binaries.
- Claude Code [#85571](https://github.com/anthropics/claude-code/issues/85571) is
  the controlled experiment: on a Xeon Harpertown (SSE4.1, no SSE4.2) the Bun
  binary dies with `SIGILL`, while the last pre-Bun npm release runs fine under
  plain `node cli.js`.

So the crash is Bun's, not Node's. But Node is not unconditionally safe either:
[nodejs/node#48700](https://github.com/nodejs/node/issues/48700) was closed *not
planned*, and [#32625](https://github.com/nodejs/node/issues/32625) reports
`SIGILL` on K10-era AMD with **zlib** implicated — a native path no V8 flag can
rescue.

## How to measure it

On the target machine:

```sh
./bin/probe-node-matrix.sh          # downloads Node 18/20/22/24/26, probes each
```

or, against one binary already installed:

```sh
node bin/probe-runtime.js
node bin/probe-runtime.js --node /path/to/other/node
```

Each check runs in its own child process, because a `SIGILL` kills the process
and an in-process `try/catch` cannot report what was fatal. When a check dies on
a signal and the code involved is JavaScript rather than native, the probe
retries it under `--no-opt`, `--jitless` and `--jitless --single-threaded`, and
reports which — if any — rescues it. A native failure is reported as
unrescuable, because it is.

## Results

Re-measured, not remembered. One row per Node major per machine, newest first.

| Date | Machine | ISA | Node | Verdict | Notes |
|---|---|---|---|---|---|
| 2026-09-12 | target, Athlon II X4 640 | x86-64-v1 | v26.8.1 | **starts** — full probe not yet run | Stage A only; see `target-machine.md` |
| 2026-09-12 | dev box, i7-3770 | x86-64-v2 | v25.2.1 | all 14 checks pass | not the target; recorded only to prove the probe reports correctly |

Stage A has been run on the target and is written up in
[`target-machine.md`](target-machine.md): **AMD Athlon II X4 640, x86-64-v1,
Ubuntu 26.04, Node v26.8.1 installed and starting.** That Node loads at all is a
much better starting point than this document originally anticipated.

**It is not yet a verdict.** `node --version` exercises none of the JIT, zlib,
OpenSSL or WebAssembly paths that every reported SIGILL came from, and a build
that starts and then dies mid-session is the failure this probe exists to
prevent. `baseline:status` stays `PENDING` until `bin/probe-runtime.js` has run
on the target.

## What the answer changes

- **A recent major passes cleanly** — that becomes the floor, `engines` and the
  marker above are updated, status goes to `MEASURED`. Best case, and the one
  the Claude Code issue suggests is likely.
- **Only older majors pass** — the floor drops and every standard-library API
  used has to be checked against it. `fs.glob` is Node 22; `node:test` is 18;
  `AbortSignal.timeout` is 17.3. Expect to hand-write more.
- **A V8 flag is required** — record the exact flag set here, and have
  `src/compat/Preflight.js` refuse to start without it rather than let a session
  die forty seconds in.
- **Nothing official passes** — build Node from source on the target
  (`--without-node-snapshot`, shared zlib are the first things to try), or pin
  the last release that predates the regression. This is a real possibility and
  the plan does not pretend otherwise.
