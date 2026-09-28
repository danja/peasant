# Claude : OpenCode Zen, Ollama's context window, and a free-tier survey

2026-09-28. One session, three pieces of work, and no live endpoint reachable
from it. Every provider claim below comes from documentation or third-party
lists unless it says "measured".

## OpenCode Zen

Added the `opencode` profile (commit `9d819b3`) for
`muse-spark-1.3-contributor-free`, using the `responses` dialect because the
contributor-free models are reported to 500 on chat completions.

**Measured by the maintainer the same day:** HTTP 403, "OpenCode's free tier can
only be used from within OpenCode". The router retired it correctly. We are not
working around the refusal: doing so would mean impersonating OpenCode's
client. The profile stays for paid Zen models, which have not been tried.

## Ollama: a silent truncation nothing could see

The `ollama` profile existed and had answered a `peasant ask`. The problem is
what happens in a real session. Ollama's OpenAI endpoint takes no context size.
The server's default is 4,096 tokens on a machine without a large GPU, and past
that it drops the start of the conversation without an error. Its `/v1/models`
reports no window, so `ContextBudget.limitFor()` returned null and compaction
never triggered. `connect.js` also carried a comment claiming Ollama's
catalogue publishes a context length. It does not.

Fix: a profile field, `contextWindowVar`, naming the environment variable that
holds the server's real window. `ollama` reads `OLLAMA_CONTEXT_LENGTH` and
`llamacpp` reads `LLAMA_ARG_CTX_SIZE`: the same variables the servers read, so
one line configures both. A stated window wins over the catalogue, and a
malformed one throws. `tests/unit/connect.test.js` drives `connect()` against
`FakeProvider` through the ollama profile. Reverting `??=` to `=` fails it,
which was checked.

## Keyless requests send no Authorization header

`Client` sent `Authorization: Bearer ` with an empty key. Local servers ignore
it; an anonymous gateway may reject it as a malformed credential. It now sends no
header when there is no key.

## Survey

See `docs/providers.md`, "Free tiers surveyed 2026-09-28". Three profiles were
added, all unverified and off by default: `kilo`, which needs no key for its
`:free` models (200 requests/hour), `ollama-cloud` and `zai`. Reportedly
Cerebras and Together are no longer free. `MAINTAINER.md` lists the one run each
needs.
