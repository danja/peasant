// The one list of wire formats.
//
// A dialect answers "what does the wire look like"; a profile answers "who is
// on the other end". Keeping them apart is what lets a provider change
// endpoint without touching a format, and a format gain a provider without
// touching the client.
//
// Dialects are named after the format, never after a vendor -- `messages` and
// `responses` are the shapes, and more than one provider may speak either.

import chatCompletions from './chat-completions.js';
import messages from './messages.js';
import responses from './responses.js';

export const DIALECTS = Object.freeze([chatCompletions, messages, responses]);

export const DIALECT_NAMES = Object.freeze(DIALECTS.map((d) => d.name));

// What a profile gets when it says nothing. Every provider spoke this when
// there was only one shape, so it stays the default.
export const DEFAULT_DIALECT = chatCompletions.name;

export function byName(name) {
  const d = DIALECTS.find((x) => x.name === name);
  if (!d) {
    throw new Error(`unknown dialect ${JSON.stringify(name)}. Known: ${DIALECT_NAMES.join(', ')}`);
  }
  return d;
}
