# agent-memory-bench

A long-history memory benchmark for chat assistants: four synthetic people, 90 days of private chat each, 175 questions asked on day 91, and nine memory designs run against them.

It's the harness and the full data behind [Summary Memory Gets Worse the More You Use It](https://www.systemind.io/blog/assistant-memory-heavy-users).

| design | overall | heaviest user (1,188 msgs) |
|---|---|---|
| full context (whole history) | 77.1 | 76 |
| summary + fact recall | 67.6 | 63 |
| tiered compaction | 67.6 | 73 |
| index + notes + recall | 66.7 | 66 |
| fact store (Mem0-style) | 62.6 | 69 |
| append-only ledger | 62.4 | 52 |
| **rolling summary** (baseline) | 61.6 | 48 |
| index + topic notes | 61.0 | 66 |
| no memory (last 14 messages) | 50.9 | 48 |

Scores are out of 100, two independent runs pooled per question. 95% intervals are in `data/pooled.json`.

## What's here

```
harness/   the pipeline (Node 22+, no dependencies)
data/
  run1-openrouter/   first run: providers picked by OpenRouter
  run2-azure/        second run: pinned to one provider
  pooled.json        both runs pooled, with paired-bootstrap intervals
```

Each run directory has the same layout, and it's what the harness reads and writes:

| path | what |
|---|---|
| `chat/<person>.json` | 90 days of chat: `messages[]` with `i`, `day` (1 = Aug 3 2026), `time`, `who` (`u` = the person, `a` = the assistant), `text` |
| `spec/<person>.json` | the planted events and the `probes` (questions): `id`, `kind`, `q`, `gold`, `evidence` (message ids) |
| `audit/<person>.json` | the audit: questions excluded as ambiguous, gold answers corrected |
| `mem/<design>/<person>.json` | each design's memory after 90 days |
| `ans/<design>/<person>/<question>.json` | the answer, with every tool call |
| `judge/…`, `judge2/…` | first verdict, and the second look with chat context (it wins when present) |
| `summary.json`, `diag.json` | per-run scores; memory sizes, plain-text replies, per-question detail |
| `spend.jsonl` | every model call: tag, provider, tokens, cost |

The chats, questions, audit and built memories are the same in both runs; only the answers and verdicts differ.

## Question kinds

| kind | per person | example |
|---|---|---|
| `recall`: an old fact | 10 | "What was Q3's actual revenue? Grace wants the final number." |
| `update`: a fact that changed | 6 | "What's the billing cutover date?" (set, then moved twice) |
| `temporal`: when it happened | 5 | "Ravi's integration was due Sep 15. When did it actually go live?" |
| `aggregate`: counting across sessions | 5 | "How many data engineering candidates did we interview?" |
| `open_loop`: a promise's status | 5 | "Did I ever send Priya the timeline doc?" |
| `ask`: how to treat them | 4 | "morning" (weeks after asking for a nickname) |
| `pref_apply`: a work preference | 4 | "Draft a PR description" (they end with a Risk section) |
| `abstain`: something never said | 6 | "When is Tom's vacation?" (only Lena's came up) |

The promise questions are the `open_loop` ones. To list them with their gold answers:

```bash
for f in data/run2-azure/spec/*.json; do jq -r --arg p "$(basename $f .json)" '.probes[] | select(.kind=="open_loop") | "\($p)  \(.id)  \(.q)\n    gold: \(.gold)"' "$f"; done
```

## Running it

Any OpenAI-compatible endpoint works. The published runs went through OpenRouter.

```bash
cd harness
export API_KEY=...                       # or put it in harness/.key
export GW=https://openrouter.ai/api/v1   # the default
export MODEL_FAST=...                    # writes memories and answers (we used DeepSeek-V4-Flash)
export MODEL_STRONG=...                  # grades (we used DeepSeek-V4-Pro)
export PROVIDER=...                      # optional: pin MODEL_FAST to one upstream (OpenRouter's provider.order)
export BUDGET_USD=5                      # every stage stops before this
```

Re-score the published run without calling a model:

```bash
OUT=../data/run2-azure node analyze.mjs
node pooled.mjs ../data/run1-openrouter ../data/run2-azure
```

Test your own memory design on the same chats. Copy the inputs (and the built baseline memories) into a fresh run directory, build yours, answer, grade:

```bash
mkdir -p out && cp -r ../data/run2-azure/{chat,spec,audit,mem} out/
node build.mjs --arms mine                 # replays the 90 days in time order
node answer.mjs --arms mine,rewrite --kind open_loop
node judge.mjs && node rejudge.mjs && node analyze.mjs
```

`MOCK=1` runs every stage with canned replies, to check the plumbing for free.

## Adding a design

A design is an object in `harness/arms.mjs`, added to `ARMS`:

```js
const mine = {
  label: "My memory",
  recentN: 14,                                   // recent messages shown verbatim
  init: () => ({ /* your state */ }),
  day: async (st, msgs, { me, tag, day }) => {}, // called once per day, in order, with that day's messages
  context: (st, question) => "",                 // the memory block in the answering prompt
  tools: { ...SEARCH_CHAT },                     // tools the answering model can call
};
```

Wrap `day` in `batched(...)` to write on the same schedule as the other designs: after 8 new turns, 4 of them from the person, at least 3 hours since the last write. Every design keeps `search_chat`. `rewrite`, `facts` and `rewrite_facts` in the same file are good starting points.

## Things that bit us

- **Pin a provider.** Some upstreams ignore JSON mode on long prompts (8k–60k tokens) and answer in plain text, which can't call a tool. Short prompts work, so a smoke test passes. Check `plain` per design in `diag.json` before comparing designs.
- **Grade with context.** A grader that sees only the planted evidence marks true details from elsewhere in the chat as made up. `rejudge.mjs` gives every negative verdict a second look with the chat around it.
- **Count failures per design.** Unparseable replies, which provider served each call (`spend.jsonl`), and grader misses each moved our scores by several points.

## Limits

The people are synthetic. There are four of them, with about 44 questions each, so one person's score carries roughly ±7 points of noise. One answering model, a simplified assistant prompt, a model grader, BM25 rather than embeddings, and one implementation per design. The prompts are the assistant's ([aicoo](https://www.aicoo.io)) as of November 2026, including its production memory-rewrite prompt for the baseline.

## License

Code: MIT. Data: CC BY 4.0. If you run a design against it, we'd like to hear how it did.
