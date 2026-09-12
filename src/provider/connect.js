// Turning configuration into a Router.
//
// The one place that knows how a key, a base URL and a model catalogue become
// something you can ask a question of.

import { resolveOrder, selectModel } from './ProfileRegistry.js';
import { OpenAICompatClient } from './OpenAICompatClient.js';
import { Router } from './Router.js';
import { preferences } from '../config/preferences.js';

// Resolves each usable provider's model, asking its catalogue only when the
// configuration does not already say. Listing models costs a request but no
// tokens, and choosing wrongly costs a confusing failure much later.
export async function connect(env, { signal, onProgress = () => {} } = {}) {
  const configured = resolveOrder(env);
  const usable = configured.filter((c) => c.usable);
  const skipped = configured.filter((c) => !c.usable);

  if (usable.length === 0) {
    throw new Error(
      'no provider has a key. Copy example.env to .env and fill in at least one:\n' +
      configured.map((c) => `  ${c.name}: ${c.profile.keyVar}`).join('\n'),
    );
  }

  const clients = [];
  const failed = [];

  for (const config of usable) {
    const client = new OpenAICompatClient(config);
    try {
      if (!config.model) {
        onProgress(`resolving a model for ${config.name}`);
        const ids = await client.listModels({ signal });
        config.model = selectModel(config.profile, ids, null);
      }
      clients.push(new OpenAICompatClient(config));
    } catch (e) {
      // One provider being unreachable or misconfigured must not stop the
      // others: that is the whole point of having several.
      failed.push({ name: config.name, error: e.message });
    }
  }

  if (clients.length === 0) {
    throw new Error(
      `every configured provider failed to connect:\n${failed.map((f) => `  ${f.name}: ${f.error}`).join('\n')}`,
    );
  }

  const prefs = preferences(env);
  const router = new Router(clients, { rotate: prefs.rotate, maxWaitMs: prefs.maxWaitMs });
  return { router, clients, skipped, failed, prefs };
}
