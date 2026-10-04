# Day 23 — Reranking, filtering and query rewriting

Extend the Day 22 RAG in `first-agent` (it uses `search()` from `doc_index`) with a
second retrieval stage and query rewriting. Then compare the modes with the existing
eval. Read both READMEs and the Day 22 code (`src/rag/`, `eval/rag/`) first. Reuse the
existing pieces (answer function, judge, report, `/rag-report`) and extend them. Build
only what this spec asks for.

## Pipeline

```
question → [rewrite] → vector search (K_RETRIEVE) → [rerank + cutoff] → top K_FINAL → LLM
```

Brackets are optional stages, each switched on or off per request.

### Rewrite (optional)

- One call to the project's existing chat model, temperature 0, forced tool
  `submit_queries`. It turns the user's question into **1–3 standalone search queries**:
  strip filler, use the terms a document would use, and split multi-part questions
  into one query per part. A simple question gives exactly one query.
- Run a vector search for each query and merge the results by `chunk_id`, keeping each
  chunk's best score.
- The LLM still answers the **original** question. Rewriting affects retrieval only.

### Rerank + cutoff (optional)

- A local cross-encoder, **`onnx-community/bge-reranker-v2-m3-ONNX`**, loaded with
  `@huggingface/transformers` (the version `doc_index` already uses). Use a quantized
  variant if the repo has one. Load it lazily on first use, reuse it afterwards, and log
  one line when it's ready, the same way as the embedder.
- Score every (question, chunk text) pair among the retrieved candidates. Convert the
  logit to 0–1 with a sigmoid, sort by that score, and drop chunks below
  `RERANK_THRESHOLD`. Keep the top `K_FINAL` of what's left.
- Rerank against the **original** question, even when rewriting is on.
- **If nothing passes the cutoff**: don't call the answering LLM. Return a fixed answer
  saying the documents don't cover the question, along with the best rejected chunks
  for display.
- With rerank off, the pipeline is the Day 22 baseline: top `K_FINAL` by vector score
  and no cutoff.

### Config

Read from env, with defaults:

| var | default | meaning |
| --- | --- | --- |
| `RAG_K_RETRIEVE` | 20 | candidates from vector search (per query when rewriting) |
| `RAG_K_FINAL` | 5 | chunks sent to the LLM |
| `RAG_RERANK_THRESHOLD` | set from the calibration below | cutoff on the 0–1 rerank score |

`RAG_K_RETRIEVE` only matters when rerank is on. With rerank off, retrieve `K_FINAL`
as before.

**Choose the threshold once, with evidence.** Run the reranker over
`doc_index/eval/questions.json` (Day 21's 20 retrieval questions, separate from the
answer eval, so the threshold isn't tuned on the questions it's judged on). Look at the
score distribution of chunks containing the expected text versus all the others, and
pick a cutoff that keeps nearly all relevant chunks. Record the numbers and the
reasoning in `reports/rag_notes.md`. This can be a one-off run. No permanent tooling
is needed.

### Answer function

Extend `answerQuestion(question, { mode, rerank, rewrite, … })`. Its result
additionally returns:

```js
{ queries,                 // what was searched (the original question or the rewrites)
  candidates: [{ chunk_id, source, section, vectorScore, rerankScore, kept }],
  chunks,                  // the final chunks sent to the LLM (as before)
  declined,                // true when nothing passed the cutoff
  timings: { rewriteMs, retrieveMs, rerankMs, llmMs }, usage }
```

## UI (Knowledge agent)

- When RAG is on, show two more switches next to the RAG toggle: **Rerank** and
  **Rewrite**. They're stored per chat like the RAG toggle, and the message badge shows
  the mode used (`rag`, `rag+rerank`, `rag+rewrite+rerank`, …).
- Sources panel: for each kept chunk, show the vector score and the rerank score. Below
  the kept chunks, list the dropped candidates (greyed out, collapsed by default) with
  their scores. If rewriting was on, show the queries that were searched.
- A declined answer shows the fixed message plus the best rejected chunks.

## Eval

### Questions

Keep the 10 Day 22 questions unchanged as the regression set, and add **6 new ones** to
`eval/rag/questions.json` and `questions.md`. Write them after reading the corpus, and
phrase them the way a user would:

| type | count | what it tests |
| --- | --- | --- |
| `near_miss` | 2 | many chunks match the topic, but only one holds the specific answer |
| `off_topic` | 1 | unrelated to the corpus entirely; should be declined |
| `paraphrased` | 1 | none of the document's key terms appear in the question |
| `messy` | 1 | long, chatty, with filler around a simple corpus question |
| `multi_part` | 1 | needs facts from two different documents |

Same fields as Day 22. Add one extra field, `expect_decline: true`, set on the Day 22
`unanswerable` question and on the `off_topic` one. For `near_miss`, use Day 22's
retrieval tooling to check that baseline vector search does *not* already put the right
chunk at rank 1. If it does, pick a harder question. Update the validation test (16
questions, type counts).

### Modes

`npm run eval:rag [-- q03] [-- --modes rag,rag+rerank]` runs every question in these 4
modes by default:

1. `plain`: no documents
2. `rag`: Day 22 baseline
3. `rag+rerank`: rerank and cutoff
4. `rag+rewrite+rerank`: everything

### Metrics

Add these on top of the Day 22 metrics (judge fact score, hallucination, citations):

- **Retrieval** (RAG modes): whether the expected source is in the final chunks, and
  its rank before and after the rerank.
- **Noise**: final chunks that come from no expected source, counted only for questions
  that have expected sources.
- **Declines**: correct (expected) vs wrong (a decline on an answerable question,
  i.e. the cutoff dropped the answer). List every wrong decline by name.
- **Cost**: input tokens and latency per stage.

### Report

Update `reports/rag_comparison.md` and the `/rag-report` page for 4 modes:

- A summary table with modes as columns.
- A per-question table with one score per mode, and the answer's rank before and after
  the rerank.
- For each question, the answers in every mode, the queries searched, and kept vs
  dropped candidates.
- Findings in `rag_notes.md`, written from the actual numbers: did reranking help,
  where did the cutoff help or hurt, and did rewriting earn its extra call. If a step
  made no difference or made things worse, say so plainly.

## Tests (offline, `npm test`)

Use fake implementations of the reranker and rewriter. Never load the real models in
tests.

- Rerank re-sorts candidates, applies the cutoff, and respects `K_FINAL`.
- When nothing passes the cutoff, the answer is declined and the LLM is not called.
- With rerank off, the output is identical to Day 22.
- Rewriting into several queries merges results without duplicate `chunk_id`s, and
  the LLM still receives the original question.
- The extended question file validates.

## Docs

Update `first-agent/README.md`: the pipeline, the new env vars, the new eval flag, and
the chosen threshold with a one-line reason. In the root README, add the Day 23 line.

## Done when

1. In the UI, a near-miss question shows the reranker moving a chunk up. An off-topic
   question is declined, and the Sources panel shows the rejected chunks.
2. `npm run eval:rag` runs all 16 questions × 4 modes and writes the report with real
   numbers and findings.
3. `npm test` passes offline in `first-agent` and `doc_index`.
4. `http://localhost:3000/rag-report` shows the 4-mode comparison.

Run all four yourself and fix what fails. Then leave the `first-agent` server running on
port 3000 (if the port is taken, say so instead of switching ports), and check that `/`
and `/rag-report` respond. In the final message, include the summary table, every wrong
decline, the chosen threshold, and the two URLs.
