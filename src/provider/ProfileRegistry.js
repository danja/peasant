// The one list of providers.
//
// Everything that needs to know a provider exists reads it from here: the
// router, the config loader, the probe, and the guard test that binds this list
// to example.env. Adding a provider means adding a file to profiles/ and a line
// here, and the guard fails if those two disagree.

import groq from './profiles/groq.js';
import mistral from './profiles/mistral.js';
import cerebras from './profiles/cerebras.js';
import openrouter from './profiles/openrouter.js';
import google from './profiles/google.js';
import huggingface from './profiles/huggingface.js';
import nvidia from './profiles/nvidia.js';
import together from './profiles/together.js';
import ollama from './profiles/ollama.js';
import llamacpp from './profiles/llamacpp.js';

export const PROFILES = Object.freeze([
  groq, mistral, cerebras, openrouter, google, huggingface,
  nvidia, together, ollama, llamacpp,
]);

export const PROFILE_NAMES = Object.freeze(PROFILES.map((p) => p.name));

// The order used when PEASANT_PROVIDERS says nothing. Local servers are
// excluded: probing a port nobody is listening on costs a connection refusal on
// every start, for a provider most people do not run. Naming one explicitly
// turns it on.
export const DEFAULT_ORDER = Object.freeze(PROFILES.filter((p) => p.autoEnable).map((p) => p.name));

export function byName(name) {
  const p = PROFILES.find((x) => x.name === name);
  if (!p) {
    throw new Error(`unknown provider ${JSON.stringify(name)}. Known: ${PROFILE_NAMES.join(', ')}`);
  }
  return p;
}

// Resolves a profile against config: the base URL and model may be overridden
// per provider, and a provider with no key is not usable.
export function configure(profile, env) {
  const key = env[profile.keyVar] ?? '';
  return {
    profile,
    name: profile.name,
    key,
    // A local server has no account, so an empty key is not a reason to skip it.
    usable: profile.requiresKey ? key !== '' : true,
    baseUrl: env[profile.baseUrlVar] || profile.baseUrl,
    model: env[profile.modelVar] || null,
    extraHeaders: profile.headers(env),
  };
}

// Picks a model from what /models actually listed.
//
// An explicit override wins and is never second-guessed -- if someone names a
// model the catalogue does not list, that is between them and the provider.
// Otherwise the profile's preferences are tried in order against the chat
// models only. There is no final fallback to "the first one": on Groq that
// would select an Arabic text-to-speech model, and the failure would surface
// several layers away as an unhelpful completion.
export function selectModel(profile, ids, override = null) {
  if (override) return override;

  const chat = ids.filter((id) => !profile.nonChat.some((re) => re.test(id)));
  for (const re of profile.prefer) {
    const hit = chat.find((id) => re.test(id));
    if (hit) return hit;
  }
  throw new Error(
    `no model on ${profile.name} matched a preference. Set ${profile.modelVar} to one of: ` +
    `${chat.slice(0, 20).join(', ')}${chat.length > 20 ? ', ...' : ''}` +
    `${chat.length === 0 ? '(no chat models in the catalogue at all)' : ''}`,
  );
}

// The configured order, as PEASANT_PROVIDERS gives it. A name that matches no
// profile is an error rather than a warning: a typo here silently halves the
// failover pool, and the symptom is "it stalls sometimes".
export function resolveOrder(env) {
  const raw = (env.PEASANT_PROVIDERS ?? '').trim();
  const names = raw === '' ? DEFAULT_ORDER : raw.split(',').map((s) => s.trim()).filter(Boolean);

  const seen = new Set();
  for (const n of names) {
    byName(n);
    if (seen.has(n)) throw new Error(`provider ${n} listed twice in PEASANT_PROVIDERS`);
    seen.add(n);
  }
  return names.map((n) => configure(byName(n), env));
}
