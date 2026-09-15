# Claude : Claude Code and Codex endpoints, and the dialect seam they needed

2026-09-15.

## The question

"Can we add support for Claude Code and OpenAI Codex endpoints." Two readings,
and they are not close together:

- the **API-key** reading — `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` against
  their published endpoints, pay per token, no free tier;
- the **subscription** reading — reuse the OAuth tokens Claude Code and the
  Codex CLI already hold on this machine.

Before asking, I probed the endpoints unauthenticated, because which paths exist
changes the cost of the work:

| URL | `POST` with no credential |
|---|---|
| `api.anthropic.com/v1/chat/completions` | `401`, in an **OpenAI-shaped** error envelope |
| `api.anthropic.com/v1/messages` | `401` — `x-api-key header is required` |
| `api.openai.com/v1/chat/completions` | `401` — `Authorization: Bearer` |

The first row matters: Anthropic serves an OpenAI-compatible layer, so the
API-key reading would have been **two data-only profile files** and no change to
the client at all. The subscription reading needed a wire-format translation
layer and a credential reader. Danja chose the subscription reading, having been
told plainly that it is outside both vendors' terms and that tokens can be
revoked. That is recorded in four places now so nobody rediscovers it.

## The seam

`OpenAICompatClient` was one class doing two jobs: transport, budget and failure
classification on one side; the OpenAI request and response shape on the other.
Only the second job varies per format, so it came out into `src/provider/dialects/`:

```
dialects/chat-completions.js   what every provider here already spoke
dialects/messages.js           Anthropic Messages
dialects/responses.js          OpenAI Responses (Codex)
```

Named after the **format**, never the vendor. Two providers may speak one
format, and a dialect called `anthropic` invites a second called `claude`.
There is a test asserting no dialect shares a name with a profile.

The class was renamed `ProviderClient` in `Client.js`, because a class named
`OpenAICompatClient` that speaks Anthropic Messages is a lie in the most-read
place. That rename and the extraction were done as two separate steps, each
verified against the existing suite: **490 tests passed before, 490 after, none
rewritten.** A refactor that needs its tests rewritten is not a refactor.

Each dialect normalises on the way out into the shapes peasant already reads —
tool calls as streamed OpenAI tool-call deltas, usage as
`prompt_tokens`/`completion_tokens`. Translating at the edge is why adding two
formats changed **no file in `src/agent/`**.

## Four things the Messages format does differently

Each is load-bearing, and the second and fourth are the ones that would have
shipped broken:

1. The system prompt is a top-level parameter, not a message with a role.
2. Every tool result for one assistant turn must arrive in a **single** user
   message. Split across two, the API rejects the turn — and the split only
   happens when a task calls two tools at once, so it survives casual testing.
3. `max_tokens` is required, with no server-side default. Hence
   `PEASANT_MAX_OUTPUT_TOKENS` in `preferences.js` — not a rate limit and not a
   context window, which are still never written down, but a choice about how
   much output to ask for. Formats that do not require it are still not sent it,
   so no existing provider's behaviour changed.
4. A content-block index is **not** a tool-call index. Text at block 0 and a
   `tool_use` at block 1 is one tool call, at tool index 0. Using the block
   index attaches the arguments to a call that does not exist, and the symptom
   is a named tool call with empty arguments — which reads as the model's fault.

The Responses format has its own version of the fourth: argument deltas are
keyed by `item_id` in some builds and `output_index` in others, so the dialect
records both and looks up either.

## Credentials

`src/provider/Credentials.js` is the one place peasant reads a file it does not
own. The rules follow from whose file it is, and they are the rules CLAUDE.md
already gives for a project's own `./.env`:

- **It is never written.** Refreshing an OAuth token rotates it, which would mean
  writing to Claude Code's own login. Get that wrong and both tools lose it. An
  expired token is reported with the remedy named — run `claude` once.
- **A problem is reported and skipped, never fatal.** One unreadable login must
  not cost a session every other provider's key.
- **The field names are candidates, not a known path.** A file matching none of
  them is reported with what was looked for and which top-level keys it has —
  names only, never values, because an error message is exactly where a secret
  escapes into a bug report. There is a test asserting the token never appears
  in the problem text.

## What is honest about this, and what is not

The dialects are tested end to end through the real client against the fake
server, both halves of the translation, 41 new tests. What they prove is that
the translation is self-consistent and that the client drives it.

What they **cannot** prove is that the shape is the shape Anthropic and OpenAI
actually send. Nothing here has been measured. I could not read the credential
files — the sandbox declined — and probing the endpoints would have spent
Danja's subscription. So both profiles ship `verified: false` with `UNVERIFIED`
at the top, which `tests/guard/profile-coverage.test.js` requires and which
means neither can claim otherwise without a capture in `docs/raw/`.

Everything a first real run has to confirm is in `MAINTAINER.md` (then at
`docs/danja-todo.md`), which was
an empty file before today.

## Incidentals

- `MISTAKES.md` has a new entry and CLAUDE.md's recurring-failure table has its
  first row: a profile field renamed in `generic.js` while `messages.js` went on
  reading the old name, so the version header went out as `undefined`. Caught by
  a test written before the code was trusted.
- A pre-existing asymmetry in `stream()`: the post-stream flush handled `text`
  but silently dropped `reasoning`, so a provider whose last event carried
  reasoning would have lost it. Both loops now go through one function.
- `README.md` said "Eight profiles" and listed eight while the registry held
  ten. It now says twelve, taken from the registry rather than from counting the
  prose. Figures come from the system.
- `docs/providers.md` and `docs/plan.md` still named `OpenAICompatClient` after
  the rename. Fixed — the same two-files-must-agree failure as the mistake above,
  found by grepping for it rather than by anything complaining.
- `TODO.md` claimed `npm test` "takes about twenty seconds". Measured today:
  3.9s for the 490 tests before this work, and 4.13/3.52/3.71s over three runs
  for the 531 after. Corrected — and worth noticing that I first wrote "4.5s"
  here from expectation rather than from the run, which is the same failure the
  line was correcting.
