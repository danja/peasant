// Assembling everything a command needs: providers, policy, tools, workspace.
//
// One place, so `ask`, `run` and the session cannot drift apart on how a
// provider is chosen or when permission is required.

import { connect } from '../provider/connect.js';
import { Policy } from '../permission/Policy.js';
import { Prompt } from '../permission/Prompt.js';
import { workspaceRoot } from '../tools/paths.js';
import { TokenEstimator } from '../agent/TokenEstimator.js';
import { ContextBudget } from '../agent/ContextBudget.js';
import { Compactor } from '../agent/Compactor.js';
import { TOOLS } from '../tools/registry.js';
import { connectServers } from '../mcp/connect.js';
import { loadContext, renderContext } from '../agent/context-files.js';

export async function build(term, env, { allowAll = false, signal, quiet = false, mcp = true } = {}) {
  const root = workspaceRoot();

  const { router, clients, failed, skipped, prefs } = await connect(env, {
    signal,
    onProgress: (m) => { if (!quiet) term.status(term.paint(`  ${m}...`, 'grey')); },
  });
  term.clearStatus();

  for (const f of failed) {
    term.error(term.paint(`  ${f.name} unavailable: ${f.error}`, 'yellow'));
  }

  const policy = new Policy({ mode: allowAll ? 'allow' : (env.PEASANT_PERMISSION_MODE ?? 'ask') });
  const prompt = new Prompt({ terminal: term });

  const estimator = new TokenEstimator();
  const budget = new ContextBudget({ estimator, compactAt: prefs.compactAt });
  const compactor = new Compactor({ router, estimator });

  // MCP servers are other people's processes and other people's hosts. One
  // being broken is a normal Tuesday and must not stop peasant starting.
  let mcpClients = [];
  let mcpTools = [];
  if (mcp) {
    const result = await connectServers({
      env, cwd: root, signal,
      onProgress: (m) => { if (!quiet) term.status(term.paint(`  ${m}...`, 'grey')); },
    });
    term.clearStatus();
    mcpClients = result.clients;
    mcpTools = result.tools;
    for (const f of result.failed) {
      term.error(term.paint(`  mcp ${f.name}: ${f.error}`, 'yellow'));
    }
  }

  // Standing instructions from configuration, folded into the system prompt.
  // Everything here is resent on every turn, so its size is reported rather
  // than absorbed silently.
  const contextFiles = loadContext({ root, env });
  for (const note of contextFiles.notes) term.error(term.paint(`  ${note}`, 'yellow'));

  return {
    root, router, clients, failed, skipped, prefs, policy, prompt,
    estimator, budget, compactor,
    mcpClients, mcpTools,
    tools: [...TOOLS, ...mcpTools],
    contextFiles,
    context: renderContext(contextFiles.found),
  };
}

// A mutating tool with mode `ask` and no terminal cannot be resolved: hanging
// is the worst answer and silently allowing is the second worst.
export function assertCanAsk(term, policy, prompt) {
  if (policy.mode !== 'ask' || prompt.interactive) return true;
  term.error(term.paint(
    'no terminal attached, so peasant cannot ask before changing anything.\n'
    + 'Re-run with --allow-all if that is what you intend.', 'red'));
  return false;
}
