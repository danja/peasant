# Claude : NVIDIA, from assumption to measurement

A key for NVIDIA NIM arrived in `.env`. The profile had existed since
2026-09-12 as a set of assumptions from the OpenAI convention, carrying the
`UNVERIFIED` comment the guard test requires. This is what happened when it met
a real endpoint.

## The short version

NVIDIA works. It streams, it honours `stream_options.include_usage`, and its
tool-call arguments come back as valid JSON. `verified: true`, captures in
`docs/raw/2026-09-15_providers/`.

Two of the assumptions in the profile were wrong, and one of them was the
dangerous kind — the kind that returns HTTP 200.

## The profile selected a guardrail as the chat model

The unverified `prefer` list was:

```js
prefer: [/qwen.*coder/i, /llama-3\.[13]/i, /nemotron/i],
```

NVIDIA's catalogue contains no Qwen model at all, so the first pattern never
fired and the second decided it. Model ids sort alphabetically, and the
alphabetically-first match for `/llama-3\.[13]/i` is:

```
nvidia/llama-3.1-nemoguard-8b-content-safety
```

The first probe run therefore had peasant holding a conversation with a
**content-safety classifier**. It answered **HTTP 200**. It reported 402 prompt
tokens for the sentence "Reply with the single word: ok" — the overhead of the
guardrail's own built-in rubric — and produced eight tokens of output. Nothing
in that line of output looks wrong. The run only fell over at the next step,
when the streaming probe hung until the 60-second timeout.

That is the failure mode `selectModel` already had a comment about, referring to
Groq's Arabic text-to-speech model, and it is the reason there is no final
"just take the first one" fallback in that function. NVIDIA is the sharpest case
because its `/v1/models` is a model *zoo*: guardrails, reward models, document
parsers, translators, a CLIP encoder and a deepfake detector, all listed
alongside the chat models with nothing in the response distinguishing them.

`prefer` is now anchored to exact ids that were measured answering. `nonChat`
names the zoo, so the "set `NVIDIA_MODEL` to one of:" error stays honest.

## The catalogue over-reports by a wide margin

`/v1/models` lists **81** models. Seven were tried:

| Model | Result |
|---|---|
| `openai/gpt-oss-20b` | 200, 2.9 s, tool args across 10 deltas |
| `nvidia/nemotron-3-super-120b-a12b` | 200, 2.7 s, tool args whole in one delta |
| `nvidia/nemotron-nano-3-30b-a3b` | 404 |
| `z-ai/glm-5.3-flash` | 404 |
| `mistralai/codestral-22b-instruct-v0.1` | 404 |
| `nvidia/llama-3.1-nemotron-70b-instruct` | 404 |
| `moonshotai/kimi-k3` | timeout at 45 s, and again at 150 s |
| `deepseek-ai/deepseek-v4-flash-0731` | timeout at 45 s, and again at 150 s |

The 404s carry `"Not found for account"`. The listing is NVIDIA's shelf; what
the account may call is a much smaller set, and the API offers no way to ask
which.

This matters more than a preference list, because `classify()` maps 404 to
`bad-request` and `bad-request` is **not retryable**. Left alone, a model that
went away would stop a session dead rather than rotating to a provider that
would have answered. The profile now names the refusal in `unavailableWhen` —
the extension point added for Anthropic's credit-balance 400 two days ago, which
turns out to have been the right shape: data in `profiles/`, no branch in the
client, and the second provider to need it needed no code at all.

## No rate-limit headers, and none are coming

Nothing matching `*-ratelimit-*` appeared on any response — `/models` or
`/chat/completions`, streamed or not. The profile names none and the budget is
discovered from 429s, as it is for five of the seven hosted providers now.

Worth being clear about *why*, because it is different from the others: NVIDIA
sells credits rather than metering a free tier. The thing that eventually stops
it is a balance, and a balance is not the sort of thing that appears on a
response header. There is no header to go looking for later. `autoEnable` stays
false and `MAINTAINER.md` records that checking the balance is a human errand.

## What the probe broke on the way

Running `probe-providers.js --only nvidia` wrote a new dated capture directory
containing two NVIDIA files, and four unrelated tests failed immediately — one
with a bare `ENOENT` on a Mistral capture that was sitting untouched on disk.

`tests/unit/lib/fixtures.js` resolved captures by taking the newest capture
*directory*. The intent was right: re-probing should update the tests rather
than leave them asserting against a shape no provider produces any more. The
implementation assumed every probe run covers every provider, and `--only`
exists precisely so that it does not. The probe grew a flag; the loader never
heard about it.

It is now indexed per filename, newest run of each file winning, so a run that
did not ask about Mistral says nothing about Mistral. `tests/unit/fixtures.test.js`
is new and asserts that property directly, rather than leaving it to be inferred
from four other tests breaking for a reason that points elsewhere. Recorded in
`MISTAKES.md` and as a row in the CLAUDE.md recurring-failure table.

The probe also claimed `skipped, no key: groq (GROQ_API_KEY)` about an account
whose key was in `.env` and working — `--only` and "no key" were being reported
on one line. A probe that lies about the thing it exists to find out is worse
than one that says nothing, so they are two lines now.

## Still open

- **Together** is the last unkeyed provider.
- The two models that time out may simply be cold-starting behind a scale-to-zero
  endpoint. Neither answered at 150 s, so neither is in `prefer`, but a slow
  first call is different from a broken one and this was not chased further.
- `.env` currently lists NVIDIA **first** in `PEASANT_PROVIDERS`, which spends
  the finite provider before the renewable ones. Flagged in `MAINTAINER.md` as a
  decision rather than changed.


## Follow-on: `peasant doctor` now asks the question

Written the same day, because the NVIDIA guardrail was the fifth time a
preference list chosen from names rather than behaviour reached the code, and
the first time one answered **HTTP 200**. The four before it failed loudly — a
404, a `422 UNSUPPORTED_OPENAI_PARAMS`, `selectModel` refusing outright. This
one was caught because an unrelated probe hung.

`src/provider/tool-check.js` sends the selected model one trivial tool call and
asks three questions in order: did a tool call come back, did its arguments
parse, and do they match the schema the model was shown. That last step uses the
project's own `validate()` from `src/tools/schema.js`, so the schema advertised
is the schema checked — the rule `tool-schema.test.js` already holds the real
tools to.

Three decisions worth recording.

**On by default.** `doctor` is the deliberate "is everything all right" command,
and a check that must be remembered is a check that will not be run — the same
reasoning as the exported-list principle in CLAUDE.md. It is the only part of
`doctor` that spends tokens, about 200 per provider, and the total is printed
rather than left to be guessed at. `--no-tool-check` skips it.

**It never throws.** Every failure it can see is a result: a 400 is `refused`, an
unreachable host is `failed`, a polite non-answer is `noToolCall`. A diagnostic
that dies on the thing it is diagnosing is worthless. The one exception is
Ctrl-C, which is re-thrown — reporting a user's interrupt as `nvidia FAIL` would
be a lie about a provider.

**It has a timeout, and the timeout is a preference.** Hanging is not
hypothetical here: two models in this catalogue returned nothing at 45 seconds
and nothing again at 150. `PEASANT_TOOL_CHECK_TIMEOUT_MS` defaults to 30 s,
against a slowest measured pass of 3.3 s. `checkToolCall` throws rather than
defaulting if a caller omits it, because the caller that forgets is the caller
that hangs.

The probe's own tool definition is gone; both it and the check now import
`CHECK_TOOL` from one place. A check and the probe that informs it asking
different questions is the drift CLAUDE.md keeps a table for.

Verified against the real thing, which is the only reason to believe any of it:

```
tool calls
  nvidia      ok    openai/gpt-oss-20b — get_weather({"city":"Paris"}) (677 ms)
  groq        ok    openai/gpt-oss-20b — get_weather({"city":"Paris","unit":"c"}) (230 ms)
  408 tokens spent asking
```

And pointed back at the model that started it:

```
  nvidia      FAIL  nvidia/llama-3.1-nemoguard-8b-content-safety — refused the request
                    nvidia: completion failed (HTTP 400)
                    a coding harness needs tool calls; set NVIDIA_MODEL to another model
```

Note what that last one shows: the guardrail answers 200 to a plain chat request
and 400 to one carrying `tools`. The shape of the failure is different depending
on what you ask, which is precisely why asking the real question matters.

## Follow-on 2: Gemini's `thought_signature`, and what a capture does not prove

A 503 on `models/gemini-3.8-flash` sent the user to `gemini-3.5-flash`, which
then produced a 400 they described as intermittent. It was not intermittent.
`peasant ask` sends no tools and always worked; `peasant run` sends tools and
always failed on the turn that returns a tool result. "Sometimes" was two
different commands.

```
HTTP 400  INVALID_ARGUMENT
"Function call is missing a thought_signature in functionCall parts."
```

Gemini 3.x attaches an opaque signature to every function call and requires it
back. It rides on the call itself, as `extra_content.google.thought_signature`.
peasant dropped it twice: `ToolCallAssembler.push()` read four fields and
ignored the rest, and `Conversation.assistant()` then rebuilt the message from
three of them.

**The part worth keeping.** The proof was already committed. The first line of
`docs/raw/2026-09-12_providers/google-tools.sse` carries the signature in full,
and five tests run against that file on every `npm test` — three in
`sse-parser.test.js`, two in `tool-call-assembler.test.js`. All five passed
throughout. None of them looks at a field it was not already expecting.

A recorded response is evidence of what a provider *sends*. Every test asked
whether we could read the parts we already knew about, and nothing anywhere
compared the two. A provider can therefore add a field, make it mandatory, and
break the harness while the suite stays green and the evidence sits in the repo.

## The fix is a rule, not a special case

`ToolCallAssembler` now collects everything on a tool call that is not `index`,
`id`, `type` or `function` into `extra`. `Conversation.assistant()` spreads that
back onto the outgoing message — *before* `id`, `type` and `function`, so a
provider field can never overwrite the three peasant is responsible for.

Nothing names Google, which `profile-coverage.test.js` would refuse anyway.
`extra_content` is an OpenAI-compatibility extension, so it is a property of the
wire format, and the rule is general: **an opaque field a provider attached to a
call belongs to the provider and goes back untouched.** Reasoning stays the
deliberate exception — that one is ours to drop, no provider requires it echoed,
and it is most of the token bill.

`chat-completions` passes messages through verbatim, so it needed no change.
`messages` and `responses` build their own structures from `id`, `name` and
`arguments` and ignore the rest, so they were already safe.

## The probe now takes a second turn

The probe sent one request and read the answer. It had no `role: 'tool'` message
anywhere, so it proved a tool call *arrives* and never that a conversation can
continue past one — which is the whole of what a harness needs, and exactly
where Google broke.

It now answers its own tool call and captures the result as
`<provider>-turn2.sse`. It rebuilds the assistant turn with the real
`ToolCallAssembler` and the message shape `Conversation` produces, deliberately:
the question is not what the provider sent, it is whether what *peasant* sends
back is accepted. The report names which provider fields were echoed.

```
=== nvidia ===
  turn 2        HTTP 200, 307 ms, extras echoed=none
=== groq ===
  turn 2        HTTP 200, 262 ms, extras echoed=none
```

## What is proven, and what is not

Proven: the signature survives assembly, survives `Conversation`, survives a
transcript round trip, and reaches the serialised request body. Proven against
the real captured Google bytes rather than an invented fixture. And one test
walks every tool capture on disk and fails if any provider field goes missing
between the response and the next request — the general form of the bug, which
would have failed on 2026-09-12.

Not proven: a live Gemini session getting past turn two. The investigation
exhausted Google's free tier — five requests a minute on `gemini-3.5-flash`, and
a second bucket of twenty — and after three waits of up to two minutes it was
still returning 429. Confirming it costs about four requests against a clear
window, and it is the open item at the top of `TODO.md`.

Stopping there was deliberate. The alternative was spending more of someone
else's metered quota to confirm what Google had already stated in plain English
in the error message.
