# Claude : reading Anthropic's harness-design piece against peasant

2026-09-15. From `INBOX.md`: *read
<https://www.anthropic.com/engineering/harness-design-long-running-apps> and look
for ideas that can be incorporated into peasant.*

## What the article is, and why most of it cannot come here

It describes a multi-agent harness for building whole applications unattended:
a **planner** turning a sentence into a 10–16 feature spec, a **generator**
working sprint by sprint, and a separate **evaluator** driving the running app
through Playwright and grading it against criteria negotiated with the generator
beforehand. Its headline result is a number:

| | Time | Cost |
|---|---|---|
| One agent, no harness | 20 min | **$9** — core functionality broken |
| Full harness | 6 hours | **$200** — complete and polished |

Twenty times the cost for twenty times the quality, and a second worked example
at $124.70 for 3h50m.

**That is the exact axis peasant is built to refuse.** Groq gives us 8,000
tokens a minute and Mistral 625,000, for nothing. A harness whose central
finding is "spend 20x" has little to sell a project whose specification is "spend
nothing". The planner/generator/evaluator split, sprint contracts, Playwright-
driven QA and 5–15 iteration aesthetic loops are all priced out of this codebase
and should not be attempted here. Saying so is most of the value of having read
it.

Three things do transfer, and one of them is a live problem in the code today.

## 1. Context anxiety, which peasant may be maximising

The article's most transferable observation is a failure mode it calls **context
anxiety**: models "wrapping up work prematurely as they approach what they
believe is their context limit". Its fix was to stop compacting and instead
*reset* the context entirely, handing state to the next agent through a file —
because compaction "preserves continuity but leaves anxiety intact", while a
reset gives a clean slate.

Peasant tells the model its budget is tight more often, and more explicitly,
than any harness in that article. Three places, all found by grep rather than
by memory:

- `src/agent/prompt.js`, resent on **every turn of every session**:

      Token budget is tight. Read narrow windows of files rather than whole ones,

- `src/agent/Compactor.js:164`, injected into the conversation:

      [N earlier messages dropped to fit the token budget]

- `src/tools/Tool.js:89` and `Compactor.js:247`, on tool results:

      ... [N characters omitted of M] ...
      [N characters elided by compaction]

Every one of those is there for a good reason and each saves real tokens — at
8,000 TPM one careless file read costs most of a minute. But together they are a
standing, repeated signal that the model is running out of room, which is
precisely the stimulus the article identifies as causing early abandonment. On a
small free-tier context window, compaction fires *often*, so peasant emits these
signals far more than a harness with a 1M window ever would.

**This is a question, not a finding.** Whether the line costs more in abandoned
tasks than it saves in tokens is unknown, and CLAUDE.md is explicit that budget
changes are measured rather than asserted. It is cheap to measure: run a fixed
task with and without the sentence and record turns, tokens and whether the task
finished. That is a `docs/entries/` measurement, and it is `TODO.md` **H2** — blocked on
**H1**, because there is currently no way to run a fixed task and get numbers
back.

There is a related note already in `TODO.md` that reads differently in this
light: *"a model that keeps re-reading what was just elided could loop"*. Both
are symptoms of the same thing — the model reacting to visible evidence that its
context is being taken away.

## 2. Reset with a handoff file, which is *cheaper* here, not dearer

The article treats context reset as a costly complication — extra orchestration,
extra tokens, more latency — worth it only for multi-hour runs.

For peasant the economics invert. `Compactor` summarises the older half of a
conversation and keeps the summary *plus* the recent turns in context, paying for
both on every subsequent turn. A reset that writes a handoff file and starts
clean pays for the file once, when it is read. On an 8,000 TPM budget that is
the cheaper option, not the more expensive one, and the machinery is half built:
`session/Store` already writes a `reset` record where compaction replaces
history, so the transcript format anticipates it.

Worth prototyping and measuring against the current compactor on a fixed task.
`TODO.md` **H3**.

## 3. "Every component encodes an assumption about what the model can't do"

The article's closing principle, and the one that should outlive the rest of it:

> Every component in a harness encodes an assumption about what the model can't
> do on its own.

with the corollary that when models improve you should **strip pieces out** and
re-measure, not merely add. It removed its own sprint construct that way.

Peasant has a sharper version of this problem than the article does, and it is
worth stating plainly: **peasant rotates providers mid-session**, so one
conversation may run on a 20B model on Groq and a large one on Mistral within the
same task. Every scaffold here is therefore tuned to the *weakest* model in the
rotation, and there is no single model whose improvement would let a piece be
removed. That is a real constraint on ever simplifying this codebase, and it
follows from the specification rather than from anything done wrong.

Added to `docs/architecture.md` as a principle.

## The thing all three needed

Writing these up as actions made something obvious that reading did not: every
one of them is a claim about behaviour, and peasant has no way to test a claim
about behaviour. CLAUDE.md already prescribes the protocol — "record tokens used,
turns and wall time for a fixed task in `docs/entries/`" — and nothing exists to
carry it out, so it has never been done. That is now `TODO.md` **H1**, and H2 and
H4 are blocked on it. A manual protocol wanted three times is a script.

## What I deliberately did not take

- **A second agent to evaluate the first.** The article is convincing that
  self-evaluation is biased — "agents tend to respond by confidently praising the
  work" — and peasant's loop does exactly that: it ends when the model says it is
  done, with nothing checking. But an evaluator agent doubles token spend at
  minimum, and the affordable mitigation is the one already sitting there: run
  the project's tests with `bash` and read the output. `TODO.md` **H4**, as a
  prompt question and a measurement, not an architecture change. It may turn out
  to be unaffordable too — a full test run's output through
  `maxToolResultChars`, on a budget where one careless read costs most of a
  minute — and that would itself be a result.
- **Sprint contracts, planner agents, Playwright QA, aesthetic scoring loops.**
  Different product, different budget.

## Provenance

The article was read once, via the harness's fetch tool, on 2026-09-15. Figures
above are quoted from it. The three peasant code locations were found by grep in
this session and are cited by file and line; nothing about peasant's behaviour
under those prompts has been measured, and this entry does not claim otherwise.

This is also the first real material for `docs/prior-art.md` (Phase R4), which is
still unwritten. One article is not a prior-art survey, so it stays here until
there is more.
