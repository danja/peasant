// Assembling everything a command needs: providers, policy, tools, workspace.
//
// One place, so `ask`, `run` and the session cannot drift apart on how a
// provider is chosen or when permission is required.

import { connect } from '../provider/connect.js';
import { Policy } from '../permission/Policy.js';
import { Prompt } from '../permission/Prompt.js';
import { workspaceRoot } from '../tools/paths.js';

export async function build(term, env, { allowAll = false, signal, quiet = false } = {}) {
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

  return { root, router, clients, failed, skipped, prefs, policy, prompt };
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
