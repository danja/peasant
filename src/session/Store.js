// Keeping conversations, so closing a terminal does not throw away everything
// the session cost to build.
//
// Append-only JSONL, one record per line. Two reasons it is not a snapshot of
// the whole conversation rewritten each turn:
//
//   - a crash or a Ctrl-C mid-write cannot corrupt what came before; the worst
//     case is a truncated final line, which replay skips
//   - appending a message is O(1) where rewriting is O(conversation), and these
//     conversations get long
//
// Compaction is the awkward case, because it *replaces* history rather than
// adding to it. It writes a `reset` record: replay clears what it has and
// starts again from there. Still append-only, still crash-safe.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../config/preferences.js';

const VERSION = 1;

// Conversations contain whatever the workspace contains, which may be anything.
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export function sessionsDir(env = process.env, home = os.homedir()) {
  const base = env.PEASANT_HOME
    ? (env.PEASANT_HOME.startsWith('~') ? path.join(home, env.PEASANT_HOME.slice(1)) : env.PEASANT_HOME)
    : path.join(home, '.peasant');
  return path.join(base, 'sessions');
}

// Sortable by name, so listing is a directory read rather than opening every
// file: newest last, and the random suffix keeps two sessions started in the
// same second apart.
export function newId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export class Store {
  #dir;

  constructor({ dir }) {
    this.#dir = dir;
  }

  static open({ env = process.env, home = os.homedir() } = {}) {
    return new Store({ dir: sessionsDir(env, home) });
  }

  get dir() { return this.#dir; }

  fileFor(id) { return path.join(this.#dir, `${id}.jsonl`); }

  // Removes all but the newest `keep` sessions.
  //
  // Ids sort chronologically, so this is a directory read and some unlinks --
  // no need to open anything. Failure is ignored: tidying is a convenience and
  // must never stop a session starting.
  prune({ keep = DEFAULTS.keepSessions } = {}) {
    let files;
    try {
      files = fs.readdirSync(this.#dir).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      return 0;
    }
    const doomed = files.slice(0, Math.max(0, files.length - keep));
    let removed = 0;
    for (const f of doomed) {
      try { fs.unlinkSync(path.join(this.#dir, f)); removed++; } catch { /* leave it */ }
    }
    return removed;
  }

  // Starts a session. Returns a handle that knows how to append to it.
  create({ root, id = newId(), keep = DEFAULTS.keepSessions }) {
    fs.mkdirSync(this.#dir, { recursive: true, mode: DIR_MODE });
    const file = this.fileFor(id);
    const header = { type: 'session', version: VERSION, id, root, created: new Date().toISOString() };
    fs.writeFileSync(file, `${JSON.stringify(header)}\n`, { mode: FILE_MODE });

    // After writing, not before, so `keep` means how many sessions exist once
    // this one has started rather than how many did beforehand. Tidying happens
    // here rather than on a schedule because there is no daemon, and starting a
    // session is the only moment peasant reliably runs.
    this.prune({ keep });
    return new Session({ store: this, id, file, root });
  }

  open(id) {
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) throw new Error(`no session ${id}`);
    const { meta } = this.read(id);
    return new Session({ store: this, id, file, root: meta.root });
  }

  // Replays a session file into its metadata and current messages.
  //
  // A record that will not parse is skipped rather than fatal: the only way one
  // gets there is a process dying mid-write, and the line it was writing is the
  // one thing nobody needs.
  read(id) {
    const file = this.fileFor(id);
    const text = fs.readFileSync(file, 'utf8');

    let meta = { id, version: VERSION };
    let messages = [];
    let turns = 0;

    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }

      switch (record.type) {
        case 'session': meta = { ...meta, ...record }; break;
        case 'message': messages.push(record.message); break;
        case 'reset': messages = []; break;
        case 'turn': turns++; break;
        default: break;
      }
    }
    return { meta, messages, turns };
  }

  // Newest first, because that is the order anyone wants them in.
  list({ limit = 20 } = {}) {
    if (!fs.existsSync(this.#dir)) return [];
    const files = fs.readdirSync(this.#dir).filter((f) => f.endsWith('.jsonl')).sort().reverse();

    const out = [];
    for (const f of files.slice(0, limit)) {
      const id = f.replace(/\.jsonl$/, '');
      try {
        const { meta, messages, turns } = this.read(id);
        out.push({
          id,
          root: meta.root ?? null,
          created: meta.created ?? null,
          messages: messages.length,
          turns,
          // The first thing asked is what makes a session recognisable in a list.
          summary: firstUserLine(messages),
        });
      } catch {
        // An unreadable session must not break the listing of the others.
      }
    }
    return out;
  }

  // The most recent session started in this directory, for `--resume` with no
  // argument. Sessions are per-workspace: resuming a conversation about a
  // different repository is never what anyone meant.
  latestFor(root, { limit = 50 } = {}) {
    return this.list({ limit }).find((s) => s.root === root) ?? null;
  }
}

export class Session {
  #file;
  #id;
  #root;

  constructor({ id, file, root }) {
    this.#id = id;
    this.#file = file;
    this.#root = root;
  }

  get id() { return this.#id; }
  get file() { return this.#file; }
  get root() { return this.#root; }

  #append(record) {
    try {
      fs.appendFileSync(this.#file, `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
    } catch {
      // Persistence is a convenience. Failing to record a message must never
      // end a session that is otherwise working.
    }
  }

  message(message) { this.#append({ type: 'message', message }); }

  turn(n) { this.#append({ type: 'turn', n, at: new Date().toISOString() }); }

  // Compaction replaced the history. Everything before this is superseded.
  reset(messages, { reason = 'compacted' } = {}) {
    this.#append({ type: 'reset', reason, at: new Date().toISOString() });
    for (const m of messages) this.message(m);
  }

  // Records whichever messages are new since `known`, which is how the session
  // loop persists without tracking every append itself.
  sync(messages, known) {
    for (let i = known; i < messages.length; i++) this.message(messages[i]);
    return messages.length;
  }
}

function firstUserLine(messages) {
  const first = messages.find((m) => m.role === 'user' && typeof m.content === 'string');
  if (!first) return null;
  const line = first.content.split('\n')[0].trim();
  return line.length > 70 ? `${line.slice(0, 70)}...` : line;
}
