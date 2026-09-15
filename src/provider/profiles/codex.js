import { defineProfile } from './generic.js';

// UNVERIFIED: no response from this endpoint has been captured or inspected.
// The base URL, the event names, the credential file's shape and the account
// header are written from documentation, not measured. Nothing in docs/raw/
// stands behind any of it.
//
// The Codex backend, reached with the OAuth token the Codex CLI already holds
// on this machine. It speaks the Responses format, not chat completions.
//
// The same two warnings as claude-code.js apply, for the same reasons: it
// spends a ChatGPT subscription rather than a free tier, using it from a
// third-party client is outside OpenAI's terms, and peasant reads the
// credential file without ever writing it, so an expired token is reported with
// `codex` named as the remedy rather than refreshed behind that tool's back.
export default defineProfile({
  name: 'codex',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  dialect: 'responses',

  keyVar: 'CODEX_OAUTH_TOKEN',
  baseUrlVar: 'CODEX_BASE_URL',
  modelVar: 'CODEX_MODEL',

  requiresKey: true,
  verified: false,
  autoEnable: false,

  credentialFile: {
    file: '~/.codex/auth.json',
    tokenPaths: [['tokens', 'access_token'], ['access_token'], ['accessToken']],
    // The file records when it last refreshed rather than when the token
    // expires, so the expiry usually comes from the token's own `exp` claim.
    expiryPaths: [['tokens', 'expires_at'], ['expires_at']],
    headerPaths: {
      'chatgpt-account-id': [['tokens', 'account_id'], ['account_id']],
    },
    remedy: 'Run `codex` once to sign in, or set CODEX_OAUTH_TOKEN.',
  },

  // This endpoint publishes no catalogue, and `models` is deliberately empty
  // rather than filled with names taken from memory. A guessed list is worse
  // than no list: it looks authoritative, goes stale silently, and the failure
  // arrives as a confusing 404 several layers from the cause. So CODEX_MODEL
  // must be set, and Client.listModelDetails says exactly that when it is not.
  models: [],
  prefer: [],
});
