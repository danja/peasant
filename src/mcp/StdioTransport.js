// MCP over a child process: newline-delimited JSON-RPC on stdin and stdout.
//
// The server's stderr is kept but never mixed into the protocol stream: many
// MCP servers log there, and a log line parsed as a message is a confusing way
// to fail.

import { spawn } from 'node:child_process';

export class StdioTransport {
  #child = null;
  #buffer = '';
  #decoder = new TextDecoder('utf-8');
  #onMessage = () => {};
  #onClose = () => {};
  #stderr = [];
  #command;
  #args;
  #env;
  #cwd;

  constructor({ command, args = [], env = {}, cwd = process.cwd() }) {
    this.#command = command;
    this.#args = args;
    this.#env = env;
    this.#cwd = cwd;
  }

  get stderr() { return this.#stderr.join(''); }

  async start() {
    this.#child = spawn(this.#command, this.#args, {
      cwd: this.#cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // The server's environment is the parent's plus whatever the config
      // adds -- a server that needs a token gets it from its own block, not
      // from peasant's provider keys by accident.
      env: { ...process.env, ...this.#env },
    });

    this.#child.stdout.on('data', (chunk) => this.#read(chunk));
    this.#child.stderr.on('data', (chunk) => {
      // Bounded: a chatty server must not grow the process without limit.
      this.#stderr.push(String(chunk));
      if (this.#stderr.length > 200) this.#stderr.splice(0, this.#stderr.length - 200);
    });
    this.#child.on('close', () => this.#onClose());

    await new Promise((resolve, reject) => {
      const onError = (e) => reject(new Error(`cannot start ${this.#command}: ${e.message}`));
      this.#child.once('error', onError);
      // spawn is asynchronous; give it a tick to fail on a missing binary.
      setTimeout(() => { this.#child.off('error', onError); resolve(); }, 50);
    });
    return this;
  }

  #read(chunk) {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    let index = this.#buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line !== '') this.#onMessage(line);
      index = this.#buffer.indexOf('\n');
    }
  }

  onMessage(fn) { this.#onMessage = fn; }
  onClose(fn) { this.#onClose = fn; }

  async send(text) {
    if (!this.#child || this.#child.killed) throw new Error('the server process is not running');
    this.#child.stdin.write(`${text}\n`);
  }

  async close() {
    if (!this.#child) return;
    this.#child.stdin.end();
    // Its own process group would be tidier, but an MCP server is expected to
    // exit when its stdin closes; SIGKILL is the backstop.
    const child = this.#child;
    this.#child = null;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 2000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
}
