# Maintainer's list

Danja's, in practice: things needing your hands, your hardware, your accounts or
your decision. Everything here is blocked on something no session can do for
itself. What the *project* needs is `TODO.md`; an item landing in one usually
changes the other.

Kept current at the end of any session that changes it.

## Anthropic API key — needs credit before it can do anything

Added as the `anthropic` profile 2026-09-15, and your `.env` now points at it.
Two things were wrong with the configuration and both are fixed: the provider
list said `claude`, which is not a profile name and made peasant refuse to start
at all, and the key was under `CLAUDE_API_KEY`, which nothing reads. It is now
`ANTHROPIC_API_KEY` and the list says `anthropic`. Nothing else in the file was
touched, and the backup was deleted rather than left sitting full of keys.

- [ ] **Buy credit, or the profile cannot be used.** `/v1/models` works — it is
      free, which is why model selection resolves `claude-sonnet-5` — but
      `POST /v1/messages` answers:

          400  Your credit balance is too low to access the Anthropic API.

      Until that is resolved no completion can be made, so the Messages dialect
      stays unverified against the real service and `verified: false` stands.
- [ ] **Decide whether you actually want it in the rotation.** It is first in
      `PEASANT_PROVIDERS`, so once credit exists **every turn bills you** before
      any free tier is tried. Every other provider in that list is free. Moving
      `anthropic` to the end makes it the fallback when the free tiers are
      exhausted, which is probably what you want from a project built on free
      tiers; leaving it first makes peasant a paid harness with free fallbacks.
      Your call, but it should be a decision rather than an accident of ordering.
- [ ] **Capture the rate-limit headers once a request succeeds.** None of the
      responses obtained carried a single `*-ratelimit-*` header, so the profile
      names none and the budget is discovered from 429s alone. A paid response
      would let that be measured properly.

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
- [ ] **A key for Together** would let its profile be probed and move off
      `verified: false`. NVIDIA's is done — see below.

## Confirmed done

- [x] ~~**Keys for NVIDIA and Together**~~ — NVIDIA done 2026-09-15: you added
      `NVIDIA_API_KEY` to `.env`, the profile was probed, corrected and is now
      `verified: true` with captures in `docs/raw/2026-09-15_providers/`.
      Together is still outstanding and stays on the open list above.

      **Two things about NVIDIA that are yours to decide, not the code's:**

      - **It is on credits, not a free tier, and your balance is not visible to
        peasant.** No response header reports it. The provider will work and
        then abruptly stop, and the only place to see how much is left is
        <https://build.nvidia.com>. This is why `autoEnable` is false.
      - **Your `.env` has `PEASANT_PROVIDERS=nvidia,groq,...`, putting NVIDIA
        first.** That spends the finite thing before the renewable ones. If that
        was deliberate — it is the fastest way to use credits before they
        expire — leave it. If it was just where the name landed, move it last.
        Nothing will warn you either way.
