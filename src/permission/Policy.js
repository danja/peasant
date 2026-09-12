// What the agent may do without being asked.
//
// The policy reads a tool's declared `mutates` flag and nothing else. It does
// not try to judge what a particular command *means* -- parsing a shell line to
// decide whether it is dangerous is a losing game, and a check that can be
// fooled is worse than one that is honestly absent, because it invites trust it
// has not earned.

export const MODES = ['ask', 'allow', 'deny'];

export const DECISION = Object.freeze({
  allow: 'allow',
  ask: 'ask',
  deny: 'deny',
});

export class Policy {
  #mode;
  #alwaysAllow = new Set();
  #denied = new Set();

  constructor({ mode = 'ask', allow = [], deny = [] } = {}) {
    if (!MODES.includes(mode)) {
      throw new Error(`permission mode must be one of ${MODES.join(', ')}; got ${JSON.stringify(mode)}`);
    }
    this.#mode = mode;
    for (const name of allow) this.#alwaysAllow.add(name);
    for (const name of deny) this.#denied.add(name);
  }

  get mode() { return this.#mode; }
  get allowed() { return [...this.#alwaysAllow]; }

  decide(tool) {
    if (this.#denied.has(tool.name)) return DECISION.deny;

    // Reading inside the workspace is not an action worth interrupting someone
    // for. The confinement in src/tools/paths.js is what makes that true, and
    // it is checked by tests rather than assumed here.
    if (!tool.mutates) return DECISION.allow;

    if (this.#alwaysAllow.has(tool.name)) return DECISION.allow;
    if (this.#mode === 'allow') return DECISION.allow;
    if (this.#mode === 'deny') return DECISION.deny;
    return DECISION.ask;
  }

  // "Yes, and don't ask again for this tool" -- for the rest of the session
  // only. Nothing here is written to disk: a durable grant is a decision that
  // should be made deliberately in configuration, not by pressing a key once
  // while impatient.
  rememberAllow(toolName) { this.#alwaysAllow.add(toolName); }

  rememberDeny(toolName) { this.#denied.add(toolName); }
}
