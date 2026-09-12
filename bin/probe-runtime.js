#!/usr/bin/env node
// Peasant runtime probe.
//
// Answers one question: does this Node build actually run on this CPU?
//
// A SIGILL kills the process, so an in-process try/catch cannot report which
// feature was fatal. Every check therefore runs in its own child process; the
// parent reads the exit signal and names the culprit. Where a check dies, the
// parent retries it under candidate V8 flags and reports which, if any, rescue
// it -- that is the difference between "Node does not work here" and "Node
// works here with NODE_OPTIONS=--jitless".
//
// Usage:
//   node bin/probe-runtime.js                 probe the running node
//   node bin/probe-runtime.js --node PATH     probe another node binary
//   node bin/probe-runtime.js --json          machine-readable output
//   node bin/probe-runtime.js --one NAME      run a single check in-process

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';

const SELF = fileURLToPath(import.meta.url);

// V8 flag sets tried, in order, against a check that failed. Native failures
// (zlib, OpenSSL) are not rescuable this way and are reported as such.
const MITIGATIONS = [
  ['--no-opt'],
  ['--jitless'],
  ['--jitless', '--single-threaded'],
];

// Each check must be self-contained: it runs in a fresh process with no shared
// state. Returning a value proves the work was not optimised away.
const CHECKS = {
  startup: {
    what: 'the binary runs at all',
    native: false,
    run: () => process.version,
  },

  jit: {
    what: 'TurboFan optimising a hot loop',
    native: false,
    run: () => {
      let s = 0;
      for (let i = 0; i < 2e7; i++) s = (s + Math.imul(i, 3) ^ (i >>> 2)) | 0;
      return s;
    },
  },

  regexp: {
    // V8 JIT-compiles regexps through irregexp, a codegen path separate from
    // TurboFan. A build can survive `jit` and die here.
    what: 'irregexp codegen',
    native: false,
    run: () => {
      const re = /^(\w+)[-:](\d+)(?:\.(\d+))?$/;
      let n = 0;
      for (let i = 0; i < 2e5; i++) if (re.exec(`tok-${i}.${i % 7}`)) n++;
      return n;
    },
  },

  zlib: {
    // CRC32 dispatches to PCLMULQDQ/SSE4.2 where available. nodejs/node#32625
    // implicated zlib in the K10 SIGILL reports specifically.
    what: 'zlib gzip/gunzip (CRC32 dispatch)',
    native: true,
    run: async () => {
      const z = await import('node:zlib');
      const src = Buffer.alloc(1 << 21, 0x5a);
      const gz = z.gzipSync(src);
      if (!z.gunzipSync(gz).equals(src)) throw new Error('roundtrip mismatch');
      return gz.length;
    },
  },

  brotli: {
    what: 'brotli compress/decompress',
    native: true,
    run: async () => {
      const z = await import('node:zlib');
      const src = Buffer.alloc(1 << 18, 0x21);
      return z.brotliDecompressSync(z.brotliCompressSync(src)).length;
    },
  },

  'crypto-hash': {
    what: 'OpenSSL SHA-256',
    native: true,
    run: async () => {
      const c = await import('node:crypto');
      let h = Buffer.alloc(32);
      for (let i = 0; i < 2000; i++) h = c.createHash('sha256').update(h).digest();
      return h.toString('hex').slice(0, 12);
    },
  },

  'crypto-aes': {
    // AES-GCM dispatches to AES-NI + PCLMULQDQ. K10 has neither, so this is a
    // direct test of whether OpenSSL's runtime dispatch is honest.
    what: 'OpenSSL AES-256-GCM',
    native: true,
    run: async () => {
      const c = await import('node:crypto');
      const key = c.randomBytes(32), iv = c.randomBytes(12);
      const enc = c.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([enc.update(Buffer.alloc(1 << 16, 9)), enc.final()]);
      const dec = c.createDecipheriv('aes-256-gcm', key, iv);
      dec.setAuthTag(enc.getAuthTag());
      return Buffer.concat([dec.update(ct), dec.final()]).length;
    },
  },

  'crypto-ec': {
    what: 'elliptic curve keygen (TLS handshake path)',
    native: true,
    run: async () => {
      const c = await import('node:crypto');
      const a = c.createECDH('prime256v1'); a.generateKeys();
      const b = c.createECDH('prime256v1'); b.generateKeys();
      return a.computeSecret(b.getPublicKey()).length;
    },
  },

  wasm: {
    // Liftoff is a third codegen backend. (module (func (export "a")
    // (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
    what: 'WebAssembly compile + call',
    native: false,
    run: () => {
      const bytes = new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0,
        1, 7, 1, 96, 2, 127, 127, 1, 127,
        3, 2, 1, 0,
        7, 5, 1, 1, 97, 0, 0,
        10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11,
      ]);
      const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes));
      const r = inst.exports.a(2, 3);
      if (r !== 5) throw new Error(`wasm returned ${r}`);
      return r;
    },
  },

  atomics: {
    what: 'SharedArrayBuffer + Atomics',
    native: false,
    run: () => {
      const a = new Int32Array(new SharedArrayBuffer(16));
      for (let i = 0; i < 1000; i++) Atomics.add(a, 0, 1);
      return Atomics.load(a, 0);
    },
  },

  worker: {
    what: 'worker_threads spawn and message',
    native: false,
    run: async () => {
      const { Worker } = await import('node:worker_threads');
      const w = new Worker('require("worker_threads").parentPort.postMessage(41+1)', { eval: true });
      const v = await new Promise((res, rej) => {
        w.on('message', res);
        w.on('error', rej);
        w.on('exit', (c) => rej(new Error(`worker exited ${c}`)));
      });
      await w.terminate();
      return v;
    },
  },

  intl: {
    what: 'ICU / Intl',
    native: true,
    run: () => new Intl.NumberFormat('de-DE').format(1234.5),
  },

  tls: {
    // The real end-to-end check: undici + llhttp + OpenSSL against a live host.
    what: 'HTTPS fetch (undici + TLS)',
    native: true,
    run: async () => {
      const r = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { authorization: 'Bearer probe' },
        signal: AbortSignal.timeout(20000),
      });
      await r.text();
      return `HTTP ${r.status}`;
    },
  },

  readline: {
    what: 'readline + tty (the UI depends on this)',
    native: false,
    run: async () => {
      const rl = await import('node:readline');
      const i = rl.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      i.close();
      return `tty=${Boolean(process.stdout.isTTY)}`;
    },
  },
};

const NAMES = Object.keys(CHECKS);

async function runOne(name) {
  const check = CHECKS[name];
  if (!check) { process.stderr.write(`unknown check: ${name}\n`); process.exit(64); }
  const value = await check.run();
  process.stdout.write(`OK ${String(value)}\n`);
}

function attempt(nodeBin, name, flags) {
  const r = spawnSync(nodeBin, [...flags, SELF, '--one', name], {
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) return { ok: false, how: 'spawn', detail: r.error.message };
  if (r.signal) return { ok: false, how: 'signal', detail: r.signal };
  if (r.status !== 0) {
    const msg = (r.stderr || '').trim().split('\n').filter(Boolean).pop() || `exit ${r.status}`;
    return { ok: false, how: 'error', detail: msg.slice(0, 160) };
  }
  return { ok: true, detail: (r.stdout || '').trim().replace(/^OK /, '') };
}

function cpuFlags() {
  try {
    const line = fs.readFileSync('/proc/cpuinfo', 'utf8').split('\n').find((l) => l.startsWith('flags'));
    if (!line) return null;
    const all = new Set(line.split(':')[1].trim().split(/\s+/));
    const interesting = ['mmx', 'sse', 'sse2', 'pni', 'ssse3', 'sse4_1', 'sse4_2', 'sse4a',
      'avx', 'avx2', 'popcnt', 'abm', 'lzcnt', 'bmi1', 'bmi2', 'fma', 'f16c',
      'aes', 'pclmulqdq', 'movbe', 'cx16', 'xsave'];
    return { have: interesting.filter((f) => all.has(f)), missing: interesting.filter((f) => !all.has(f)) };
  } catch { return null; }
}

// x86-64 microarchitecture levels, as gcc/glibc define them. Knowing the level
// is how we know which prebuilt binaries can be ruled out without testing.
function isaLevel(have) {
  const h = new Set(have);
  const v2 = ['popcnt', 'sse4_1', 'sse4_2', 'ssse3', 'cx16'];
  const v3 = ['avx', 'avx2', 'bmi1', 'bmi2', 'fma', 'f16c', 'movbe'];
  if (v3.every((f) => h.has(f))) return 'x86-64-v3 (Haswell+)';
  if (v2.every((f) => h.has(f))) return 'x86-64-v2 (Nehalem+)';
  return 'x86-64-v1 (baseline) -- below Bun and below many prebuilt binaries';
}

async function main() {
  const argv = process.argv.slice(2);
  const one = argv.indexOf('--one');
  if (one !== -1) return runOne(argv[one + 1]);

  const json = argv.includes('--json');
  const ni = argv.indexOf('--node');
  const nodeBin = ni !== -1 ? argv[ni + 1] : process.execPath;

  const ver = spawnSync(nodeBin, ['-p', 'process.version'], { encoding: 'utf8' });
  const version = ver.signal ? `DIED (${ver.signal})` : (ver.stdout || '').trim() || 'unknown';

  const flags = cpuFlags();
  const results = {};
  const out = [];

  for (const name of NAMES) {
    let r = attempt(nodeBin, name, []);
    let rescue = null;
    if (!r.ok && r.how === 'signal' && !CHECKS[name].native) {
      for (const set of MITIGATIONS) {
        const m = attempt(nodeBin, name, set);
        if (m.ok) { rescue = set.join(' '); break; }
      }
    }
    results[name] = { ...r, native: CHECKS[name].native, what: CHECKS[name].what, rescue };
    out.push(name);
  }

  const report = {
    date: new Date().toISOString().slice(0, 10),
    node: version,
    binary: nodeBin,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model?.trim() ?? 'unknown',
    memoryMB: Math.round(os.totalmem() / 1048576),
    isa: flags ? isaLevel(flags.have) : 'unknown',
    cpuFlags: flags,
    results,
  };

  if (json) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); }
  else {
    const w = (s) => process.stdout.write(s + '\n');
    w('');
    w(`  node      ${report.node}   (${report.binary})`);
    w(`  cpu       ${report.cpu}`);
    w(`  isa       ${report.isa}`);
    if (flags) w(`  missing   ${flags.missing.join(' ') || '(nothing notable)'}`);
    w(`  platform  ${report.platform}, ${report.memoryMB} MB`);
    w('');
    for (const name of out) {
      const r = results[name];
      const mark = r.ok ? 'pass' : (r.how === 'signal' ? 'CRASH' : 'fail');
      let line = `  ${mark.padEnd(6)} ${name.padEnd(13)} ${r.detail}`;
      if (!r.ok) line += `  <- ${r.what}`;
      if (r.rescue) line += `   [survives with ${r.rescue}]`;
      else if (!r.ok && r.how === 'signal' && r.native) line += '   [native code: no V8 flag can fix this]';
      w(line);
    }
    const bad = out.filter((n) => !results[n].ok);
    w('');
    w(bad.length === 0
      ? '  VERDICT: this Node build is usable on this machine.'
      : `  VERDICT: ${bad.length} check(s) failed: ${bad.join(', ')}`);
    w('');
  }

  process.exitCode = Object.values(results).every((r) => r.ok) ? 0 : 1;
}

main().catch((e) => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exit(70); });
