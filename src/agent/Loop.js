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

  constructor({ router, tools, policy, prompt, root, maxTurns = DEFAULT_MAX_TURNS }) {
    this.#router = router;
    this.#tools = tools;
    this.#policy = policy;
    this.#prompt = prompt;
    this.#root = root;
    this.#maxTurns = maxTurns;
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

    for (let turn = 1; turn <= this.#maxTurns; turn++) {
      yield { type: 'turn', n: turn };

      let result = null;
      for await (const ev of this.#router.stream(
        { messages: conversation.messages, tools: toolSpecs, signal },
        { estimatedTokens },
      )) {
        if (ev.type === 'done') { result = ev.result; break; }
        yield ev;
      }

      conversation.assistant({ content: result.content, toolCalls: result.toolCalls });

      if (result.toolCalls.length === 0) {
        yield { type: 'done', reason: 'finished', turns: turn, result };
        return;
      }

      // Every pending call must be answered, including the ones that failed --
      // an unanswered call leaves the conversation in a state some providers
      // reject outright and others quietly mishandle.
      for (const call of result.toolCalls) {
        yield { type: 'tool-start', name: call.name, args: call.args };
        const { ok, content } = await this.#runOne(call, signal);
        conversation.toolResult(call.id, content);
        yield { type: 'tool-result', name: call.name, ok, content };
      }
    }

    yield { type: 'done', reason: 'turn limit', turns: this.#maxTurns };
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
