import { defineProfile } from './generic.js';

// UNVERIFIED: no response from this endpoint has been captured or inspected.
// The wire format, the header names and the credential file's shape are all
// written from documentation rather than measured, which in this project means
// they are claims. `bin/probe-providers.js` has not been pointed at it, there is
// nothing in docs/raw/, and until there is, `verified` stays false.
//
// Anthropic's Messages endpoint, reached with the OAuth token Claude Code
// already holds on this machine rather than with an API key. Peasant reads that
// file and never writes it: see Credentials.js for why.
//
// Two things to know before enabling it.
//
// **This is a subscription credential, not a free tier.** Using it from a
// third-party client is outside what Anthropic's terms permit, and the token can
// be revoked. That was stated plainly before this profile was written and the
// decision to have it was taken knowingly; it is recorded here so the next
// reader does not have to rediscover it.
//
// **Peasant cannot refresh the token.** Refreshing rotates the refresh token,
// which would mean writing to Claude Code's own credentials file. When the
// access token expires the provider is reported and skipped, with the remedy
// named: run `claude` once and it refreshes its own file.
export default defineProfile({
  name: 'claude-code',
  baseUrl: 'https://api.anthropic.com/v1',
  dialect: 'messages',

  // Measured 2026-09-15: POST /v1/messages with no credential answers
  // 401 `x-api-key header is required`, so the path exists and the endpoint is
  // live. That is the whole of what has been measured here.
  apiVersion: '2023-06-01',

  // An explicit token wins over the file, for anyone who would rather paste one
  // than have peasant read another program's login at all.
  keyVar: 'CLAUDE_CODE_OAUTH_TOKEN',
  baseUrlVar: 'CLAUDE_CODE_BASE_URL',
  modelVar: 'CLAUDE_CODE_MODEL',

  requiresKey: true,
  verified: false,

  // Off unless named in PEASANT_PROVIDERS. Everything else here is a free tier
  // reached with a key of its own; this one spends a subscription, so it is
  // never entered by default.
  autoEnable: false,

  credentialFile: {
    file: '~/.claude/.credentials.json',
    tokenPaths: [['claudeAiOauth', 'accessToken'], ['accessToken'], ['access_token']],
    expiryPaths: [['claudeAiOauth', 'expiresAt'], ['expiresAt'], ['expires_at']],
    remedy: 'Run `claude` once to sign in, or set CLAUDE_CODE_OAUTH_TOKEN.',
  },

  // An OAuth token is not an API key and the endpoint wants to be told so.
  headers: () => ({ 'anthropic-beta': 'oauth-2025-04-20' }),

  // Named patterns rather than a catch-all: the catalogue carries dated
  // snapshots and deprecated entries alongside the current models, and picking
  // the alphabetically-first would be the same mistake the Groq profile
  // documents. Ordered cheapest-capable first -- a harness that runs hundreds of
  // small tool-calling turns is the wrong place to spend the largest model.
  prefer: [
    /^claude-sonnet-5$/,
    /^claude-haiku-4-5$/,
    /^claude-opus-5$/,
    /^claude-sonnet-\d+(\.\d+)?$/,
  ],
});
