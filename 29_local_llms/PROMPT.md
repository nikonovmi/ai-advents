# Day 29 — Optimizing a local LLM

Day 29 of my AI challenge: optimize the local model for my specific task, then compare
quality, speed and resource usage before and after.

**The task:** the Knowledge agent's RAG chat in `first-agent`, running fully locally on
`qwen3.5:9b` (Ollama) on a MacBook Air M2 with 16 GB RAM. gemma4:12b is out of scope: Day 28
showed it doesn't fit this machine.

**Drop gemma from the app first.**
- Set `LOCAL_MODELS=qwen3.5:9b` and `LOCAL_DEFAULT_MODEL=qwen3.5:9b` in `.env` and
  `.env.example`, so the Model switch, `eval:local` and `verify:local` only use qwen unless a
  model is named explicitly.
- Fix any place that still assumes or defaults to gemma.
- Don't delete gemma's Day 28 results: the reports and the Local tab keep them as history.

Before writing code, read `reports/local_rag_report.md` and `reports/local_rag_notes.md`
(Day 28), plus `eval:local`, `verify:local`, the router prompt, and the `submit_answer`
contract prompt.

Day 28 found two problems to fix:
- **Resources and speed.** RAG calls ran at `num_ctx` 16384. The prompts use about 2k tokens
  (~4k with a retry), yet qwen grew to 9.6 GB. Plain chat ran at 8192, so moving between plain
  chat and RAG reloaded the model.
- **Quality**, in three places:
  - q06: the model joined two separate lines of a chunk into one quote, and the retry didn't
    fix it.
  - q12: a false "I don't know". The documents say Web is Beta and early adopters can ship to
    production, and qwen read that as not an answer.
  - verify:local turn 2: the router routed a rule-setting message correctly but returned an
    empty memory patch.

## Two experiments, nothing else

### Experiment 1 — context window (parameter)

Run every local call at `num_ctx` 8192: plain chat, router, answer and clarification. Use
the same value everywhere, so the model loads once and stays loaded.

This is an env change (`LOCAL_NUM_CTX`, `LOCAL_RAG_NUM_CTX`). The code changes are only what's
needed to make sure every local call uses the value and to count model reloads. A reload is a
response whose `load_duration` is more than 1 s after the first request. Keep the
`possible_truncation` flag active, because it tells us whether 8192 is too small.

### Experiment 2 — prompt template (on top of Experiment 1)

Add a second prompt variant for local models, selected with `LOCAL_PROMPT_VARIANT=v2`.
Keep the default `v1` exactly as it is today, so the baseline stays reproducible. Claude
always uses its current prompts. `v2` changes only two prompts:

- **Contract prompt** (`submit_answer`):
  - one short worked example showing two lines of a chunk cited as two citations, each a
    verbatim quote from one line (one line, one quote);
  - one sentence saying a qualified answer is still an answer: if the documents say
    something is Beta but usable in production by early adopters, answer that and cite it,
    don't decline.
- **Router prompt:** one or two short examples of a message that sets a rule or defines a
  term, routed to `memory_only` with the matching `memory_patch` operations filled in.

Remove rules that are repeated, or that the examples now show, so that `v2` is **not longer
than `v1`**. Prompt length is the main speed cost on this machine. Report the token count
of each prompt in `v1` and `v2`.

Don't change the verification, its thresholds, the retry, or the JSON schemas. The bar
stays where it was on Days 24 and 28.

## Runs

Add `--variant` to `eval:local` and `verify:local`. Run qwen3.5:9b only, in this order:

| variant | num_ctx (all calls) | prompts |
| --- | --- | --- |
| `baseline` | 16384 RAG / 8192 plain (Day 28 settings) | v1 |
| `ctx8k` | 8192 | v1 |
| `ctx8k+prompt` | 8192 | v2 |

For each variant, run the 10 citations questions with `eval:local`. Reuse Day 28's cached
retrieval (`local_rag_retrieval.json`) so every variant gets the same chunks. Then run
`verify:local` with only the Knowledge RAG conversation on qwen.

Re-run the baseline instead of reusing Day 28's numbers, so all three are measured under the
same conditions. Wait `--cooldown` seconds between variants (default 180, the Air is
fanless), and record each run's start time.

Don't re-run Claude or gemma. Show Day 28's Claude column as a reference only.

## What to measure, per variant

- **Quality** (the Day 28 rows for qwen): answered with a source and a valid citation;
  fabricated quotes on the first attempt; retries, dropped citations and downgrades;
  faithfulness with claim counts; correct and false "I don't know"; mean fact score; and
  q06, q12 shown on their own.
- **Router / memory:** every verify:local check, and for turn 2 the intent and memory patch
  side by side.
- **Speed:** time to first token, generation tokens/s, answer latency (mean and max), prompt
  tokens and output tokens per question, and the chat-turn times from verify:local.
- **Resources:** memory from `/api/ps` (total and on GPU) after the run, model reloads, and
  possible truncations.

## Decision rule (decided before the runs)

`ctx8k` is adopted if it has 0 possible truncations and no quality row gets worse by more
than one question.

`ctx8k+prompt` is adopted on top of it if all of these hold:
- the fact score is ≥ the baseline's;
- there are no new false "I don't know"s;
- faithfulness doesn't drop;
- verify:local's memory check passes.

Targets to report against: answer latency well under 30 s mean, and memory well under 9.6 GB.

Adopted settings become the defaults in `.env.example` and the README. If something isn't
adopted, say which rule it failed.

## Output

- `reports/local_opt_results.json` and `reports/local_opt_report.md`. The report has a summary
  with the three variants as columns (and Day 28's Claude column as a reference), then the
  question-by-question table, then the `v1` vs `v2` prompts as a diff.
- `reports/local_opt_notes.md`: findings from the actual numbers. What each experiment
  changed, what it cost, and the decision under the rule above.
- An **Optimization** tab on `/rag-report`.
- A short **Not tried** section in the notes:
  - **Quantization:** the quantization qwen3.5:9b already runs at (from `/api/show`), and an
    estimate of why q8 doesn't fit in 16 GB next to the reranker and the embedding model.
  - **Fewer chunks:** a retrieval change, not a model one, with a recall risk.
  - **Temperature:** stays at 0 for a strict citation contract.

## Tests

`npm test` stays offline. Test that:
- the variant selects the right `num_ctx` and prompts;
- every local call uses the one configured `num_ctx`;
- reloads are counted from `load_duration`;
- `v1` prompts are byte-for-byte unchanged;
- Claude never gets `v2`;
- `v2` is not longer than `v1` (in characters as an offline proxy).

## Docs

- first-agent README: an **Optimization (Day 29)** section with the variants, the decision,
  and the new defaults.
- Repo root README: a "Day 29 — Optimizing a local LLM" section at the top, like the previous
  days. Two or three sentences, the summary table with real numbers, and links to the report
  and notes.

## Finish

1. Run `npm test`.
2. Run the three variants. Stop and tell me if the baseline differs a lot from Day 28's qwen
   column (fact score off by more than 0.1, or latency off by more than 30%), because
   something in the setup changed.
3. Show me the summary table and the decision.
4. Start the server with the adopted settings so I can try it at http://localhost:3000.
