// Choosing a provider, and moving on when one will not serve.
//
// This is what makes a free-tier harness usable rather than a novelty. Groq
// gives 8,000 tokens a minute and Mistral 625,000 (measured; docs/providers.md),
// so the difference between stalling and not is usually just asking someone
// else. It is also why provider configuration is a list rather than a setting.
//
// One rule worth stating plainly, because it constrains the design: **failover
// happens only before the first token.** Once a stream has emitted text, the
// user has seen it, and silently restarting somewhere else would duplicate or
// contradict what is already on screen. After that point an error propagates.

import { ProviderError } from './OpenAICompatClient.js';
import { DEFAULTS } from '../config/preferences.js';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (ms <= 0) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
});

export class NoProviderError extends Error {
  constructor(message, attempts) {
    super(message);
    this.name = 'NoProviderError';
    this.attempts = attempts;
  }
}

export class Router {
  #clients;
  #maxWaitMs;
  #sleep;
  #rotate;
  #retired = new Map();

  // `clients` in preference order. Tunables come from src/config/preferences.js;
  // nothing here holds a default of its own.
  //
  // rotate: false pins every request to the first usable provider and waits
  // however long that takes, rather than moving on.
  constructor(clients, { maxWaitMs = DEFAULTS.maxWaitMs, rotate = DEFAULTS.rotate, sleep: sleepImpl = sleep } = {}) {
    if (clients.length === 0) {
      throw new Error('Router: no usable providers. Set at least one API key -- see example.env.');
    }
    this.#clients = clients;
    this.#maxWaitMs = maxWaitMs;
    this.#rotate = rotate;
    this.#sleep = sleepImpl;
  }

  get clients() { return this.#clients; }

  // Who would serve a request of this size right now, and what it would cost to
  // wait. Ordered by preference, not by headroom: the configured order is a
  // decision the user made.
  plan(estimatedTokens) {
    return this.#clients.map((client) => {
      const check = client.limiter.check(estimatedTokens);
      return { client, name: client.name, ...check, headroom: client.limiter.headroom() };
    });
  }

  // Picks in *preference order*, not by headroom: the configured order is a
  // decision the user made, and maxWaitMs says how long a preferred provider is
  // worth waiting for before settling for a less preferred one.
  //
  // Note that a provider which has told us nothing counts as available -- null
  // remaining means unknown, not empty. Without the maxWaitMs rule, an unprobed
  // provider at the bottom of the list would win every contest against a
  // preferred one that is merely a second away from resetting.
  //
  // Optimization: If we're running in a constrained environment (like free tier),
  // we can be more conservative about waiting by checking if we'd hit rate limits
  // even with the maxWaitMs threshold.
  #select(estimatedTokens, tried) {
    let plan = this.plan(estimatedTokens);

    // With rotation off there is only ever one candidate: the head of the
    // configured order. It has to be taken *before* the tried/retired filters,
    // not after -- filtering first and then taking the head would quietly
    // promote the second provider the moment the first failed, which is the
    // opposite of pinning. Pinning means "do not prefer someone else"; it does
    // not mean "pretend errors did not happen", so the one candidate is still
    // allowed to fail and report.
    if (!this.#rotate) plan = plan.slice(0, 1);

    plan = plan.filter((p) => !tried.has(p.name) && !this.#retired.has(p.name));
    if (plan.length === 0) return { choice: null, plan, exhausted: true };

    // Conservative approach: check if we're approaching a rate limit that would
    // cause a 429. If so, prefer to wait rather than risk a retry.
    const worthIt = this.#rotate
      ? plan.find((p) => {
          // If we know the provider is completely blocked, don't even consider it
          if (p.waitMs === Infinity) return false;
          
          // If we can afford the request right now, take it
          if (p.allowed) return true;
          
          // If we can wait less than maxWaitMs, consider it
          return p.waitMs <= this.#maxWaitMs;
        })
      : plan[0];
    if (worthIt) return { choice: worthIt, plan, exhausted: false };

    const waitable = plan.filter((p) => Number.isFinite(p.waitMs)).sort((a, b) => a.waitMs - b.waitMs);
    if (waitable.length === 0) return { choice: null, plan, exhausted: false };
    return { choice: waitable[0], plan, exhausted: false };
  }

  // One place where "which provider next, and what must we wait" is decided,
  // so the streaming and non-streaming paths cannot drift apart.
  async #next(estimatedTokens, tried, signal) {
    const { choice, plan, exhausted } = this.#select(estimatedTokens, tried);

    if (!choice) {
      if (exhausted) return null;
      // Every remaining provider says this request can never fit. Waiting will
      // not help; the caller has to send less.
      throw new NoProviderError(
        `no provider can serve a request of about ${estimatedTokens} tokens:\n` +
        plan.map((p) => `  ${p.name}: ${p.reason}`).join('\n'),
        [],
      );
    }

    if (choice.waitMs > 0) await this.#sleep(choice.waitMs, signal);
    tried.add(choice.name);
    return choice.client;
  }

  #giveUp(attempts) {
    // A ProviderError already names its provider, so prefixing it again reads
    // as "cerebras: cerebras: ...".
    const line = (a) => (a.error.startsWith(`${a.provider}:`) ? `  ${a.error}` : `  ${a.provider}: ${a.error}`);
    return new NoProviderError(
      `every provider failed:\n${attempts.map(line).join('\n')}`,
      attempts,
    );
  }

  // Our own fault, or something no other provider would answer differently.
  // Trying again elsewhere just repeats it more slowly.
  #worthAnotherProvider(e) {
    return e instanceof ProviderError && e.retryable;
  }

  // A credential or billing failure will not resolve in the next few seconds,
  // so stop asking for the rest of the session rather than paying the latency
  // of a refusal on every turn.
  #retire(client, e) {
    if (e instanceof ProviderError && e.permanent) {
      this.#retired.set(client.name, e.message);
    }
  }

  get retired() { return new Map(this.#retired); }

  async complete(request, { estimatedTokens = 1000 } = {}) {
    const tried = new Set();
    const attempts = [];

    for (;;) {
      const client = await this.#next(estimatedTokens, tried, request.signal);
      if (!client) throw this.#giveUp(attempts);
      try {
        return await client.complete(request);
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        attempts.push({ provider: client.name, error: e.message, status: e.status ?? null });
        this.#retire(client, e);
        if (!this.#worthAnotherProvider(e)) throw e;
      }
    }
  }

  // Yields the same events as OpenAICompatClient.stream, plus a leading
  // { type: 'provider', name } so a caller can say who answered.
  //
  // Failover happens before the first token only -- see the note at the top.
  async *stream(request, { estimatedTokens = 1000 } = {}) {
    const tried = new Set();
    const attempts = [];

    for (;;) {
      const client = await this.#next(estimatedTokens, tried, request.signal);
      if (!client) throw this.#giveUp(attempts);

      let started = false;
      try {
        for await (const ev of client.stream(request)) {
          if (!started) { started = true; yield { type: 'provider', name: client.name }; }
          yield ev;
        }
        return;
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        attempts.push({ provider: client.name, error: e.message, status: e.status ?? null });
        this.#retire(client, e);
        // Past the first token the user has already seen output. Restarting
        // elsewhere would duplicate or contradict it.
        if (started) throw e;
        if (!this.#worthAnotherProvider(e)) throw e;
      }
    }
  }
}
