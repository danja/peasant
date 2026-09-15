# Providers

What the providers actually do, measured. Evidence in
`raw/2026-09-12_providers/` and `raw/2026-09-15_providers/`; re-measure with
`node bin/probe-providers.js`, or one provider with `--only <name>`.

Keyed as of 2026-09-15: **Groq**, **Mistral**, **Cerebras**, **OpenRouter**,
**Google AI Studio**, **Hugging Face**, **NVIDIA**. Unkeyed: Together.

| Provider | Chat | Streams | Rate-limit headers | Tool-call shape | Profile |
|---|---|---|---|---|---|
| groq | 200 | yes | **full** | whole in one delta | verified |
| mistral | 200, later 429 | yes | **partial** (no reset) | whole in one delta | verified |
| openrouter | 200 | yes | **none** | incremental | verified |
| google | 200 | yes | **none** | whole in one delta | verified |
| huggingface | 200 | yes | **none** | incremental | verified |
| nvidia | 200 | yes | **none** | incremental | verified |
| cerebras | **402** | never seen | **none** | unknown | unverified |

**Five of the seven publish no rate-limit headers at all.** Only Groq says
everything and only Mistral says most of it. That is the shape of the problem,
and it is why the limiter treats `null` as unknown rather than empty, and why
rotation is on by default.

## The headline

**Published free-tier figures are not to be trusted, and most providers publish
no limits at runtime either.** Five of the seven give the limiter nothing to
steer by. This is the whole justification for treating a rate limit as something
read from a response rather than written in a config file — and for the limiter
distinguishing *unknown* from *empty*, because for most providers unknown is the
normal state.

## Rate-limit headers

**Groq** — the only provider that says everything.
```
x-ratelimit-limit-requests: 1000        x-ratelimit-reset-requests: 1m26.4s
x-ratelimit-limit-tokens: 8000          x-ratelimit-reset-tokens: 644ms
x-ratelimit-remaining-requests: 999
x-ratelimit-remaining-tokens: 7914
```
Reset is a **duration string**, not seconds and not a timestamp. `RateLimiter.parseDuration`
handles it, and refuses a string it only partly understands — a regex that
matched `1m` out of `1m26.4s` would wait 26 seconds too little, every time.

Groq's `limit-requests: 1000` with a reset of 1m26.4s reads as neither clearly
per-minute nor per-day. **Not understood — do not guess.** `remaining` is treated
as authoritative and `reset` as the earliest safe retry, which is correct under
either reading.

**Mistral** — limits but no reset.
```
x-ratelimit-limit-req-minute: 125       x-ratelimit-tokens-query-cost: 12
x-ratelimit-limit-tokens-minute: 625000
x-ratelimit-remaining-req-minute: 124
x-ratelimit-remaining-tokens-minute: 624988
```
The window is stated only in the header *name*, so the profile carries
`impliedWindowMs: 60_000` and the budget is held more conservatively than Groq's
despite being 78× larger. Mistral alone reports what a query cost.

**OpenRouter, Cerebras, Google, Hugging Face and NVIDIA publish nothing.** Their
budget is discovered only from 429s.

## Mistral: measured twice, different answers

At 09:00 on 2026-09-12 Mistral reported 125 requests and 625,000 tokens per
minute. At 16:40 the same account, the same key, returned 429 to every request
with:

```
x-ratelimit-limit-req-minute: 0
x-ratelimit-remaining-req-minute: 0
{"message":"Rate limit exceeded","code":"1300"}
```

A *limit* of zero rather than an exhausted window, and persistent rather than
momentary. Whatever the cause, it is a reminder that these figures are a
property of an account on a day, not of a provider: a number measured this
morning can be wrong by the afternoon, which is the argument for reading the
headers on every response rather than recording a figure anywhere.

peasant treats a zero limit as a symptom rather than a durable fact, so the
provider is retried rather than dropped for the session. That is the right call
for a momentary zero and merely harmless for a persistent one.

## An overflow is not always a 429

Groq answers a per-minute **token** overflow with **HTTP 413**, reserving 429
for a request-rate overflow:

```
HTTP 413
retry-after: 31
x-ratelimit-limit-tokens: 8000
x-ratelimit-remaining-tokens: 8000
Request too large for model ... on tokens per minute (TPM): Limit 8000, Requested 13266
```

Note `remaining-tokens: 8000` — the budget is *full*. Nothing was consumed,
because nothing was sent. This is a size refusal, not a rate refusal, and the
two want opposite responses: waiting fixes a rate refusal and does nothing at
all for a size one. peasant classifies 413 as `too-large` — rotate to a bigger
provider immediately, do not put this one in a cooldown it did not ask for.

The headers on that response are how the limiter learns the real budget: Groq's
`/models` carries no `x-ratelimit-*` at all, so before the first completion the
budget is genuinely unknown. One 413 is enough, after which an over-sized
request is refused before it costs a round trip.

## What a 429 looks like

Observed on Mistral later the same day, after the morning's probe reported
125 req/min and 625,000 tokens/min:

```
HTTP 429
x-ratelimit-limit-req-minute: 0
x-ratelimit-remaining-req-minute: 0
(no retry-after, empty body)
```

Three things follow. The body is empty, so there is nothing to explain to a
user. There is no `retry-after`, so the limiter's own backoff is all we have.
And **a limit of `0` is not the same as a limit smaller than the request** — the
first means exhausted right now, the second means impossible forever. Reading
one as the other drops a provider from the pool permanently over a momentary
condition; `tests/unit/rate-limiter.test.js` pins the distinction.

## Tool calls

Both shapes exist in the captures, which is why `ToolCallAssembler` handles
both rather than the one the first two providers happened to use:

- **Whole in one delta** — Groq and Mistral send id, name and the complete
  argument JSON at `index: 0`, all at once.
- **Incremental** — OpenRouter sends id and name with `arguments: ""`, then the
  arguments in a second delta. This is the OpenAI shape.

`tests/unit/tool-call-assembler.test.js` asserts both shapes are represented in
the captures, so half the assembler cannot quietly become untested.

One caveat about model quality rather than dialect: the free
`cohere/north-mini-code:free` called `get_weather` with `{}` despite `city`
being required. Assembly was correct; the model was not.

## Google: `thought_signature` must be echoed back, and peasant throws it away

Measured 2026-09-15. **This is why a tool-using session against Gemini fails on
its second turn.** The first turn works and produces a tool call; sending the
tool's result back produces:

```
HTTP 400  INVALID_ARGUMENT
"Function call is missing a thought_signature in functionCall parts. This is
 required for tools to work correctly, and missing thought_signature may lead to
 degraded model performance. Additional data, function call `default_api:read`,
 position 2."
```

Gemini 3.x attaches an opaque signature to every function call it makes and
requires it back, unchanged, when the conversation continues. It arrives on the
tool call itself, not on the message:

```json
"tool_calls": [{
  "extra_content": { "google": { "thought_signature": "ErsCCrgCARFNMg9Z3Rvn…" } },
  "function": { "name": "read", "arguments": "{\"path\":\"notes.txt\"}" },
  "id": "call_199891", "type": "function"
}]
```

peasant discards it twice over. `ToolCallAssembler.push()` reads `id`, `type`,
`function.name` and `function.arguments` and nothing else; `Conversation.assistant()`
then rebuilds the message from `{id, type, function}` alone. Either would be
enough to lose it.

**The evidence has been in this repository since the day Google was first
probed.** `docs/raw/2026-09-12_providers/google-tools.sse`, first line, carries
`extra_content.google.thought_signature` on the tool-call delta. It was
captured, committed, and never read by anything.

**The probe could not have caught it.** `probe-providers.js` sent one request
and read the answer; it contained no `role: 'tool'` message anywhere. It proved
a tool call *arrives* and never that a conversation can continue past one, which
is the only thing a harness actually needs. It now answers its own tool call and
captures the result as `<provider>-turn2.sse`, rebuilding the assistant turn the
way `Conversation` does rather than by hand — because the question that turn
asks is not what the provider sent, it is whether what peasant sends back is
accepted. The report says plainly which provider fields were echoed.

**Fixed 2026-09-15 by keeping what we do not understand.** `ToolCallAssembler`
now collects every field on a tool call that is not one of the four it
interprets into `extra`, and `Conversation.assistant()` spreads that back onto
the message it sends — before `id`, `type` and `function`, so a provider field
can never overwrite the three peasant is responsible for. Nothing names Google:
the rule is that an opaque field a provider attached to a call is the provider's,
and goes back untouched. Reasoning is still dropped, because that one is ours.

`tests/unit/provider-extras.test.js` asserts the property end to end, including
against the real captured Google bytes, and one of its tests walks every tool
capture on disk and fails if any provider field goes missing between the
response and the next request — the test that would have caught this on
2026-09-12.

**Not yet confirmed against live Gemini**, for want of quota rather than want of
trying: the investigation exhausted the free tier. Everything checkable without
Google is checked, and a second turn now works live on NVIDIA and Groq.

## Google's free tier is five requests a minute, and says so only in the body

Measured 2026-09-15 while re-probing:

```
HTTP 429  RESOURCE_EXHAUSTED
"Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests,
 limit: 5, model: gemini-3.5-flash. Please retry in 46.547714954s."
```

Five requests per minute, an order of magnitude tighter than the token limits
that dominate elsewhere — on Google the request count is what runs out first.

Two things the limiter cannot currently use. There is still **no
`x-ratelimit-*` header and no `retry-after`**, so the figure exists only in
English prose inside the error message. And peasant's default backoff for a 429
without `retry-after` is 20 seconds (`PEASANT_BACKOFF_MS`), while Google asked
for **46.5** — so the retry arrives while still exhausted and spends another
request learning that.

## Google: the preferred model is the one under load

Measured 2026-09-15, five requests each, after a 503 was reported in normal use:

| Model | Succeeded |
|---|---|
| `models/gemini-3.8-flash` | **2 of 5** |
| `models/gemini-3.5-flash` | 5 of 5 |
| `models/gemini-3.5-flash-lite` | 5 of 5 |

```
HTTP 503  "This model is currently experiencing high demand. Spikes in demand
           are usually temporary. Please try again later."  status: UNAVAILABLE
```

Nothing is wrong with the key, the account or the request: `gemini-3.8-flash` is
Google's newest flash model and the busiest, and it is the model this profile
prefers first. The two that answer every time are the next two entries in the
same `prefer` list.

Two things follow, both recorded in `TODO.md`.

**A 503 rotates the provider, not the model.** `selectModel` runs once at connect
time and nothing revisits it, so peasant abandons Google entirely rather than
trying the next preference — with `PEASANT_PROVIDERS=google` alone that is the
end of the session. The alternatives are already listed; only availability is
missing, and the 503 is the provider supplying it.

**A slow failure is worse than a fast one.** Two of three streamed requests to
the unwell model returned 503 in about a second. The third accepted the
connection and sent nothing for 90 seconds, ending only because the probe set
its own deadline. peasant sets none on the provider path, so `peasant ask` hung
past two minutes.

Until either is addressed, `GEMINI_MODEL=models/gemini-3.5-flash` is the remedy.

## Model choice is where the failures are

**`peasant doctor` now asks.** Every failure below was found by hand, one
provider at a time, and the fifth was found only by accident. The check lives in
`src/provider/tool-check.js` and runs by default: it sends each provider's
selected model one trivial tool call and reports whether it came back with
arguments matching the schema the model was shown. `--no-tool-check` skips it;
it costs about 200 tokens per provider.

Every provider that failed on first contact failed because of the *model*, not
the transport. All four were caught by `selectModel` refusing or by the probe,
and all four preference lists had been written from documentation:

- **Google** picked `gemini-2.5-flash-lite` and got 404: *"no longer available
  to new users, please update to models/gemini-3.5-flash-lite"*. The catalogue
  still lists models that accept no new users, and ids sort alphabetically, so
  a loose `/flash-lite/` matches a dead one. Preferences now name versions
  explicitly.
- **Hugging Face** picked `Qwen2.5-Coder-32B-Instruct` and got
  `422 UNSUPPORTED_OPENAI_PARAMS: tools, tool_choice`. On a router fronting many
  upstreams, **tool support is a property of the model, not the provider**, and
  the only way to know is to ask. A coding harness without tool calls is
  useless, so the preferences name models that have them.
- **Cerebras** matched nothing at all — its catalogue is `qwen-3.8-27b`,
  `gpt-oss-120b`, `gemma-4-31b` and the list said `llama`. `selectModel` refused
  and named what was on offer, which is what it exists for.
- **OpenRouter** matched `/:free$/` against an alphabetically-first *vision*
  model. Free does not mean suitable.
- **NVIDIA** matched `/llama-3\.[13]/` against
  `nvidia/llama-3.1-nemoguard-8b-content-safety` — a **guardrail classifier** —
  and sent it a coding conversation. See the NVIDIA section below; it is the
  worst of the five because nothing failed. The model answered.

The general lesson: a preference list written from documentation is a guess with
a long shelf life. `selectModel` refusing rather than falling back to "the first
one" is what makes each of these a one-line fix instead of a confusing
completion three layers away.

## Reasoning tokens are most of the bill

Groq's `gpt-oss-20b` streams `delta.reasoning` with `channel: "analysis"`,
separate from `delta.content`. It must never be rendered as assistant output —
it is the model's private working. It is also where the budget goes:

| Observation | completion tokens | of which reasoning |
|---|---|---|
| groq, tool call | 24 | **22** |
| groq, `ask` run | 66 | **39** |
| openrouter, tool call | 24 | **31** (exceeds the completion count) |

Google is worse: it reports `prompt_tokens: 8`, `completion_tokens: 0` and
`total_tokens: 13`. The five tokens in between are thinking tokens, counted in
the total and reported nowhere else. **`total_tokens` is the only figure to
trust.**

A budgeter counting only visible output would be wrong by an order of
magnitude. `TokenEstimator` must read
`usage.completion_tokens_details.reasoning_tokens`.

## Model catalogues, as listed

Not as documented. **Groq** lists 14, and neither Kimi K2 nor Qwen3-Coder — both
described in 2026 write-ups — is among them:
`openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `openai/gpt-oss-safeguard-20b`,
`qwen/qwen3.6-27b`, `qwen/qwen3.8-27b`, `groq/compound`, `groq/compound-mini`,
`allam-2-7b`, plus whisper/orpheus/prompt-guard.

**Mistral** lists 46, including several that look built for this job:
`mistral-vibe-cli-with-tools`, `mistral-vibe-cli-latest`, `mistral-code-latest`,
`codestral-latest`.

**Cerebras** lists 3: `qwen-3.8-27b`, `gpt-oss-120b`, `gemma-4-31b`. The
profile's original preference list came from documentation and matched none of
them — `selectModel` refused rather than guessing, which is the behaviour it
exists for.

**OpenRouter** lists 445, of which 19 carry `:free`.

Anything matching `embed`, `ocr`, `voxtral`, `whisper`, `orpheus`, `moderation`,
`prompt-guard`, `tts`, `transcribe` or `rerank` is not a chat model and is
filtered out of selection. `groq/compound` is excluded too, pending a decision on
whether it is an agent wrapper with its own tool loop.

## Cerebras is not usable yet

`/models` answers 200, but every `/chat/completions` returns:

```
HTTP 402  Payment required to access this resource. Visit your billing tab.
```

An account action, not a code problem — see `MAINTAINER.md`. A 402 is
classified as `provider-unavailable`: the router rotates past it *and* retires it
for the session, because a billing problem will not resolve in the next few
seconds. Getting that classification wrong in the other direction — treating it
like a malformed request — would have taken the whole session down over one
account's billing.

## Rotation

Providers are tried in `PEASANT_PROVIDERS` order and peasant moves to the next
whenever the current one is blocked. Verified live on 2026-09-12:

```
$ PEASANT_PROVIDERS=cerebras,huggingface,groq peasant ask "Reply with exactly: ok"
  huggingface
ok
  qwen3-coder-30b-a3b-instruct · 13 in · 2 out
  cerebras withdrawn for this session: 402 Payment required...

$ PEASANT_ROTATE=off PEASANT_PROVIDERS=cerebras,groq peasant ask "..."
every provider failed:
  cerebras: stream failed (HTTP 402): Payment required...
```

The policy, in `src/provider/Router.js` and tunable in `src/config/preferences.js`:

| Failure | Response |
|---|---|
| 429 rate limit | wait if the window rolls within `PEASANT_MAX_WAIT_MS`, else rotate |
| 401 / 402 / 403 | rotate **and retire** the provider for the session |
| 5xx, network | rotate |
| 400 bad request | do **not** rotate — every provider will say the same |

Rotation happens only **before the first token**. Once a stream has emitted
text the user has seen it, and restarting elsewhere would duplicate or
contradict what is on screen.

## What a turn costs

Measured 2026-09-12 by `bin/probe-tokens.js` against gpt-oss-20b; raw numbers in
`raw/2026-09-12_tokens.json`.

| | tokens |
|---|---|
| Empty request (chat template) | 72 |
| System prompt (597 chars) | 132 |
| **Seven tool schemas (4,098 chars)** | **738** |
| **Fixed cost, every turn** | **942** |

**Nine hundred and forty-two tokens before a word is said** — nearly 12% of
Groq's per-minute budget, resent on every turn. That single figure is most of
the argument for Phase 4, and the largest part of it is the tool schemas.

Characters per token, consistent to within 2% across 200, 800 and 3,200
character samples:

| Content | tokens/char |
|---|---|
| Prose | 0.214 |
| **Code** | **0.424** |
| JSON with prose descriptions | 0.180 |

**Code is twice as dense as prose.** A single "characters over four" constant
(0.25) would underestimate a file read by forty per cent — in the direction that
causes 429s. And JSON full of English descriptions packs *better* than prose,
which is why the tool schemas were overestimated by thirty per cent until they
got a category of their own.

`TokenEstimator` starts from these constants and then calibrates against
`usage.prompt_tokens` on every response, because every provider tokenises
differently and the answer arrives on every turn. In a live session it settled
at a correction of **0.90** after sixteen responses — recovering almost exactly
the 10% safety margin the constants carry.

## Local models

`ollama` and `llamacpp` profiles exist and need no key, no quota and no network.
Neither is tried unless named in `PEASANT_PROVIDERS`: probing a port nobody is
listening on costs a connection refusal on every start, for a provider most
people do not run.

Verified 2026-09-12 on the development machine:

```
$ PEASANT_PROVIDERS=ollama peasant ask "Reply with exactly: ok"
  ollama
ok
  qwen2.5:0.5b · 34 in · 2 out
```

Two rules bend for them, both deliberately and both enforced:

- **Plaintext is allowed**, but only for a loopback address — the key never
  leaves the machine. `ProviderClient` refuses `http://` to anything else,
  and a profile with a loopback base URL must declare `requiresKey: false` or
  `defineProfile` throws.
- **A catch-all model preference is reasonable here** where it would be reckless
  on a hosted provider. The local catalogue is small and the user's own, so the
  worst case is their single model rather than an Arabic text-to-speech model
  chosen alphabetically.

They will be slow on an Athlon II. That is a trade made knowingly, and it is the
only option that works with no network at all.

## Open questions

- Which model to default to per provider. `mistral-vibe-cli-with-tools` and
  `mistral-code-latest` are the candidates to evaluate first.
- Whether `groq/compound` is a chat model or an agent wrapper.
- Whether Mistral's `limit: 0` was exhaustion from the probe or an account
  state. It reported 125/625,000 that morning.

## Anthropic, with an API key

Added 2026-09-15, and the only part of this section that is *measured* rather
than documented. A live key was available; it had **no credit balance**, so
everything free could be exercised and nothing billable could.

### What answered

| Request | Result |
|---|---|
| `GET /v1/models` with `x-api-key` | **200**, 11 models |
| `GET /v1/models` with `Authorization: Bearer` | **200**, 11 models |
| `GET /v1/models` with `Bearer` + `anthropic-beta: oauth-2025-04-20` | **200**, 11 models |
| `GET /v1/models` with `Bearer`, no `anthropic-version` | **400** — `anthropic-version: header is required` |
| `POST /v1/messages` | **400** — `Your credit balance is too low...` |

Row two matters for the code: peasant's client only speaks
`Authorization: Bearer`, and that is enough here. No `x-api-key` auth scheme was
needed.

### Two findings worth more than the profile

**The catalogue publishes `max_input_tokens`, and `connect.js` did not know the
name.** Entries carry `max_input_tokens` (1,000,000 on Sonnet 5) and `max_tokens`
(128,000), alongside a `capabilities` object. `windowOf()` checked four other
field names and would have returned null — and a null window means `limitFor()`
returns null, which means `shouldCompact()` is permanently false and the
conversation grows until the provider refuses it. Found by printing a real
catalogue entry, not by anything failing. The field list is one list and it has
to be complete.

**An unpaid account is refused with 400, not 402.**

```json
{"type":"error","error":{"type":"invalid_request_error",
 "message":"Your credit balance is too low to access the Anthropic API..."}}
```

`classify()` maps 400 to `bad-request` on the documented reasoning that "400
means our request is wrong and everyone will say so" — and that reasoning is
right almost always. Here it is the 402 case wearing a 400, and the comment on
`classify()` names the cost exactly: *"not rotating on one provider's billing
problem takes the whole session down."* A profile may now name the refusals that
are about the account rather than the request, via `unavailableWhen`, which is
data in `profiles/` rather than a branch in the client. Anthropic's list is one
narrow pattern; everyone else's is empty.

### Not measured

**No `*-ratelimit-*` header appeared on any response obtained.** So the profile
names none, and the budget is discovered from 429s alone as it is for five of the
six hosted providers. Header names copied out of documentation would be exactly
the guess this project refuses — `RateLimiter` would watch for headers that may
never arrive and report a budget nobody measured.

The model preferences *are* measured, from the 11-entry catalogue: Sonnet 5
first, deliberately not the largest model available, because this bills per token
and a harness makes hundreds of small tool-calling turns.

## NVIDIA, with an API key

Added 2026-09-15, measured. The profile had existed since 2026-09-12 as a set of
assumptions from the OpenAI convention, marked `UNVERIFIED` because there was no
key to test it with. A key arrived; two of the assumptions were wrong.

### What answered

| Request | Result |
|---|---|
| `GET /v1/models` | **200**, 81 models, 247 ms |
| `POST /v1/chat/completions`, `openai/gpt-oss-20b` | **200**, streams, tool args valid JSON |
| `POST /v1/chat/completions`, `nvidia/nemotron-3-super-120b-a12b` | **200**, streams, tool args valid JSON |
| the other five models tried | **404** or a 150-second timeout |

`stream_options: {include_usage: true}` is honoured. Tool arguments arrive
**incrementally** on gpt-oss-20b (six deltas) and whole in one delta on
nemotron-3-super, so one provider exhibits both shapes.

### The catalogue is a shelf, not an inventory

`/v1/models` lists **81** models. This account can call almost none of them.
Four of the seven tried answered:

```json
{"status":404,"title":"Not Found",
 "detail":"Function '<uuid>': Not found for account '<id>'"}
```

That is a statement about the *account*, not about our request, and it is the
same trap as Anthropic's credit-balance 400 one section above. `classify()` maps
404 to `bad-request`, which is **not retryable**, so the router would have
stopped the session dead rather than rotating to a provider that would have
answered. The profile now names the refusal in `unavailableWhen`, which is the
extension point that already existed for exactly this — data in `profiles/`,
no branch in the client.

Two more timed out entirely: `moonshotai/kimi-k3` and
`deepseek-ai/deepseek-v4-flash-0731` both returned nothing at 45 s and nothing
again at 150 s. Listed, not refused, just never answering — which for the router
is worse than a 404, because a timeout costs the wall-clock before it costs
anything else.

### A loose preference pattern selected a guardrail

The unverified profile preferred `/qwen.*coder/i`, then `/llama-3\.[13]/i`, then
`/nemotron/i`. This catalogue contains no Qwen at all, so the second pattern
decided it, and the alphabetically-first match is:

```
nvidia/llama-3.1-nemoguard-8b-content-safety
```

A **content-safety classifier**, selected as the chat model for a coding
harness. It returned HTTP 200 with a 402-token prompt overhead and eight tokens
of output, so nothing looked broken; the streaming probe then hung until the
60-second timeout. Had it been slightly more cooperative this would have shipped.

This is the sharpest version of the warning already in `selectModel` — the one
about Groq's Arabic text-to-speech model — and the reason there is no final
"first one in the list" fallback. NVIDIA's catalogue is a model *zoo*:
guardrails, reward models, document parsers, translators, a deepfake detector
and a CLIP encoder all sit under the same listing as the chat models. The
profile's `prefer` entries are now **anchored to exact ids that were measured
answering**, and `nonChat` names the zoo.

### Not measured

**No `*-ratelimit-*` header appeared on any response**, streamed or not, on
`/models` or on `/chat/completions`. The profile names none. NVIDIA sells
credits rather than metering a free tier, so the thing that eventually stops the
provider is a balance, and the balance is not published on a response header.

`autoEnable` stays **false**: credits run out, and a provider that works until it
abruptly does not belongs where someone put it deliberately.

## Subscription endpoints — Claude Code and Codex

Added 2026-09-15. **Nothing in this section has been measured**, and that is the
first thing to know about it. Every other provider above was probed, its
response captured under `docs/raw/`, and its profile written from what came
back. These two were written from documentation, which in this project is a
claim rather than a fact.

What *has* been measured is that the endpoints exist and that peasant's requests
reach them in a shape they recognise. Unauthenticated `POST`, 2026-09-15:

| URL | Response |
|---|---|
| `https://api.anthropic.com/v1/messages` | `401` — `x-api-key header is required` |
| `https://api.anthropic.com/v1/chat/completions` | `401` — an OpenAI-shaped error envelope, so a compatibility layer exists there too |
| `https://api.openai.com/v1/chat/completions` | `401` — `Authorization: Bearer` |

One further measurement, 2026-09-15, with a **deliberately invalid** OAuth token
placed in a scratch home directory — peasant's own path, end to end:

```
claude-code: listing models failed (HTTP 401): OAuth access token is invalid.
```

The wording is the finding. `/v1/models` did not answer `x-api-key header is
required` and did not 404: it read `Authorization: Bearer` together with
`anthropic-beta: oauth-2025-04-20` as an OAuth attempt and rejected only the
token's value. The auth scheme, the headers and the path are therefore right,
and the credential reader found and forwarded a token from a file laid out the
way the profile expects. Everything past the token's validity remains untested.

### What makes them different in kind

Every provider above is a free tier reached with a key of its own. These two
spend a **subscription**, borrowing the OAuth token that Claude Code or the
Codex CLI has already stored on this machine. That is outside what Anthropic's
and OpenAI's terms permit for a third-party client, and the token can be
revoked. The decision to support them was taken knowingly; both are
`autoEnable: false`, so neither is ever reached by accident.

They also speak different wire formats, which is why `src/provider/dialects/`
exists:

| Provider | Endpoint | Format |
|---|---|---|
| `claude-code` | `https://api.anthropic.com/v1/messages` | Anthropic Messages |
| `codex` | `https://chatgpt.com/backend-api/codex/responses` | OpenAI Responses |

### The four things the Messages format does differently

Each one is load-bearing, and each is why a translation layer was needed rather
than a base URL:

1. The system prompt is a top-level parameter, not a message with a role.
2. A tool result is a *user* message carrying a `tool_result` block, and every
   result for one assistant turn must arrive in a **single** user message. Split
   across two, the API rejects the turn — and the split only happens when a task
   calls two tools at once, so it would not show up in casual use.
3. `max_tokens` is required, with no server-side default. This is the whole
   reason `PEASANT_MAX_OUTPUT_TOKENS` exists; formats that do not require it are
   still not sent it.
4. Streaming is named events over content-block indices. A content block index
   is **not** a tool call index — a response with text at index 0 and a
   `tool_use` at index 1 has one tool call, at tool index 0. Conflating them
   attaches the arguments to a call that does not exist.

Usage also arrives in two halves: `input_tokens` in `message_start`,
`output_tokens` in `message_delta`. Taking either alone reports a turn at half
its real cost, and `TokenEstimator` calibrates itself on that number.

### Credentials

Peasant **reads** `~/.claude/.credentials.json` and `~/.codex/auth.json` and
never writes them. Refreshing an OAuth token rotates it, and rotating another
program's login from underneath it loses both; so an expired token is reported
and the provider skipped, with the remedy named — run `claude` or `codex` once
and it refreshes its own file.

The field names in those files are *candidates* rather than a known path, for
the same reason the rest of this section is unverified. A file matching none of
them is reported with what was looked for and which keys it actually has, so the
list can be corrected in one edit.

### What a first run has to confirm

See `MAINTAINER.md`. In short: the credential files' actual shape, whether
`/v1/models` answers an OAuth token, what `CODEX_MODEL` should be set to, and
whether either endpoint requires anything of the request that peasant does not
currently send.
