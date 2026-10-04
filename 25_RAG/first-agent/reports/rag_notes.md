*Hand-written from the run of 2026-10-04 (Haiku 4.5 for answers, rewrites and the judge; structural chunks; k_final 5, k_retrieve 20; bge-reranker-v2-m3 int8; cutoff 0.02). If the tables above have moved since then, trust the tables.*

**Sample size first.** There are 16 questions, each run once per mode at temperature 0. One question moves a mean fact score by about 0.07, so treat differences of one question as noise unless the transcript shows why.

### Choosing the cutoff (before the eval, on other questions)

The threshold was set once, from doc_index's 20 retrieval questions (`doc_index/eval/questions.json`), not the 16 below. For each question I took the top 20 structural chunks by vector score (all collections) and scored every (question, chunk) pair with the reranker. "Relevant" means the chunk holds the question's `expected_text`, which gives exactly 1 relevant chunk per question: 20 relevant and 380 others.

| rerank score | min | p10 | p25 | median | p75 | p90 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| relevant (n = 20) | 0.010 | 0.052 | 0.459 | 0.924 | 0.990 | 0.999 | 1.000 |
| other (n = 380) | 0.000 | 0.000 | 0.000 | 0.003 | 0.059 | 0.561 | 0.993 |

| cutoff | relevant kept | others kept |
| ---: | ---: | ---: |
| 0.01 | 20/20 | 162 (43%) |
| **0.02** | **19/20** | **139 (37%)** |
| 0.05 | 19/20 | 103 (27%) |
| 0.1 | 16/20 | 82 (22%) |
| 0.5 | 15/20 | 43 (11%) |

**I chose 0.02.** It keeps 19 of 20 relevant chunks. The one it loses (0.010, a README chunk) was 10th by vector score, so the Day 22 top 5 would not have had it either. 0.02 drops 63% of the irrelevant candidates, and it sits 2.6× below the next-weakest relevant chunk (0.052). Anything at 0.05 or above would be too close to that one. Relevant chunks have a long low tail (p10 = 0.052), so a "confident" cutoff like 0.5 would lose a quarter of them. Over the same 20 questions, reranking moved hit@5 from 16 to 19 and MRR from 0.764 to 0.783, with hit@1 unchanged at 14. It helped most on README and code questions, where the right chunk was 6th–16th by vector score.

Two practical findings from the calibration:
- **Score pairs one at a time.** With the int8 model, a padded batch of 4 shifted every logit by up to ~0.3, depending on which other chunks were in the batch. Quantization is per batch, so a chunk's score depended on its neighbours. Batch size 1 is deterministic, and on this CPU it was also the fastest.
- **Cost.** 20 candidates take about 7 s on CPU during calibration, and 3.1 s per question in the eval (shorter chunks). That is more than the whole answer call.

### Did reranking help? On this set, no. It made answers worse.

| | rag | rag+rerank | rag+rewrite+rerank |
| --- | ---: | ---: | ---: |
| mean fact score (14 answerable) | **0.93** | 0.79 | 0.80 |
| passed (of 16) | **15** | 11 | 11 |
| expected source in final chunks | 13/13 | 13/13 | 13/13 |
| mean latency | **2.6 s** | 5.7 s | 8.0 s |

The baseline was already at the ceiling. The expected source was in the top 5 for all 13 questions that have one, ranked 1st in 11 of them. Reranking can only re-order and trim, so it had no room to help and some room to hurt. Here is where it did each:

- **Helped the ranking, not the score: q11 (near miss).** The talk on implementing Hot Reload was 4th by vector score, behind three release-post sections about Hot Reload. The reranker put it 1st (0.964). But 4th is still inside k = 5, so the baseline answer was already 1.00. This is the case reranking is for, and it worked. On this corpus it just didn't change the outcome.
- **Hurt badly: q14 (paraphrased), 1.00 → 0.00.** The question avoids every key term ("grab an element with the mouse … let go of it over another element"). The *embedding* model still ranked the drag-and-drop section 2nd. The cross-encoder gave it **0.0004**, while the same chunk scores 0.9998 for "Does Compose Multiplatform support drag and drop on desktop?". So this reranker matches terms far more than meaning. Only two weak chunks passed the cutoff, and the model correctly said they don't cover it. This is a **wrong decline caused by reranking**. The model declined, not the cutoff, but the cutoff had dropped the answer. No threshold would have saved it: at 0.0004 the chunk ranked 12th of 20 even with no cutoff, so it would also have missed the top 5.
- **Hurt: q08 (general, two-part), 1.00 → 0.50.** "What is KMP, and what is worth sharing?" The reranker filled all 5 slots with "what is KMP" chunks (0.70–0.96) and scored the "Share this / Keep platform-specific" lists at 0.0006 and 0.002. It ranks how well a passage answers the question *as a whole*, so a passage that answers only the second half loses.
- **Not the reranker's fault: q02 (0.67) and q06 (0.88 ⚠).** In q02, the 96% survey chunk was kept (rerank 0.999), but the answer left that statistic out, which is ordinary generation variance. In q06, the "hallucination" is the article's own "30% for text-heavy operations" claim. The judge can't see the article (the same false positive as on Day 22), and the reranked chunk set happened to include that sentence.
- **Noise did not go down.** Reranking sent fewer chunks (4.1 vs 5.0 on average), but just as many from the wrong document (2.0 vs 1.8). The cutoff at 0.02 is low by design, so it rarely trims a list of real candidates. Neither near-miss question needed trimming.

### Where the cutoff helped and where it hurt

- **Helped: q13 (off-topic).** Every candidate for the sourdough question scored ≤ 0.001, so the answer was declined **without calling the model**: 0 answer tokens instead of 1,693. Baseline RAG declined too, because the model followed its "documents only" rule, so the gain is cost, not correctness. The rejected chunks shown in the UI (scheduler and memory source code) make it obvious why.
- **No effect: q10 (Compose Multiplatform 1.9.0, unanswerable).** Neighbouring release posts scored up to 0.73, far above any cutoff, and the model declined on its own as it did on Day 22. A relevance cutoff can't detect "right topic, wrong version". That still depends on the prompt.
- **Hurt: q14, through the scores rather than the cutoff value** (see above).
- **No cutoff declines on an answerable question.** All three wrong RAG declines (q09 in every RAG mode, q14 in both rerank modes) came from the model. q09 is Day 22's known cost: coroutines are not in the corpus, and the "documents only" rule makes RAG decline what plain mode answers.

### Did rewriting earn its extra call? No.

rag+rewrite+rerank vs rag+rerank: 0.80 vs 0.79 mean score and 11 vs 11 passed, for **+950 input tokens and +2.3 s per question** (0.9 s for the rewrite call, plus 1.5 s more reranking because 2–3 queries bring 23–34 candidates instead of 20).

- The rewrites themselves were good. The messy UUID question (q15) became one clean query, the multi-part navigation question (q16) became one query per release, and q14 became "Compose Multiplatform drag and drop …", which found the right section **1st** by vector score (0.724).
- None of it changed an answer, because the baseline already handled these cases. q15 and q16 scored 1.00 in plain `rag`: EmbeddingGemma handles filler and two-part questions well enough here.
- And by design, the reranker ignores the rewrites and scores against the original question. So on q14 the good query found the chunk and the reranker threw it away again (0.000).
- It sometimes moved the expected document in the vector order: q04 went from 1st to 4th (rerank put it back to 1st), and q12 went from 2nd to 1st (rerank then put the 1.8.0 web section above it again). Neither changed the score.

### What I'd change

1. **Keep `rag` (both stages off) as the default.** On this corpus it is better, faster (2.6 s vs 5.7–8.0 s) and cheaper. Rerank is still useful as a switch for corpora where the answer sits past rank 5. The doc_index calibration shows that for code and READMEs (hit@5 16 → 19).
2. If reranking stays, **don't let a cross-encoder have the last word on recall**. For example, always keep the top 1–2 vector hits, or rerank against the rewritten queries as well as the original. q14's chunk scores 0.98 against "drag and drop". The spec's choice to rerank against the original question is what made rewrite and rerank cancel each other out here.
3. **Fix q09 in the prompt, not the retriever** (Day 22's open item). Let RAG answer from general knowledge with a clear "not from the documents" label.
4. **More hard questions.** Every Day 23 question except q14 was already solved by the baseline. Two near-misses at vector rank 2 and 4 are within k = 5. A near-miss test that baseline actually fails needs the answer past rank 5, which on this corpus mostly happens for code and READMEs.

### Plain vs RAG (the Day 22 regression set, unchanged)

On q01–q10, `rag` reproduces Day 22: 9/10 passed, 0 hallucinations, q09 declined. Plain mode had 8 hallucinations across the 16 questions. Without documents, the model confidently invents version numbers, sizes and flags (q02, q04, q06, q07, q12, q14, q15, q16). With them it invented nothing (`rag`), with one judge false positive in each rerank mode (q06).
