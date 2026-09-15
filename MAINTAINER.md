# Maintainer's list

Danja's, in practice: things needing your hands, your hardware, your accounts or
your decision. Everything here is blocked on something no session can do for
itself. What the *project* needs is `TODO.md`; an item landing in one usually
changes the other.

Kept current at the end of any session that changes it.

## Blocking the two new providers

`claude-code` and `codex` were added 2026-09-15 and **cannot be trusted until
this list is worked through**. Nothing about either has been measured. They are
`autoEnable: false`, so they sit inert until you name them in
`PEASANT_PROVIDERS`; none of the below affects any other provider.

I could not verify any of it from here: reading the credential files was
declined by this session's sandbox, and probing the endpoints would have spent
your subscription. So every item is something only you can do.

- [x] ~~**Confirm the shape of `~/.claude/.credentials.json`.**~~ Partly
      answered 2026-09-15, without reading your file. A file written by hand at
      `claudeAiOauth.accessToken` with a deliberately invalid token was found and
      used, and the request reached Anthropic — so the *path* peasant looks at
      is a path that works. Whether it is the path your real file uses is still
      unconfirmed; if it is not, peasant will name the keys it did find.
      It prints key names only, never values.
- [ ] **Confirm the shape of `~/.codex/auth.json`**, likewise:
      `tokens.access_token` and `tokens.account_id`. The expiry is expected to
      come from the token's own `exp` claim rather than the file, because that
      file records when it last refreshed rather than when the token dies.
- [~] **Does `GET https://api.anthropic.com/v1/models` answer an OAuth token?**
      Measured 2026-09-15 with an invalid token:

          claude-code: listing models failed (HTTP 401):
          OAuth access token is invalid.

      That is the useful answer rather than the disappointing one. The endpoint
      did **not** say `x-api-key header is required` and did not 404 — it read
      `Authorization: Bearer` plus `anthropic-beta: oauth-2025-04-20` as an OAuth
      attempt and rejected only the token's *value*. So the auth scheme, the
      headers and the path are right, and the only untested part is a real
      token. What remains is whether a valid one is accepted **for `/v1/models`
      specifically** — a subscription token may be scoped to inference alone. If
      it is refused, set `CLAUDE_CODE_MODEL` and the catalogue is never asked
      for.
- [ ] **Decide what `CODEX_MODEL` should be.** It is required: that endpoint
      publishes no catalogue, and the profile ships an empty model list rather
      than names taken from memory. A guessed list looks authoritative and goes
      stale in silence, which is worse than an error naming the setting.
- [ ] **Does either endpoint require anything of the request peasant does not
      send?** The Claude Code endpoint is reported to expect a particular
      client identity in the system prompt. Nothing of the sort is sent, and
      nothing of the sort was invented here — if it turns out to be needed,
      that is your call to make rather than a string I should have baked in.
- [ ] **Run `bin/probe-providers.js` against both** once a request succeeds, and
      put the capture in `docs/raw/`. Only then may `verified: true` go into
      either profile — `tests/guard/profile-coverage.test.js` enforces that, so
      the claim cannot be made without the evidence behind it.

## Decisions taken, recorded so they are not re-litigated

- **Using subscription credentials from peasant is against Anthropic's and
  OpenAI's terms**, and the tokens can be revoked. This was put to you before
  the work started and you chose to proceed. It is recorded in `example.env`,
  `README.md` and both profiles so the next reader meets it too.
- **Peasant will not refresh either token.** Refreshing rotates the refresh
  token, which means writing to another program's credential file; getting that
  wrong loses the login for both tools. An expired token is reported and the
  provider skipped, naming `claude` or `codex` as the remedy.

## Still open from earlier

- [ ] **R5: terminal capability survey on the target** — `TERM`, colour depth,
      unicode width, raw mode behaviour. Needs the target machine. An
      interactive session has run there successfully, so nothing is known to be
      wrong; this would tell us what is merely working by luck.
- [ ] **A CPU-baseline-safe Ollama or llama.cpp build on the target** has not
      been tested. Both profiles are unverified against local servers on that
      hardware.
- [ ] **Keys for NVIDIA and Together** would let their profiles be probed and
      move off `verified: false`.
