# Providers

What the providers actually do, measured. Evidence in
`raw/2026-09-12_providers/`; re-measure with `node bin/probe-providers.js`.

Keyed as of 2026-09-12: **Groq**, **Mistral**, **Cerebras**, **OpenRouter**,
**Google AI Studio**, **Hugging Face**. Unkeyed: NVIDIA, Together.

| Provider | Chat | Streams | Rate-limit headers | Tool-call shape | Profile |
|---|---|---|---|---|---|
| groq | 200 | yes | **full** | whole in one delta | verified |
| mistral | 200, later 429 | yes | **partial** (no reset) | whole in one delta | verified |
| openrouter | 200 | yes | **none** | incremental | verified |
| google | 200 | yes | **none** | whole in one delta | verified |
| huggingface | 200 | yes | **none** | incremental | verified |
| cerebras | **402** | never seen | **none** | unknown | unverified |

**Five of six publish no usable rate-limit headers.** Only Groq says everything.
That is the shape of the problem, and it is why the limiter treats `null` as
unknown rather than empty, and why rotation is on by default.

## The headline

**Published free-tier figures are not to be trusted, and most providers publish
no limits at runtime either.** Three of the four give the limiter nothing to
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

**OpenRouter and Cerebras publish nothing.** Their budget is discovered only
from 429s.

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

## Model choice is where the failures are

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

An account action, not a code problem — see `danja-todo.md`. A 402 is
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
  leaves the machine. `OpenAICompatClient` refuses `http://` to anything else,
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
