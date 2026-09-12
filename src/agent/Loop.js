// The agent turn loop: ask, stream, run the tools it asked for, ask again.
//
// Everything it reports goes out as an event rather than to the terminal, so
// the same loop drives the interactive session, a non-interactive run and the
// tests without any of them being a special case.

import { Conversation } from './Conversation.js';
import { specs } from '../tools/registry.js';
import { ToolError } from '../tools/Tool.js';
import { DECISION } from '../permission/Policy.js';

const DEFAULT_MAX_TURNS = 25;

export class Loop {
  #router;
  #tools;
  #policy;
  #prompt;
  #root;
  #maxTurns;
  #budget;
  #compactor;
  #estimator;

  constructor({ router, tools, policy, prompt, root, maxTurns = DEFAULT_MAX_TURNS, budget = null, compactor = null, estimator = null }) {
    this.#router = router;
    this.#tools = tools;
    this.#policy = policy;
    this.#prompt = prompt;
    this.#root = root;
    this.#maxTurns = maxTurns;
    this.#budget = budget;
    this.#compactor = compactor;
    this.#estimator = estimator;
  }

  #tool(name) {
    return this.#tools.find((t) => t.name === name) ?? null;
  }

  // Yields:
  //   provider | text | reasoning | usage   -- passed through from the provider
  //   tool-start  { name, args }
  //   tool-result { name, ok, content }
  //   turn        { n }
  //   done        { reason, turns }
  async *run(conversation, { signal, estimatedTokens = 2000 } = {}) {
    const toolSpecs = specs(this.#tools);
    let current = conversation;
    let emptyReplies = 0;

    for (let turn = 1; turn <= this.#maxTurns; turn++) {
      yield { type: 'turn', n: turn };

      // Compact *before* asking, not after a refusal: a request that does not
      // fit costs a round trip and, on a free tier, possibly a cooldown.
      if (this.#budget && this.#compactor) {
        const client = this.#router.clients[0];
        if (client && this.#budget.shouldCompact(current, toolSpecs, client)) {
          const before = this.#budget.estimate(current, toolSpecs);
          const outcome = await this.#compactor.compact(current, {
            signal,
            // The summary is itself a request, and carries no tools. Without
            // this the compactor tries to send one at exactly the moment
            // nothing can be sent.
            canAfford: (messages) => this.#budget.fits({ messages }, [], client).fits,
            // What the compacted conversation has to fit inside: the real
            // request, tool schemas included.
            targetFits: (messages) => this.#budget.fits({ messages }, toolSpecs, client).fits,
          });
          if (outcome.compacted) {
            current = outcome.conversation;
            yield {
              type: 'compacted',
              before,
              after: this.#budget.estimate(current, toolSpecs),
              summarised: outcome.summarised,
              mechanical: Boolean(outcome.mechanical),
              reason: outcome.reason ?? null,
            };
          } else if (!outcome.quiet) {
            yield { type: 'compact-skipped', reason: outcome.reason };
          }
        }
      }

      const predicted = this.#budget
        ? this.#budget.estimate(current, toolSpecs)
        : estimatedTokens;

      let result = null;
      for await (const ev of this.#router.stream(
        { messages: current.messages, tools: toolSpecs, signal },
        { estimatedTokens: predicted },
      )) {
        if (ev.type === 'done') { result = ev.result; break; }
        if (ev.type === 'usage') {
          // Every response says exactly how wrong the estimate was. Ignoring
          // that would be choosing to stay wrong.
          this.#estimator?.observe({ predicted, actual: ev.usage.prompt_tokens });
        }
        yield ev;
      }

      // A model that says nothing has not taken a turn. Recording it would
      // poison the conversation for good; ignoring it silently would look like
      // the harness hanging. So: say so, and try once more -- an empty reply is
      // usually a model spending its whole completion on reasoning, and the
      // second attempt generally lands.
      if (result.content === '' && result.toolCalls.length === 0) {
        emptyReplies++;
        yield { type: 'empty-reply', attempt: emptyReplies, provider: result.provider };
        if (emptyReplies <= 1) continue;
        yield { type: 'done', reason: 'the model replied with nothing', turns: turn, result, conversation: current };
        return;
      }
      emptyReplies = 0;

      current.assistant({ content: result.content, toolCalls: result.toolCalls });

      if (result.toolCalls.length === 0) {
        yield {
          type: 'done', reason: 'finished', turns: turn, result, conversation: current,
        };
        return;
      }

      // Every pending call must be answered, including the ones that failed --
      // an unanswered call leaves the conversation in a state some providers
      // reject outright and others quietly mishandle.
      for (const call of result.toolCalls) {
        yield { type: 'tool-start', name: call.name, args: call.args };
        const { ok, content } = await this.#runOne(call, signal);
        current.toolResult(call.id, content);
        yield { type: 'tool-result', name: call.name, ok, content };
      }
    }

    yield { type: 'done', reason: 'turn limit', turns: this.#maxTurns, conversation: current };
  }

  // Returns { ok, content }. Content always goes back to the model, including
  // every failure: a model told what went wrong usually fixes it, and a model
  // told nothing repeats it.
  async #runOne(call, signal) {
    const fail = (message) => ({ ok: false, content: `Error: ${message}` });

    if (!call.valid) {
      // The arguments were not JSON. Saying so is the cheapest recovery.
      return fail(`arguments were not valid JSON (${call.error}). Send them again as a JSON object.`);
    }

    const tool = this.#tool(call.name);
    if (!tool) {
      return fail(`there is no tool called ${call.name}. Available: ${this.#tools.map((t) => t.name).join(', ')}`);
    }

    let decision = this.#policy.decide(tool);
    if (decision === DECISION.ask) {
      const answer = await this.#prompt.ask(tool, call.args);
      decision = answer.decision;
      if (answer.remember) this.#policy.rememberAllow(tool.name);
      if (decision === DECISION.deny) return fail(answer.reason ?? 'not permitted');
    }
    if (decision === DECISION.deny) return fail(`${tool.name} is not permitted in this session.`);

    try {
      return { ok: true, content: await tool.invoke(call.args, { root: this.#root, signal }) };
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      if (e instanceof ToolError) return fail(e.message);
      // An unexpected failure is still reported rather than thrown: the model
      // can often work around one, and it cannot work around a session that
      // ended.
      return fail(`${tool.name} failed: ${e.message}`);
    }
  }
}

export { Conversation };
