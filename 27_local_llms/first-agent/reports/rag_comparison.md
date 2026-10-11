# RAG eval: 16 questions × 4 modes

Generated 2026-10-04T16:14:05.911Z by `npm run eval:rag`. Answer model `claude-haiku-4-5-20251001` (every mode, temperature 0, max 1024 tokens);
judge `claude-haiku-4-5-20251001` (forced `submit_grade`, temperature 0, blind to the mode, `[n]` markers stripped).
Retrieval: doc_index `search()`, strategy `structural`, collections all, minScore off; k_final = 5 chunks to the model, k_retrieve = 20 candidates per query when reranking.
Rerank: `onnx-community/bge-reranker-v2-m3-ONNX`, cutoff 0.02 on the sigmoid score. Rewrite: one forced `submit_queries` call with the answer model.
Raw results: [`rag_results.json`](rag_results.json). Questions: [`../eval/rag/questions.md`](../eval/rag/questions.md).

## Summary

| | plain | rag | rag+rerank | rag+rewrite+rerank |
| --- | ---: | ---: | ---: | ---: |
| mean fact score (14 answerable) | 0.19 | 0.93 | 0.79 | 0.80 |
| passed (of 16) | 2 | 15 | 11 | 11 |
| answers with a hallucination | 8 | 0 | 1 | 1 |
| correct declines (expected) | 1/2 | 2/2 | 2/2 | 2/2 |
| wrong declines (answerable question declined) | 4: q01 (model), q03 (model), q05 (model), q11 (model) | 1: q09 (model) | 2: q09 (model), q14 (model) | 2: q09 (model), q14 (model) |
| expected source in the final chunks |  | 13/13 | 13/13 | 13/13 |
| mean rank of expected source: before rerank → final |  | 1.3 | 1.3 → 1.2 | 1.5 → 1.2 |
| noise: final chunks from no expected source (mean) |  | 1.8 of 5.0 | 2.0 of 4.1 | 1.9 of 4.1 |
| citations all valid |  | 16/16 | 16/16 | 16/16 |
| mean input tokens: rewrite + answer | 77 | 1452 | 1346 | 950 + 1356 |
| mean output tokens | 329 | 184 | 180 | 239 |
| mean latency (total) | 3.9 s | 2.6 s | 5.7 s | 8.0 s |
| … rewrite / retrieve / rerank / answer | 0 / 0 / 0 / 3.89 s | 0 / 0.14 / 0 / 2.49 s | 0 / 0.09 / 3.08 / 2.50 s | 0.94 / 0.13 / 4.53 / 2.44 s |

## Per question

Score per mode (⚠ hallucination, ✗ declined). Rank: first expected source before the rerank → in the final chunks.

| id | type | question | plain | rag | rag+rerank | rag+rewrite+rerank | rank rag | rank rag+rerank | rank rag+rewrite+rerank |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [q01](#q01) | corpus | After moving to Compose Multiplatform 1.7 with Kotlin 2.0.20, how much faster did iOS rendering get in JetBrains' benchmarks, and did GC pauses improve too? | 0.00 ✗ | 1.00 | 1.00 | 1.00 | 1 | 1 | 1 |
| [q02](#q02) | corpus | Is Compose Multiplatform for iOS production-ready yet, and how much does it add to app size compared with a pure SwiftUI app? | 0.00 ⚠ | 1.00 | 0.67 | 0.67 | 1 | 1 | 1 |
| [q03](#q03) | corpus | I know Kotlin and want to enter this year's RevenueCat Shipaton in the JetBrains category. What can I win, and when does it run? | 0.00 ✗ | 1.00 | 1.00 | 1.00 | 1 | 1 | 1 |
| [q04](#q04) | corpus | Can an AI coding agent work with my running Compose app through hot reload? What exactly can it do there? | 0.13 ⚠ | 1.00 | 1.00 | 1.00 | 1 | 1 | 4 → 1 |
| [q05](#q05) | corpus | Which well-known companies have given KotlinConf talks about running KMP in production, and how much code did the fintech one end up sharing? | 0.00 ✗ | 1.00 | 1.00 | 1.00 | 1 | 1 | 1 |
| [q06](#q06) | corpus | Which compiler flags turn on context parameters and context-sensitive resolution in Kotlin 2.2.0, and is there a Kotlin/Native switch that reduces string memory? | 0.00 ⚠ | 1.00 | 0.88 ⚠ | 0.88 ⚠ | 1 | 1 | 1 |
| [q07](#q07) | corpus | How is Compose for Web supposed to run on older browsers that lack newer WebAssembly features? | 0.13 ⚠ | 1.00 | 1.00 | 1.00 | 1 | 1 | 1 |
| [q08](#q08) | general | What is Kotlin Multiplatform, and which parts of an app is it usually worth sharing across platforms? | 1.00 | 1.00 | 0.50 | 0.63 | 1 | 1 → 3 | 2 → 3 |
| [q09](#q09) | general | How are Kotlin coroutines different from threads, and what does the suspend keyword actually do? | 0.67 | 0.00 ✗ | 0.00 ✗ | 0.00 ✗ | — | — | — |
| [q10](#q10) | unanswerable | What were the headline features of Compose Multiplatform 1.9.0? | 1.00 ✗ | 1.00 ✗ | 1.00 ✗ | 1.00 ✗ | — | — | — |
| [q11](#q11) | near_miss | Is there a talk on how Compose Hot Reload is implemented? What did they have to work around? | 0.00 ✗ | 1.00 | 1.00 | 1.00 | 4 | 4 → 1 | 3 → 1 |
| [q12](#q12) | near_miss | Can I ship a Compose Multiplatform web app to production yet, or is the web target still experimental? | 0.17 ⚠ | 1.00 | 1.00 | 1.00 | 2 | 2 | 1 → 2 |
| [q13](#q13) | off_topic | How long should I proof sourdough bread in the fridge overnight, and at what temperature? | 0.00 | 1.00 ✗ | 1.00 ✗ | 1.00 ✗ | — | — | — |
| [q14](#q14) | paraphrased | In JetBrains' cross-platform UI toolkit, can people using my app on a Windows or Mac computer grab an element with the mouse, carry it across and let go of it over another element? Which version brought that, and what do I attach to the two elements? | 0.00 ⚠ | 1.00 | 0.00 ✗ | 0.00 ✗ | 1 | 1 | 1 |
| [q15](#q15) | messy | hi! ok so long story — we're rewriting our notes app and my coworker insists we keep our hand-rolled ID generator in the shared module because "kotlin doesn't have UUIDs in common code", which sounds wrong to me?? we're on kotlin 2.4 btw, just upgraded last sprint. anyway: is there a stable UUID type in common code now or do we still need a library, and can we generate v4/v7 ones without opting into anything? thanks, sorry for the wall of text lol | 0.50 ⚠ | 1.00 | 1.00 | 1.00 | 1 | 1 | 1 |
| [q16](#q16) | multi_part | Which Compose Multiplatform release added type-safe navigation, and which one brought Navigation 3? What does each give me? | 0.13 ⚠ | 1.00 | 1.00 | 1.00 | 1 | 1 | 1 |

## Findings

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

## q01

**corpus** — After moving to Compose Multiplatform 1.7 with Kotlin 2.0.20, how much faster did iOS rendering get in JetBrains' benchmarks, and did GC pauses improve too?

*Why:* Four exact benchmark numbers from one post. A model without the post may know iOS got faster but will guess or omit the figures; a wrong number is a hallucination.

Expected sources: `Compose Multiplatform 1.7.0 Released - The JetBrains Blog`

### plain — score 0.00, declined

92 in · 230 out · 2.7 s · fail

> I don't have specific benchmark data about iOS rendering performance improvements in Compose Multiplatform 1.7 with Kotlin 2.0.20.
> 
> While JetBrains has released both Compose Multiplatform 1.7 and Kotlin 2.0.20, I don't have access to detailed performance benchmarks comparing rendering speed or garbage collection pause improvements between versions.
> 
> To find this information, I'd recommend:
> 
> 1. **Check the official release notes** for Compose Multiplatform 1.7 and Kotlin 2.0.20 on JetBrains' website
> 2. **Look at the Kotlin blog** - they often publish performance improvements in release announcements
> 3. **Check the JetBrains Compose GitHub repository** - performance-related discussions or PRs may contain benchmark data
> 4. **Search for conference talks or technical articles** from JetBrains engineers discussing these releases
> 
> If you've seen specific benchmark numbers somewhere, I'd be happy to help you interpret them!

| expected fact | grade | note |
| --- | --- | --- |
| The VisualEffects benchmark runs 3.6 times faster | missing |  |
| Average CPU time per 1000 frames dropped from 8.8 s to 2.4 s | missing |  |
| LazyGrid scrolling is about 9% faster on average | missing |  |
| With concurrent GC marking, the worst p25 GC pause fell from 1.7 ms to 0.4 ms | missing |  |

### rag — score 1.00

1779 in · 303 out · 4.7 s · rank 1 · cited [1] · pass

> # iOS Performance Improvements with Compose Multiplatform 1.7.0 and Kotlin 2.0.20
> 
> ## Rendering Performance
> 
> According to JetBrains' benchmarks comparing Compose Multiplatform 1.6.11 with Kotlin 2.0.0 to version 1.7.0 with Kotlin 2.0.20, iOS rendering improvements varied by benchmark: [1]
> 
> - **LazyGrid benchmark** (scrolling): ~9% faster on average with significantly reduced missed frames [1]
> - **VisualEffects benchmark** (rendering many components): **3.6 times faster** – CPU time per 1000 frames dropped from 8.8 to 2.4 seconds [1]
> - **AnimatedVisibility benchmark** (image animations): ~6% faster rendering [1]
> 
> ## Garbage Collection Improvements
> 
> Yes, GC pauses improved significantly. Kotlin 2.0.20 introduced experimental support for concurrent marking in the garbage collector. [1] With this feature enabled:
> 
> - **Missed frames were cut in half** compared to previous results [1]
> - **GC pause times improved dramatically** – the worst p25 GC pause time for the LazyGrid benchmark dropped from 1.7 ms to 0.4 ms [1]

| expected fact | grade | note |
| --- | --- | --- |
| The VisualEffects benchmark runs 3.6 times faster | present | Explicitly stated: 'VisualEffects benchmark (rendering many components): 3.6 times faster' |
| Average CPU time per 1000 frames dropped from 8.8 s to 2.4 s | present | Explicitly stated: 'CPU time per 1000 frames dropped from 8.8 to 2.4 seconds' |
| LazyGrid scrolling is about 9% faster on average | present | Explicitly stated: 'LazyGrid benchmark (scrolling): ~9% faster on average' |
| With concurrent GC marking, the worst p25 GC pause fell from 1.7 ms to 0.4 ms | present | Explicitly stated: 'the worst p25 GC pause time for the LazyGrid benchmark dropped from 1.7 ms to 0.4 ms' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.807 | — | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Performance improvements on iOS | Performance improvements on iOS In Kotlin 2.0.20, the Kotlin/Native team contributed significantly to making Compose apps on iOS perform faster and smoother. T… |
| 2 ✓ | 0.630 | — | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.7.0 Released Compose Multiplatform is a declarative UI framework built by JetBrains that allows developers to … |
| 3 | 0.625 | — | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious | 2. Compose Multiplatform Gets Serious Multiplatform Jetpack Compose was also promising but also buggy. Compose for iOS is stabilized in Kotlin 2.3 with improve… |
| 4 | 0.587 | — | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Performance that’s ready for production | Performance that’s ready for production A great user experience comes down to more than just UI behavior; it’s about performance, too. Smooth, responsive inter… |
| 5 | 0.565 | — | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Main Features | Main Features Kotlin 2.0.20 boasts concurrent marking for the garbage collector, which allows the marking phase to run simultaneously with application threads.… |

### rag+rerank — score 1.00

1856 in · 311 out · 8.2 s · rank 1 · cited [1][2] · pass

> # iOS Performance Improvements in Compose Multiplatform 1.7.0
> 
> Based on JetBrains' benchmarks comparing Compose Multiplatform 1.6.11 with Kotlin 2.0.0 to version 1.7.0 with Kotlin 2.0.20, here are the rendering improvements: [1]
> 
> **Rendering Performance:**
> - **LazyGrid benchmark** (scrolling): ~9% faster on average, with significantly reduced missed frames [1]
> - **VisualEffects benchmark** (rendering many components): 3.6 times faster – CPU time per 1000 frames dropped from 8.8 to 2.4 seconds [1]
> - **AnimatedVisibility benchmark** (image animations): ~6% faster rendering [1]
> 
> **Garbage Collection Improvements:**
> Yes, GC pauses improved significantly. Kotlin 2.0.20 introduced experimental support for concurrent marking in the garbage collector. [1][2] The results showed: [1]
> 
> - Only half as many missed frames as before
> - Worst p25 GC pause time for LazyGrid dropped from 1.7 ms to 0.4 ms
> 
> The concurrent marking feature allows the marking phase to run simultaneously with application threads, which significantly shortens GC pause times and improves overall application responsiveness. [2]

| expected fact | grade | note |
| --- | --- | --- |
| The VisualEffects benchmark runs 3.6 times faster | present | Explicitly stated: '3.6 times faster' |
| Average CPU time per 1000 frames dropped from 8.8 s to 2.4 s | present | Explicitly stated: 'CPU time per 1000 frames dropped from 8.8 to 2.4 seconds' |
| LazyGrid scrolling is about 9% faster on average | present | Explicitly stated: '~9% faster on average' |
| With concurrent GC marking, the worst p25 GC pause fell from 1.7 ms to 0.4 ms | present | Explicitly stated: 'Worst p25 GC pause time for LazyGrid dropped from 1.7 ms to 0.4 ms' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.807 | 0.999 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Performance improvements on iOS | Performance improvements on iOS In Kotlin 2.0.20, the Kotlin/Native team contributed significantly to making Compose apps on iOS perform faster and smoother. T… |
| 2 | 0.565 | 0.931 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Main Features | Main Features Kotlin 2.0.20 boasts concurrent marking for the garbage collector, which allows the marking phase to run simultaneously with application threads.… |
| 3 ✓ | 0.630 | 0.756 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.7.0 Released Compose Multiplatform is a declarative UI framework built by JetBrains that allows developers to … |
| 4 | 0.625 | 0.266 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious | 2. Compose Multiplatform Gets Serious Multiplatform Jetpack Compose was also promising but also buggy. Compose for iOS is stabilized in Kotlin 2.3 with improve… |
| 5 | 0.537 | 0.232 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Everything you need to build apps for real-world use | Everything you need to build apps for real-world use Compose Multiplatform for iOS now includes everything you need to build beautiful UIs for real-world apps:… |

<details><summary>Dropped candidates (15)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 4 | 0.587 | 0.176 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Performance that’s ready for production |
| 15 | 0.533 | 0.076 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native |
| 6 | 0.549 | 0.046 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways |
| 11 | 0.538 | 0.027 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Enhanced Performance and Bug Fixes |
| 12 | 0.537 | 0.027 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🔮 What This Means for Your Daily Development |
| 10 | 0.538 | 0.020 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile |
| 16 | 0.526 | 0.020 | Kotlin 2.0.0_ A New Era in Kotlin Development _ by Halil Özel _ Medium | 2. Improved Performance and Efficiency 🔊 |
| 8 | 0.546 | 0.018 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  |
| 17 | 0.523 | 0.012 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Swift Export Gets Real Upgrades |
| 9 | 0.542 | 0.010 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency |
| 18 | 0.517 | 0.010 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 1. Sensible Native Interop That Plays Nice With You |
| 7 ✓ | 0.547 | 0.009 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Improved touch interop between Compose Multiplatform and native iOS |
| 14 ✓ | 0.536 | 0.003 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | What else to read |
| 19 | 0.510 | 0.002 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Multiplatform Development Enhancements |
| 20 ✓ | 0.509 | 0.001 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Shared element transitions |

</details>

### rag+rewrite+rerank — score 1.00

2821 in · 397 out · 9.4 s · rank 1 · cited [1][2] · pass

Queries searched: `Compose Multiplatform 1.7 iOS rendering performance benchmarks` · `Compose Multiplatform 1.7 Kotlin 2.0.20 GC garbage collection pauses` · `Compose Multiplatform 1.7 performance improvements iOS`

> # iOS Performance Improvements in Compose Multiplatform 1.7.0
> 
> Based on JetBrains' benchmarks comparing Compose Multiplatform 1.6.11 with Kotlin 2.0.0 to version 1.7.0 with Kotlin 2.0.20, here are the rendering improvements: [1]
> 
> **Rendering Performance:**
> - **LazyGrid benchmark** (scrolling): ~9% faster on average, with significantly reduced missed frames
> - **VisualEffects benchmark** (rendering many components): 3.6 times faster – CPU time per 1000 frames dropped from 8.8 to 2.4 seconds
> - **AnimatedVisibility benchmark** (image animations): ~6% faster rendering
> 
> **Garbage Collection Improvements:**
> 
> Yes, GC pauses improved significantly. Kotlin 2.0.20 introduced experimental support for concurrent marking in the garbage collector. [1][2] With this feature enabled:
> - Only half as many missed frames as before
> - Worst p25 GC pause time for LazyGrid dropped from 1.7 ms to 0.4 ms [1]
> 
> The concurrent marking feature allows the marking phase to run simultaneously with application threads, which significantly shortens GC pause times and improves overall application responsiveness. [2]

| expected fact | grade | note |
| --- | --- | --- |
| The VisualEffects benchmark runs 3.6 times faster | present | Explicitly stated: '3.6 times faster' |
| Average CPU time per 1000 frames dropped from 8.8 s to 2.4 s | present | Explicitly stated: 'CPU time per 1000 frames dropped from 8.8 to 2.4 seconds' |
| LazyGrid scrolling is about 9% faster on average | present | Explicitly stated: '~9% faster on average' |
| With concurrent GC marking, the worst p25 GC pause fell from 1.7 ms to 0.4 ms | present | Explicitly stated: 'Worst p25 GC pause time for LazyGrid dropped from 1.7 ms to 0.4 ms' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.769 | 0.999 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Performance improvements on iOS | Performance improvements on iOS In Kotlin 2.0.20, the Kotlin/Native team contributed significantly to making Compose apps on iOS perform faster and smoother. T… |
| 2 | 0.670 | 0.931 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Main Features | Main Features Kotlin 2.0.20 boasts concurrent marking for the garbage collector, which allows the marking phase to run simultaneously with application threads.… |
| 3 ✓ | 0.710 | 0.756 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.7.0 Released Compose Multiplatform is a declarative UI framework built by JetBrains that allows developers to … |
| 4 | 0.627 | 0.266 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious | 2. Compose Multiplatform Gets Serious Multiplatform Jetpack Compose was also promising but also buggy. Compose for iOS is stabilized in Kotlin 2.3 with improve… |
| 5 | 0.584 | 0.232 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Everything you need to build apps for real-world use | Everything you need to build apps for real-world use Compose Multiplatform for iOS now includes everything you need to build beautiful UIs for real-world apps:… |

<details><summary>Dropped candidates (25)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 11 | 0.618 | 0.184 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt |
| 4 | 0.688 | 0.176 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Performance that’s ready for production |
| 8 | 0.624 | 0.076 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native |
| 21 | 0.533 | 0.046 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways |
| 6 | 0.636 | 0.027 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Enhanced Performance and Bug Fixes |
| 19 | 0.560 | 0.020 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile |
| 26 | 0.499 | 0.020 | Kotlin 2.0.0_ A New Era in Kotlin Development _ by Halil Özel _ Medium | 2. Improved Performance and Efficiency 🔊 |
| 14 | 0.601 | 0.018 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  |
| 10 | 0.621 | 0.010 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency |
| 3 ✓ | 0.709 | 0.009 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Improved touch interop between Compose Multiplatform and native iOS |
| 22 | 0.520 | 0.003 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements › Per-Object Memory Allocation |
| 18 ✓ | 0.573 | 0.003 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | What else to read |
| 20 | 0.546 | 0.002 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Multiplatform Development Enhancements |
| 29 | 0.488 | 0.002 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Support for New Gradle Versions |
| 9 ✓ | 0.622 | 0.002 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Resources updates and improvements |
| 28 | 0.492 | 0.001 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 1. Smarter overload resolution with suspend function |
| 23 | 0.506 | 0.001 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium |  |
| 30 | 0.409 | 0.001 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | Automatic font fallback for web |
| 13 ✓ | 0.604 | 0.001 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Shared element transitions |
| 12 ✓ | 0.605 | 0.001 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | New common modules |
| 27 | 0.493 | 0.001 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › General and quality improvements |
| 15 ✓ | 0.600 | 0.001 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Type-safe navigation |
| 25 | 0.500 | 0.001 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Read more |
| 24 | 0.503 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/Native › Reducing Kotlin/Native build times |
| 16 ✓ | 0.597 | 0.000 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Drag and drop on desktop |

</details>

## q02

**corpus** — Is Compose Multiplatform for iOS production-ready yet, and how much does it add to app size compared with a pure SwiftUI app?

*Why:* The stable version may be known to a strong model; the ~9 MB size cost and the 96% survey figure are specific to the post. A different size figure is a hallucination.

Expected sources: `Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog`

### plain — score 0.00, hallucination

74 in · 376 out · 5.0 s · fail

> # Compose Multiplatform for iOS: Production Readiness
> 
> ## Status
> **Not officially production-ready** as of my last update (April 2024). JetBrains still marks it as in active development, though it's increasingly stable. Some companies use it in production, but it's not officially recommended for critical apps yet.
> 
> ## App Size Impact
> 
> This is a significant consideration:
> 
> - **SwiftUI app baseline**: ~5-10 MB (minimal)
> - **Compose Multiplatform iOS app**: typically **+30-50 MB** additional overhead
> 
> The overhead comes from:
> - Kotlin runtime and standard library
> - Compose runtime
> - Skiko (rendering engine)
> - Additional dependencies
> 
> So a simple app might be 40-60 MB instead of 10 MB.
> 
> ## Practical Considerations
> 
> **Pros:**
> - Code sharing across iOS/Android/Desktop
> - Familiar API for Android developers
> - Improving performance with each release
> 
> **Cons:**
> - Larger app size (significant for users on limited storage)
> - Less native feel than SwiftUI
> - Smaller ecosystem and fewer third-party libraries
> - Debugging can be more complex
> 
> ## Recommendation
> 
> - **Use SwiftUI** if building iOS-only apps
> - **Consider Compose Multiplatform** if you need significant code sharing across platforms and can accept the size/performance tradeoffs
> - **Wait** if production stability is critical for your use case
> 
> Check the [official Compose Multiplatform roadmap](https://www.jetbrains.com/help/kotlin-multiplatform-dev/compose-multiplatform-roadmap.html) for the latest status.

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform 1.8.0 made Compose for iOS Stable | missing | Answer states it's not officially production-ready as of April 2024, contradicting the expected fact about 1.8.0 making it Stable. |
| It adds only about 9 MB to an iOS app compared with a native SwiftUI app | contradicted | Answer claims +30-50 MB overhead, which directly contradicts the expected 9 MB figure. |
| Over 96% of teams using it on iOS report no major performance concerns | missing | No mention of this statistic or any team survey data about performance concerns. |

Hallucination: The answer claims Compose Multiplatform for iOS is "not officially production-ready" and provides specific overhead figures of "+30-50 MB" which contradict the expected facts about 1.8.0 making it Stable and only adding 9 MB. These are specific claims that conflict with the expected facts.

### rag — score 1.00

1670 in · 149 out · 2.4 s · rank 1 · cited [4][2][1] · pass

> Yes, Compose Multiplatform for iOS is production-ready. [4] The release of Compose Multiplatform 1.8.0 brings Compose for iOS to Stable, making it "a complete solution for mobile development." [2]
> 
> Regarding app size, Compose Multiplatform adds only **~9 MB to the size of an iOS app** compared to a fully native SwiftUI app with the same UI logic and assets. [1]
> 
> This production-readiness is backed by real-world usage: according to a survey, over 96% of teams using Compose Multiplatform on iOS report no major performance concerns. [1]

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform 1.8.0 made Compose for iOS Stable | present | Answer states 'Compose Multiplatform 1.8.0 brings Compose for iOS to Stable' |
| It adds only about 9 MB to an iOS app compared with a native SwiftUI app | present | Answer states '~9 MB to the size of an iOS app compared to a fully native SwiftUI app' |
| Over 96% of teams using it on iOS report no major performance concerns | present | Answer states 'over 96% of teams using Compose Multiplatform on iOS report no major performance concerns' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.710 | — | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Performance that’s ready for production | Performance that’s ready for production A great user experience comes down to more than just UI behavior; it’s about performance, too. Smooth, responsive inter… |
| 2 ✓ | 0.633 | — | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt | Production-ready and easy to adopt Compose Multiplatform for iOS now gives you the full package: stable APIs, great performance, a native feel, and modern tool… |
| 3 ✓ | 0.620 | — | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native | Apps that feel truly native Smooth, native behavior is what iOS users expect – and notice. Compose Multiplatform for iOS focuses on getting the details right, … |
| 4 ✓ | 0.577 | — | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  | Multiplatform Compose Multiplatform 1.8.0 Released: Compose Multiplatform for iOS Is Stable and Production-Ready Today marks a major milestone in the Kotlin M… |
| 5 | 0.565 | — | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious | 2. Compose Multiplatform Gets Serious Multiplatform Jetpack Compose was also promising but also buggy. Compose for iOS is stabilized in Kotlin 2.3 with improve… |

### rag+rerank — score 0.67

1749 in · 106 out · 4.9 s · rank 1 · cited [2][3][1] · generation miss

> Yes, Compose Multiplatform for iOS is production-ready. [2] The release of Compose Multiplatform 1.8.0 brings Compose for iOS to Stable status, making it a complete solution for mobile development. [3]
> 
> Regarding app size, Compose Multiplatform adds only **~9 MB** to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets. [1]

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform 1.8.0 made Compose for iOS Stable | present | The answer explicitly states 'Compose Multiplatform 1.8.0 brings Compose for iOS to Stable status' |
| It adds only about 9 MB to an iOS app compared with a native SwiftUI app | present | The answer states '~9 MB' which matches the expected fact |
| Over 96% of teams using it on iOS report no major performance concerns | missing | This statistic is not mentioned in the answer at all |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.710 | 0.999 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Performance that’s ready for production | Performance that’s ready for production A great user experience comes down to more than just UI behavior; it’s about performance, too. Smooth, responsive inter… |
| 2 ✓ | 0.577 | 0.970 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  | Multiplatform Compose Multiplatform 1.8.0 Released: Compose Multiplatform for iOS Is Stable and Production-Ready Today marks a major milestone in the Kotlin M… |
| 3 ✓ | 0.633 | 0.962 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt | Production-ready and easy to adopt Compose Multiplatform for iOS now gives you the full package: stable APIs, great performance, a native feel, and modern tool… |
| 4 ✓ | 0.552 | 0.827 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Everything you need to build apps for real-world use | Everything you need to build apps for real-world use Compose Multiplatform for iOS now includes everything you need to build beautiful UIs for real-world apps:… |
| 5 ✓ | 0.620 | 0.783 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native | Apps that feel truly native Smooth, native behavior is what iOS users expect – and notice. Compose Multiplatform for iOS focuses on getting the details right, … |

<details><summary>Dropped candidates (15)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 10 | 0.533 | 0.751 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  |
| 12 | 0.505 | 0.731 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways |
| 13 | 0.480 | 0.541 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Key priorities |
| 9 | 0.540 | 0.523 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Performance improvements on iOS |
| 11 ✓ | 0.516 | 0.502 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile |
| 5 | 0.565 | 0.481 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious |
| 8 | 0.549 | 0.189 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Improved touch interop between Compose Multiplatform and native iOS |
| 18 | 0.448 | 0.125 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ? Part 3: The iOS Perspective |
| 6 ✓ | 0.560 | 0.016 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency |
| 14 ✓ | 0.475 | 0.010 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Read more |
| 19 | 0.447 | 0.009 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Swift Export Gets Real Upgrades |
| 16 | 0.453 | 0.002 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 1. Sensible Native Interop That Plays Nice With You |
| 15 | 0.455 | 0.001 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › Improve the Swift development experience with the Kotlin Multiplatform IDE plugin |
| 20 | 0.446 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/Native › Continued development of Swift Export |
| 17 | 0.449 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Build tooling › Reducing the effort to publish KMP libraries |

</details>

### rag+rewrite+rerank — score 0.67

2696 in · 161 out · 6.0 s · rank 1 · cited [2][3][1] · generation miss

Queries searched: `Compose Multiplatform iOS production ready` · `Compose Multiplatform iOS app size overhead`

> Yes, Compose Multiplatform for iOS is production-ready. [2] The release of Compose Multiplatform 1.8.0 brings Compose for iOS to Stable status, making it a complete solution for mobile development. [3]
> 
> Regarding app size, Compose Multiplatform adds only **~9 MB** to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets. [1]

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform 1.8.0 made Compose for iOS Stable | present | The answer states 'Compose Multiplatform 1.8.0 brings Compose for iOS to Stable status' |
| It adds only about 9 MB to an iOS app compared with a native SwiftUI app | present | The answer explicitly states '~9 MB' to the size of an iOS app compared to a fully native SwiftUI app |
| Over 96% of teams using it on iOS report no major performance concerns | missing | This statistic is not mentioned in the answer at all |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.699 | 0.999 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Performance that’s ready for production | Performance that’s ready for production A great user experience comes down to more than just UI behavior; it’s about performance, too. Smooth, responsive inter… |
| 2 ✓ | 0.711 | 0.970 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  | Multiplatform Compose Multiplatform 1.8.0 Released: Compose Multiplatform for iOS Is Stable and Production-Ready Today marks a major milestone in the Kotlin M… |
| 3 ✓ | 0.751 | 0.962 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt | Production-ready and easy to adopt Compose Multiplatform for iOS now gives you the full package: stable APIs, great performance, a native feel, and modern tool… |
| 4 ✓ | 0.668 | 0.827 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Everything you need to build apps for real-world use | Everything you need to build apps for real-world use Compose Multiplatform for iOS now includes everything you need to build beautiful UIs for real-world apps:… |
| 5 ✓ | 0.711 | 0.783 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native | Apps that feel truly native Smooth, native behavior is what iOS users expect – and notice. Compose Multiplatform for iOS focuses on getting the details right, … |

<details><summary>Dropped candidates (17)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 6 | 0.637 | 0.751 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  |
| 11 | 0.588 | 0.731 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways |
| 15 | 0.530 | 0.541 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Key priorities |
| 10 | 0.588 | 0.523 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Performance improvements on iOS |
| 12 ✓ | 0.574 | 0.502 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile |
| 7 | 0.632 | 0.481 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious |
| 9 | 0.625 | 0.189 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Improved touch interop between Compose Multiplatform and native iOS |
| 21 | 0.489 | 0.078 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | Window and dialog API v2 |
| 14 | 0.533 | 0.038 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  |
| 8 ✓ | 0.627 | 0.016 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency |
| 13 ✓ | 0.566 | 0.010 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Read more |
| 17 | 0.506 | 0.007 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Drag and drop on desktop |
| 16 | 0.507 | 0.004 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Resources updates and improvements |
| 20 | 0.498 | 0.003 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | New common modules |
| 18 | 0.504 | 0.003 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Type-safe navigation |
| 22 | 0.460 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Common @Preview annotation |
| 19 | 0.500 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Build tooling › Reducing the effort to publish KMP libraries |

</details>

## q03

**corpus** — I know Kotlin and want to enter this year's RevenueCat Shipaton in the JetBrains category. What can I win, and when does it run?

*Why:* A 2026 event, after most model training data: plain mode cannot know the amounts or dates. Day 21 found that structural chunking splits the intro and the prize section, so watch the retrieval rank.

Expected sources: `Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog`

### plain — score 0.00, declined

80 in · 213 out · 2.8 s · fail

> I don't have current information about RevenueCat's Shipaton competition for this year, including specific details about:
> 
> - The JetBrains category prizes
> - The exact dates it runs
> - Current eligibility requirements
> 
> To get accurate, up-to-date information, I'd recommend:
> 
> 1. **Visit RevenueCat's official website** - Check their blog or events page for Shipaton details
> 2. **Check JetBrains announcements** - They often promote hackathons and competitions
> 3. **Look for official social media** - RevenueCat's Twitter/X, LinkedIn, or Discord community
> 4. **Contact RevenueCat directly** - Their team can provide current details about prizes and timeline
> 
> Since hackathons and competitions update their details annually, checking official sources will give you the most reliable information about what's available this year.
> 
> Is there anything else about Kotlin development or RevenueCat's SDK that I can help you with?

| expected fact | grade | note |
| --- | --- | --- |
| The JetBrains (Ship Kotlin Everywhere) award has a $30,000 prize pool | missing | Answer declines to provide information about prizes |
| It is split among three winners: $15,000, $10,000 and $5,000 | missing | Answer declines to provide information about prize distribution |
| Shipaton 2026 runs from August 1 to September 30 | missing | Answer declines to provide information about dates |
| The first-place app gets a feature on a Times Square billboard | missing | Answer declines to provide information about additional prizes |

### rag — score 1.00

1560 in · 284 out · 3.7 s · rank 1 · cited [1][4][2] · pass

> # Shipaton 2026 - JetBrains Category
> 
> ## When It Runs
> The RevenueCat Shipaton 2026 runs from **August 1 to September 30** [1].
> 
> ## What You Can Win
> 
> The "Ship Kotlin Everywhere Award" has a **$30,000 prize pool** split among three winners [4]:
> - **1st place:** $15,000
> - **2nd place:** $10,000
> - **3rd place:** $5,000
> 
> The first-place winner also receives additional prizes [4]:
> - A feature on a Times Square billboard
> - An invitation to RevenueCat's App Growth Annual conference in New York City (October 21)
> - A custom Shippy trophy
> - Media spotlight
> 
> **Bonus:** Your app stays in the running for the $100,000 Grand Prize and more than 20 other Shipaton categories, with over $1,000,000 in total prizes available [4].
> 
> ## The Challenge
> Build one brand-new app using Kotlin Multiplatform and Compose Multiplatform across multiple platforms (Android, iOS, desktop, and/or web). You don't need to hit all four platforms—judges reward effective cross-platform development [2].

| expected fact | grade | note |
| --- | --- | --- |
| The JetBrains (Ship Kotlin Everywhere) award has a $30,000 prize pool | present | Clearly stated: '$30,000 prize pool' for the 'Ship Kotlin Everywhere Award' |
| It is split among three winners: $15,000, $10,000 and $5,000 | present | Explicitly listed: 1st place $15,000, 2nd place $10,000, 3rd place $5,000 |
| Shipaton 2026 runs from August 1 to September 30 | present | Stated clearly: 'August 1 to September 30' |
| The first-place app gets a feature on a Times Square billboard | present | Explicitly stated: 'A feature on a Times Square billboard' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.669 | — | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog |  | Multiplatform News Know Kotlin? Ship It Everywhere and Win at Shipaton 2026 Somewhere in your notes there’s an app idea waiting for a free weekend that never… |
| 2 ✓ | 0.651 | — | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | The Ship Kotlin Everywhere Award | The Ship Kotlin Everywhere Award JetBrains is a Gold Sponsor of Shipaton this year, with our own category. The idea is simple: reuse the Kotlin you already kno… |
| 3 ✓ | 0.623 | — | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | What you get as a participant | What you get as a participant - IntelliJ IDEA Ultimate, free for 3 months for the first 1,000 builders - Access to Junie, our AI coding agent, for 2 months fo… |
| 4 ✓ | 0.585 | — | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | What you can win | What you can win The award has a $30,000 prize pool split among three winners: $15,000, $10,000, and $5,000. The first-place app also receives Shipaton’s first… |
| 5 | 0.414 | — | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Key priorities | Key priorities Kotlin Multiplatform spans many areas, from language features and target-specific compilation to our IDE plugin. It’s a lot to track, so here ar… |

### rag+rerank — score 1.00

985 in · 276 out · 5.5 s · rank 1 · cited [1][2][3] · pass

> # Shipaton 2026 Details
> 
> **When it runs:** August 1 to September 30, 2026 [1]
> 
> **What you can win in the JetBrains category:**
> 
> The award has a **$30,000 prize pool** split among three winners: [2]
> - **1st place:** $15,000, plus a feature on a Times Square billboard, an invitation to RevenueCat's App Growth Annual conference in New York City on October 21, a custom Shippy trophy, and media spotlight [2]
> - **2nd place:** $10,000 [2]
> - **3rd place:** $5,000 [2]
> 
> **Additional opportunities:** Your Kotlin Multiplatform app also stays in the running for the $100,000 Grand Prize and more than 20 other categories across the hackathon, with over $1,000,000 worth of prizes in total. [2]
> 
> **The challenge:** Build one brand-new app using Kotlin Multiplatform and Compose Multiplatform for multiple platforms (Android, iOS, desktop, and/or web). You don't need to hit all four platforms—judges reward effective cross-platform development. [3]

| expected fact | grade | note |
| --- | --- | --- |
| The JetBrains (Ship Kotlin Everywhere) award has a $30,000 prize pool | present | Explicitly stated: '$30,000 prize pool' |
| It is split among three winners: $15,000, $10,000 and $5,000 | present | All three amounts clearly listed for 1st, 2nd, and 3rd place |
| Shipaton 2026 runs from August 1 to September 30 | present | Explicitly stated in the answer |
| The first-place app gets a feature on a Times Square billboard | present | Stated: 'a feature on a Times Square billboard' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.669 | 0.978 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog |  | Multiplatform News Know Kotlin? Ship It Everywhere and Win at Shipaton 2026 Somewhere in your notes there’s an app idea waiting for a free weekend that never… |
| 2 ✓ | 0.585 | 0.904 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | What you can win | What you can win The award has a $30,000 prize pool split among three winners: $15,000, $10,000, and $5,000. The first-place app also receives Shipaton’s first… |
| 3 ✓ | 0.651 | 0.762 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | The Ship Kotlin Everywhere Award | The Ship Kotlin Everywhere Award JetBrains is a Gold Sponsor of Shipaton this year, with our own category. The idea is simple: reuse the Kotlin you already kno… |

<details><summary>Dropped candidates (17)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 3 ✓ | 0.623 | 0.015 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | What you get as a participant |
| 7 | 0.398 | 0.006 | Kotlin 1.9.20 _ Medium | Introduction: |
| 13 | 0.390 | 0.004 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium |  |
| 15 | 0.387 | 0.003 | Exploring Kotlin 1.9.0_ What’s New in the Latest Release _ by Nandhu Raj _ Stackademic |  |
| 5 | 0.414 | 0.002 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Key priorities |
| 6 | 0.407 | 0.002 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Why This Matters |
| 8 | 0.398 | 0.001 | Kotlin 2.0.0_ A New Era in Kotlin Development _ by Halil Özel _ Medium | Conclusion ✅ |
| 19 | 0.383 | 0.001 | Exploring Kotlin 1.9.0_ What’s New in the Latest Release _ by Nandhu Raj _ Stackademic |  |
| 20 | 0.382 | 0.001 | Kotlin 2.0.0_ A New Era in Kotlin Development _ by Halil Özel _ Medium | 3. Expanded Multiplatform Support 🎗️ |
| 11 | 0.393 | 0.001 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Installation and Compatibility |
| 10 | 0.394 | 0.001 | Kotlin 2.0.0_ A New Era in Kotlin Development _ by Halil Özel _ Medium | 4. Better Tooling and IDE Support ⚡️ |
| 9 | 0.396 | 0.000 | Exploring Kotlin 2.1.0_ New Features _ by youssef moti _ Medium |  |
| 12 | 0.392 | 0.000 | Exploring Kotlin 2.1.0_ New Features _ by youssef moti _ Medium | 10. Updating to Kotlin 2.1.0 |
| 17 | 0.384 | 0.000 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🚀 Getting Started Today |
| 18 | 0.383 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › Support for Windows and Linux in the Kotlin Multiplatform IDE plugin |
| 16 | 0.384 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Build tooling › Making Gradle build configurations more beginner friendly |
| 14 | 0.389 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Build tooling › Providing a Build tools API |

</details>

### rag+rewrite+rerank — score 1.00

1938 in · 340 out · 10.7 s · rank 1 · cited [1][2][3] · pass

Queries searched: `RevenueCat Shipaton JetBrains category prizes` · `RevenueCat Shipaton 2024 dates schedule`

> # Shipaton 2026 Details
> 
> **When it runs:** August 1 to September 30, 2026 [1]
> 
> **What you can win in the JetBrains category:**
> 
> The award has a **$30,000 prize pool** split among three winners: [2]
> - **1st place:** $15,000, plus a feature on a Times Square billboard, an invitation to RevenueCat's App Growth Annual conference in New York City on October 21, a custom Shippy trophy, and media spotlight [2]
> - **2nd place:** $10,000 [2]
> - **3rd place:** $5,000 [2]
> 
> **Additional opportunities:** Your Kotlin Multiplatform app also stays in the running for the $100,000 Grand Prize and more than 20 other categories across the entire hackathon, with over $1,000,000 worth of prizes in total. [2]
> 
> **The challenge:** Build one brand-new app using Kotlin Multiplatform and Compose Multiplatform for multiple platforms (Android, iOS, desktop, and/or web). You don't need to hit all four platforms—judges reward effective cross-platform development. [3]

| expected fact | grade | note |
| --- | --- | --- |
| The JetBrains (Ship Kotlin Everywhere) award has a $30,000 prize pool | present | Explicitly stated: '$30,000 prize pool' |
| It is split among three winners: $15,000, $10,000 and $5,000 | present | All three amounts correctly listed for 1st, 2nd, and 3rd place |
| Shipaton 2026 runs from August 1 to September 30 | present | Explicitly stated in the answer |
| The first-place app gets a feature on a Times Square billboard | present | Explicitly stated: 'feature on a Times Square billboard' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.559 | 0.978 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog |  | Multiplatform News Know Kotlin? Ship It Everywhere and Win at Shipaton 2026 Somewhere in your notes there’s an app idea waiting for a free weekend that never… |
| 2 ✓ | 0.581 | 0.904 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | What you can win | What you can win The award has a $30,000 prize pool split among three winners: $15,000, $10,000, and $5,000. The first-place app also receives Shipaton’s first… |
| 3 ✓ | 0.604 | 0.762 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | The Ship Kotlin Everywhere Award | The Ship Kotlin Everywhere Award JetBrains is a Gold Sponsor of Shipaton this year, with our own category. The idea is simple: reuse the Kotlin you already kno… |

<details><summary>Dropped candidates (31)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 4 ✓ | 0.516 | 0.015 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | What you get as a participant |
| 8 | 0.299 | 0.006 | Kotlin 1.9.20 _ Medium | Introduction: |
| 18 | 0.275 | 0.004 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium |  |
| 17 | 0.276 | 0.002 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Key priorities |
| 6 | 0.317 | 0.002 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Why This Matters |
| 15 | 0.280 | 0.001 | Kotlin 2.0.0_ A New Era in Kotlin Development _ by Halil Özel _ Medium | Conclusion ✅ |
| 9 | 0.292 | 0.001 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  |
| 14 | 0.282 | 0.001 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | The Real-World Impact |
| 25 | 0.225 | 0.000 | first-agent/src/pipelineRoutes.js | pipelineRoutes |
| 7 | 0.308 | 0.000 | first-agent/src/pipeline/validatePlan.js | (module) |
| 23 | 0.227 | 0.000 | first-agent/src/scheduler/scope.js | scopedTools |
| 22 | 0.235 | 0.000 | first-agent/src/pipelineRoutes.js | pipelineRoutes |
| 24 | 0.226 | 0.000 | README.md |  |
| 31 | 0.211 | 0.000 | first-agent/src/scheduler/fakeScheduler.js | FakeScheduler |
| 20 | 0.275 | 0.000 | first-agent/src/llm/pricing.js | PRICING |
| 30 | 0.211 | 0.000 | scheduler_mcp_server/src/tools.js | createServer |
| 19 | 0.275 | 0.000 | first-agent/src/mcp/toolbox.js | prefixedName |
| 13 | 0.284 | 0.000 | first-agent/src/pipeline/planner.js | PLANNER_SYSTEM |
| 12 | 0.285 | 0.000 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What You Should Actually Share › Share This: |
| 16 | 0.280 | 0.000 | first-agent/src/llm/pricing.js | estimateCost |
| 21 | 0.237 | 0.000 | first-agent/src/pipelineRoutes.js | pipelineRoutes |
| 26 | 0.219 | 0.000 | scheduler_mcp_server/src/tools.js | createServer |
| 29 | 0.213 | 0.000 | scheduler_mcp_server/README.md |  |
| 32 | 0.210 | 0.000 | scheduler_mcp_server/src/tools.js | createServer |
| 11 | 0.288 | 0.000 | first-agent/src/llm/pricing.js | (module) |
| 28 | 0.214 | 0.000 | first-agent/src/mcp/servers.js | mcpServerDefinitions |
| 33 | 0.210 | 0.000 | first-agent/src/pipeline/planner.js | Planner |
| 10 | 0.290 | 0.000 | first-agent/src/pipeline/planner.js | catalogEntry |
| 27 | 0.219 | 0.000 | scheduler_mcp_server/src/db.js | openScheduler |
| 34 | 0.210 | 0.000 | first-agent/src/server.js | planner |
| 5 | 0.336 | 0.000 | first-agent/src/pipeline/planner.js | PLANNER_SYSTEM |

</details>

## q04

**corpus** — Can an AI coding agent work with my running Compose app through hot reload? What exactly can it do there?

*Why:* Compose Multiplatform 1.12.0 feature. Phrased without 'MCP' so retrieval has to match on meaning. A plain answer will likely describe Hot Reload in general or say it does not know of such a feature.

Expected sources: `Compose Multiplatform 1.12.0 Released - The JetBrains Blog`

### plain — score 0.13, hallucination

65 in · 395 out · 4.9 s · fail

> # AI Coding Agent with Docker Compose Hot Reload
> 
> Yes, an AI coding agent can work with your running Compose app through hot reload, but **capabilities depend on how you've set it up**.
> 
> ## What It Can Do
> 
> **With proper volume mounts:**
> - Edit source files on your host machine
> - Changes automatically reflect in the running container (if hot reload is configured)
> - Test changes immediately without rebuilding
> - Iterate quickly on code fixes and features
> 
> **Typical workflow:**
> 1. Agent modifies code files in your project directory
> 2. Hot reload detects changes (via file watchers)
> 3. App reloads without container restart
> 4. Agent can verify changes by checking logs or making requests
> 
> ## Key Requirements
> 
> For this to work, you need:
> 
> ```yaml
> # docker-compose.yml example
> services:
>   app:
>     volumes:
>       - ./src:/app/src  # Mount source code
>     environment:
>       - NODE_ENV=development  # Enable hot reload
> ```
> 
> **Language-specific setup:**
> - **Node.js**: nodemon, ts-node-dev
> - **Python**: watchdog, auto-reload
> - **Go**: air, CompileDaemon
> - **Java**: Spring DevTools
> 
> ## Limitations
> 
> - Agent can't directly execute commands in the container (unless you expose an API)
> - Can't see real-time logs unless you stream them
> - Can't interact with the running process directly—only modify files
> - Debugging is limited to what logs/APIs expose
> 
> ## Better Approach
> 
> For more control, expose an **API endpoint** the agent can call to:
> - Trigger actions
> - Get app state
> - View logs
> - Run tests
> 
> This lets the agent verify changes programmatically rather than guessing.

| expected fact | grade | note |
| --- | --- | --- |
| Compose Hot Reload ships an experimental MCP (Model Context Protocol) server for AI agents | missing | The answer discusses Docker Compose hot reload for general development, not Compose Multiplatform Hot Reload with MCP server for AI agents. |
| The agent can trigger reloads and take screenshots | missing | Not mentioned in the answer. |
| It can inspect the semantic tree and simulate clicks and text input | missing | Not mentioned in the answer. |
| It can read the application logs | partial | The answer mentions logs but only in the context of limitations ('can't see real-time logs unless you stream them'), not as a capability of the MCP server. |

Hallucination: The answer discusses Docker Compose (containerization tool) and general hot reload for web development, not Compose Multiplatform (Jetbrains' UI framework for Kotlin). This is a fundamental misunderstanding of the question's subject matter.

### rag — score 1.00

1418 in · 187 out · 3.9 s · rank 1 · cited [1] · pass

> Yes, an AI coding agent can work with your running Compose app through hot reload. [1]
> 
> Specifically, using the Model Context Protocol (MCP) server that ships with Compose Hot Reload, an agent can: [1]
> 
> - **Trigger reloads** of your application
> - **Take screenshots** to see the current state
> - **Inspect the semantic tree** of your UI
> - **Simulate clicks and text input** to interact with the app
> - **Read application logs** for debugging
> 
> The practical benefit is that the agent can verify the results of its own edits without requiring manual description. It can confirm that a reload succeeded, inspect the rendered UI, catch runtime exceptions, and iterate on changes automatically. [1]
> 
> This capability was introduced as an experimental feature in Compose Multiplatform 1.12.0. [1]

| expected fact | grade | note |
| --- | --- | --- |
| Compose Hot Reload ships an experimental MCP (Model Context Protocol) server for AI agents | present | Answer explicitly states 'Model Context Protocol (MCP) server that ships with Compose Hot Reload' |
| The agent can trigger reloads and take screenshots | present | Both capabilities are listed: 'Trigger reloads' and 'Take screenshots' |
| It can inspect the semantic tree and simulate clicks and text input | present | Both capabilities are listed: 'Inspect the semantic tree' and 'Simulate clicks and text input' |
| It can read the application logs | present | Explicitly stated: 'Read application logs' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.624 | — | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | MCP server for AI agents in Compose Hot Reload | MCP server for AI agents in Compose Hot Reload Compose Hot Reload now ships with an experimental Model Context Protocol (MCP) server that connects AI coding ag… |
| 2 | 0.527 | — | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload | Compose Hot Reload Compose Hot Reload is designed to speed up UI iteration by letting you instantly see changes without restarting the application: The Compos… |
| 3 | 0.495 | — | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency | Development tools that boost your efficiency To make building Compose Multiplatform apps faster, smoother, and more enjoyable, we’re actively improving the KMP… |
| 4 ✓ | 0.479 | — | Compose Multiplatform 1.12.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.12.0 Released Compose Multiplatform 1.12.0 is out! This version brings new tooling for AI assistants, improvem… |
| 5 | 0.409 | — | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.10.0: Unified @Preview, Navigation 3, and Stable Compose Hot Reload Compose Multiplatform 1.10.0 has been rele… |

### rag+rerank — score 1.00

1372 in · 198 out · 7.4 s · rank 1 · cited [1] · pass

> Yes, an AI coding agent can work with your running Compose app through hot reload using an experimental Model Context Protocol (MCP) server. [1]
> 
> Here's what the agent can do: [1]
> 
> - **Trigger reloads** of your application
> - **Take screenshots** to see the current state
> - **Inspect the semantic tree** to understand the UI structure
> - **Simulate clicks and text input** to interact with the app
> - **Read application logs** for debugging information
> 
> The key benefit is that the agent can verify the results of its own edits automatically. It can confirm that a reload succeeded, inspect the rendered UI, catch runtime exceptions, and iterate on changes—all without requiring you to manually describe what's on screen. [1]
> 
> For detailed instructions on connecting your agent and the full list of available tools, you would need to consult the Compose Hot Reload documentation. [1]

| expected fact | grade | note |
| --- | --- | --- |
| Compose Hot Reload ships an experimental MCP (Model Context Protocol) server for AI agents | present | Answer explicitly states 'experimental Model Context Protocol (MCP) server' |
| The agent can trigger reloads and take screenshots | present | Both capabilities are listed: 'Trigger reloads' and 'Take screenshots' |
| It can inspect the semantic tree and simulate clicks and text input | present | Both capabilities are listed: 'Inspect the semantic tree' and 'Simulate clicks and text input' |
| It can read the application logs | present | Explicitly stated: 'Read application logs' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.624 | 0.999 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | MCP server for AI agents in Compose Hot Reload | MCP server for AI agents in Compose Hot Reload Compose Hot Reload now ships with an experimental Model Context Protocol (MCP) server that connects AI coding ag… |
| 2 ✓ | 0.479 | 0.649 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.12.0 Released Compose Multiplatform 1.12.0 is out! This version brings new tooling for AI assistants, improvem… |
| 3 | 0.527 | 0.446 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload | Compose Hot Reload Compose Hot Reload is designed to speed up UI iteration by letting you instantly see changes without restarting the application: The Compos… |
| 4 | 0.495 | 0.392 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency | Development tools that boost your efficiency To make building Compose Multiplatform apps faster, smoother, and more enjoyable, we’re actively improving the KMP… |
| 5 | 0.403 | 0.025 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › Support for Windows and Linux in the Kotlin Multiplatform IDE plugin | Kotlin Multiplatform IDE plugin Support for Windows and Linux in the Kotlin Multiplatform IDE plugin We’ve heard your requests and will be releasing the Kotli… |

<details><summary>Dropped candidates (15)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 5 | 0.409 | 0.018 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  |
| 9 | 0.392 | 0.004 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native |
| 11 | 0.384 | 0.001 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › General and quality improvements |
| 16 | 0.375 | 0.001 | first-agent/src/server.js | (module) |
| 7 | 0.405 | 0.000 | first-agent/src/agents.js | AGENT_PATTERN |
| 12 | 0.383 | 0.000 | first-agent/src/agent.js | Agent |
| 14 | 0.378 | 0.000 | first-agent/src/llm/anthropic.js | FakeProvider |
| 10 | 0.385 | 0.000 | first-agent/README.md |  |
| 20 | 0.362 | 0.000 | first-agent/src/context/patch.js | ROUTES |
| 13 | 0.380 | 0.000 | first-agent/src/agents.js | (module) |
| 19 | 0.363 | 0.000 | first-agent/README.md | Pipelines |
| 6 | 0.406 | 0.000 | first-agent/src/agents.js | AGENTS |
| 15 | 0.376 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Common @Preview annotation |
| 18 | 0.363 | 0.000 | first-agent/src/pipeline/runner.js | (module) |
| 17 | 0.366 | 0.000 | first-agent/src/toolLoop.js | (module) |

</details>

### rag+rewrite+rerank — score 1.00

2310 in · 259 out · 14.2 s · rank 4 → 1 · cited [1] · pass

Queries searched: `Compose hot reload AI coding agent` · `Compose Multiplatform hot reload capabilities` · `AI agent Compose app live editing`

> Yes, an AI coding agent can work with your running Compose app through hot reload using an experimental Model Context Protocol (MCP) server. [1]
> 
> Here's what the agent can do: [1]
> 
> - **Trigger reloads** of your application
> - **Take screenshots** to see the current state
> - **Inspect the semantic tree** to understand the UI structure
> - **Simulate clicks and text input** to interact with the app
> - **Read application logs** for debugging information
> 
> The key benefit is that the agent can verify the results of its own edits automatically. It can confirm that a reload succeeded, inspect the rendered UI, catch runtime exceptions, and iterate on changes—all without requiring you to manually describe what's on screen. [1]
> 
> For detailed instructions on connecting your agent and the full list of available tools, you would need to consult the Compose Hot Reload documentation. [1]

| expected fact | grade | note |
| --- | --- | --- |
| Compose Hot Reload ships an experimental MCP (Model Context Protocol) server for AI agents | present | Explicitly stated in the answer |
| The agent can trigger reloads and take screenshots | present | Both capabilities listed in the bullet points |
| It can inspect the semantic tree and simulate clicks and text input | present | Both capabilities listed in the bullet points |
| It can read the application logs | present | Explicitly stated in the bullet points |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.614 | 0.999 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | MCP server for AI agents in Compose Hot Reload | MCP server for AI agents in Compose Hot Reload Compose Hot Reload now ships with an experimental Model Context Protocol (MCP) server that connects AI coding ag… |
| 2 ✓ | 0.589 | 0.649 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.12.0 Released Compose Multiplatform 1.12.0 is out! This version brings new tooling for AI assistants, improvem… |
| 3 | 0.722 | 0.446 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload | Compose Hot Reload Compose Hot Reload is designed to speed up UI iteration by letting you instantly see changes without restarting the application: The Compos… |
| 4 | 0.637 | 0.392 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency | Development tools that boost your efficiency To make building Compose Multiplatform apps faster, smoother, and more enjoyable, we’re actively improving the KMP… |
| 5 | 0.564 | 0.025 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › Support for Windows and Linux in the Kotlin Multiplatform IDE plugin | Kotlin Multiplatform IDE plugin Support for Windows and Linux in the Kotlin Multiplatform IDE plugin We’ve heard your requests and will be releasing the Kotli… |

<details><summary>Dropped candidates (40)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 2 | 0.657 | 0.018 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  |
| 9 | 0.551 | 0.004 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native |
| 18 | 0.520 | 0.004 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Everything you need to build apps for real-world use |
| 20 | 0.514 | 0.002 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile |
| 15 | 0.525 | 0.001 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious |
| 6 | 0.582 | 0.001 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  |
| 11 | 0.538 | 0.001 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt |
| 22 | 0.445 | 0.001 | first-agent/src/server.js | (module) |
| 13 ✓ | 0.526 | 0.001 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | Automatic font fallback for web |
| 7 | 0.573 | 0.000 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  |
| 24 | 0.433 | 0.000 | first-agent/src/agents.js | AGENT_PATTERN |
| 17 | 0.520 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Release Compose Multiplatform for Web in Beta |
| 23 | 0.439 | 0.000 | first-agent/src/agent.js | Agent |
| 14 | 0.525 | 0.000 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Resources updates and improvements |
| 12 | 0.527 | 0.000 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Drag and drop on desktop |
| 19 | 0.518 | 0.000 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Improved touch interop between Compose Multiplatform and native iOS |
| 41 | 0.374 | 0.000 | first-agent/src/summarizer.js | (module) |
| 45 | 0.367 | 0.000 | first-agent/src/llm/anthropic.js | fakeBrief |
| 35 | 0.401 | 0.000 | first-agent/src/llm/anthropic.js | FakeProvider |
| 44 | 0.368 | 0.000 | first-agent/src/summarizer.js | SYSTEM_PROMPT |
| 25 | 0.432 | 0.000 | first-agent/README.md |  |
| 32 | 0.412 | 0.000 | first-agent/src/agents.js | (module) |
| 28 | 0.421 | 0.000 | first-agent/src/llm/anthropic.js | FakeProvider |
| 29 | 0.420 | 0.000 | first-agent/src/agents.js | AGENTS |
| 40 | 0.375 | 0.000 | first-agent/src/llm/anthropic.js | FakeProvider |
| 34 | 0.406 | 0.000 | first-agent/src/llm/anthropic.js | AnthropicProvider |
| 39 | 0.376 | 0.000 | first-agent/src/context/memory.js | Briefer |
| 33 | 0.407 | 0.000 | first-agent/README.md | Agents |
| 27 | 0.422 | 0.000 | first-agent/README.md | Pipelines |
| 37 | 0.388 | 0.000 | first-agent/src/context/invariants.js | InvariantProposer |
| 21 | 0.450 | 0.000 | first-agent/src/agents.js | AGENTS |
| 10 | 0.545 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Common @Preview annotation |
| 26 | 0.428 | 0.000 | first-agent/src/agent.js | (module) |
| 36 | 0.393 | 0.000 | first-agent/src/context/memory.js | MemoryStrategy |
| 31 | 0.415 | 0.000 | first-agent/src/pipeline/runner.js | (module) |
| 42 | 0.371 | 0.000 | first-agent/src/context/memory.js | BRIEFER_PROMPT |
| 38 | 0.377 | 0.000 | first-agent/src/llm/anthropic.js | fakeSummary |
| 16 | 0.522 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Navigation 3 |
| 30 | 0.419 | 0.000 | first-agent/src/toolLoop.js | (module) |
| 43 | 0.369 | 0.000 | first-agent/src/context/memory.js | MemoryStrategy |

</details>

## q05

**corpus** — Which well-known companies have given KotlinConf talks about running KMP in production, and how much code did the fintech one end up sharing?

*Why:* Names and numbers from the curated talk list. A plain answer may name other companies (Netflix, Cash App, …) that are real KMP users but not in this list; those are not wrong, but the 55% / 130 figures are needed.

Expected sources: `The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog`

### plain — score 0.00, declined

75 in · 203 out · 2.4 s · fail

> I don't have specific information about which companies have given KotlinConf talks about running Kotlin Multiplatform (KMP) in production, or details about a fintech company's code-sharing metrics from such a talk.
> 
> To find this information, I'd recommend:
> 
> 1. **Checking KotlinConf's official resources** - Visit the KotlinConf website or YouTube channel where talks are typically recorded and archived
> 2. **Searching Kotlin's blog** - JetBrains often publishes summaries of notable talks
> 3. **Looking at talk abstracts** - Conference schedules usually list speaker names and companies
> 
> If you remember any additional details (like the year of the conference, speaker names, or the fintech company's name), I'd be happy to help you search more effectively. Alternatively, if you have a link to a specific talk, I can help you find the information you're looking for.

| expected fact | grade | note |
| --- | --- | --- |
| StoneCo (a fintech) reached 55% shared code | missing | Answer declines to provide information rather than stating the fact |
| StoneCo trained 130 mobile engineers for the shift | missing | Answer declines to provide information rather than stating the fact |
| Duolingo ships weekly to 40M+ daily users with KMP | missing | Answer declines to provide information rather than stating the fact |
| McDonald's uses KMP to drive navigation state while the UI stays native | missing | Answer declines to provide information rather than stating the fact |

### rag — score 1.00

1679 in · 166 out · 2.2 s · rank 1 · cited [2] · pass

> Based on the documents, the well-known companies that have given KotlinConf talks about running KMP in production are: [2]
> 
> 1. **Duolingo** - Ships weekly to 40M+ daily users across Android, iOS, and Web [2]
> 2. **McDonald's** - Uses KMP to drive navigation state in their app [2]
> 3. **StoneCo** - A fintech company serving 4 million users [2]
> 
> Regarding the fintech company's code sharing: **StoneCo achieved 55% code sharing across two massive apps.** [2] The talk also notes that they trained 130 mobile engineers to shift their paradigm and measured improvements in developer satisfaction and velocity. [2]

| expected fact | grade | note |
| --- | --- | --- |
| StoneCo (a fintech) reached 55% shared code | present | Explicitly stated: 'StoneCo achieved 55% code sharing' |
| StoneCo trained 130 mobile engineers for the shift | present | Explicitly stated: 'they trained 130 mobile engineers' |
| Duolingo ships weekly to 40M+ daily users with KMP | present | Explicitly stated: 'Ships weekly to 40M+ daily users' |
| McDonald's uses KMP to drive navigation state while the UI stays native | present | Explicitly stated: 'Uses KMP to drive navigation state in their app' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.548 | — | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ?️ Part 2: Getting Your Hands Dirty | ?️ Part 2: Getting Your Hands Dirty Okay, you’re inspired. Now let’s look at the code. Compose Multiplatform for iOS: Ready for Production \| Sebastian Aigner … |
| 2 ✓ | 0.546 | — | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ? Part 1: Production Case Studies | ? Part 1: Production Case Studies Theory is nice, but does it scale? These teams proved it does. Duolingo + KMP: A Case Study in Productivity \| John Rodriguez… |
| 3 ✓ | 0.525 | — | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog |  | Multiplatform The Ultimate KMP Watchlist: Level Up Your Skills in 10 Talks The best way to skip the “beginner mistakes” phase is to learn from the teams who h… |
| 4 | 0.524 | — | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | The Real-World Impact | The Real-World Impact In an article about their migration to KMP with Kotlin 2.3, Basecamp reported that code duplication was reduced by 40%. Auth, data sync, … |
| 5 | 0.499 | — | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways | Key Takeaways - Real KMP pain points solved for Kotlin 2.3 — better iOS interop, stable Compose, better tooling - Compose Multiplatform If you need to share c… |

### rag+rerank — score 1.00

1921 in · 189 out · 7.6 s · rank 1 · cited [1][5] · pass

> Based on the documents, the well-known companies that have given KotlinConf talks about running KMP in production are: [1]
> 
> 1. **Duolingo** - Ships weekly to 40M+ daily users across Android, iOS, and Web [1]
> 2. **McDonald's** - Uses KMP to drive navigation state with a "dumb client" architecture [1]
> 3. **StoneCo** - A fintech giant serving 4 million users [1]
> 4. **Meetup** - Migrated networking to KMP [5]
> 
> Regarding the fintech company's code sharing: **StoneCo achieved 55% code sharing** across two massive apps. This was accomplished by training 130 mobile engineers to shift their paradigm, and the company measured significant impacts on developer satisfaction and velocity. [1]

| expected fact | grade | note |
| --- | --- | --- |
| StoneCo (a fintech) reached 55% shared code | present | Explicitly stated: 'StoneCo achieved 55% code sharing' |
| StoneCo trained 130 mobile engineers for the shift | present | Explicitly stated: 'training 130 mobile engineers to shift their paradigm' |
| Duolingo ships weekly to 40M+ daily users with KMP | present | Explicitly stated: 'Ships weekly to 40M+ daily users across Android, iOS, and Web' |
| McDonald's uses KMP to drive navigation state while the UI stays native | present | Explicitly stated: 'Uses KMP to drive navigation state with a "dumb client" architecture' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.546 | 0.975 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ? Part 1: Production Case Studies | ? Part 1: Production Case Studies Theory is nice, but does it scale? These teams proved it does. Duolingo + KMP: A Case Study in Productivity \| John Rodriguez… |
| 2 | 0.499 | 0.205 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways | Key Takeaways - Real KMP pain points solved for Kotlin 2.3 — better iOS interop, stable Compose, better tooling - Compose Multiplatform If you need to share c… |
| 3 ✓ | 0.525 | 0.169 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog |  | Multiplatform The Ultimate KMP Watchlist: Level Up Your Skills in 10 Talks The best way to skip the “beginner mistakes” phase is to learn from the teams who h… |
| 4 | 0.439 | 0.160 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | What you can win | What you can win The award has a $30,000 prize pool split among three winners: $15,000, $10,000, and $5,000. The first-place app also receives Shipaton’s first… |
| 5 ✓ | 0.461 | 0.138 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ? Part 3: The iOS Perspective | ? Part 3: The iOS Perspective Because your iOS teammates need to love this too. KMP in Action: A Production Case Study \| Annyce Davis (2024)Convincing an iOS … |

<details><summary>Dropped candidates (15)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 4 | 0.524 | 0.115 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | The Real-World Impact |
| 7 | 0.471 | 0.038 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium |  |
| 6 ✓ | 0.477 | 0.037 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ? Part 4: The Deep Dive |
| 10 ✓ | 0.460 | 0.023 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ? Join us in the Real World |
| 11 | 0.460 | 0.018 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Why Should You Care About This in Your Codebase |
| 14 | 0.425 | 0.008 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | Key Takeaways |
| 15 | 0.422 | 0.004 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › General and quality improvements |
| 1 ✓ | 0.548 | 0.002 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ?️ Part 2: Getting Your Hands Dirty |
| 16 | 0.422 | 0.001 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 3. Backend Integration That Makes Sense |
| 19 | 0.412 | 0.001 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Build tooling › Reducing the effort to publish KMP libraries |
| 8 | 0.470 | 0.000 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What You Should Actually Share › Share This: |
| 18 | 0.418 | 0.000 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🔮 What This Means for Your Daily Development |
| 13 | 0.434 | 0.000 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Getting Started Without the Hype |
| 17 | 0.420 | 0.000 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | The Ship Kotlin Everywhere Award |
| 20 | 0.404 | 0.000 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog |  |

</details>

### rag+rewrite+rerank — score 1.00

2869 in · 226 out · 7.8 s · rank 1 · cited [1][5] · pass

Queries searched: `KotlinConf talks KMP production companies` · `fintech KMP production code sharing`

> Based on the documents, the well-known companies that have given KotlinConf talks about running KMP in production are: [1]
> 
> 1. **Duolingo** - Ships weekly to 40M+ daily users across Android, iOS, and Web [1]
> 2. **McDonald's** - Uses KMP to drive navigation state with a "dumb client" architecture [1]
> 3. **StoneCo** - A fintech giant serving 4 million users [1]
> 4. **Meetup** - Migrated networking to KMP [5]
> 
> Regarding the fintech company's code sharing: **StoneCo achieved 55% shared code** across two massive apps after training 130 mobile engineers to shift their paradigm. [1]

| expected fact | grade | note |
| --- | --- | --- |
| StoneCo (a fintech) reached 55% shared code | present | Explicitly stated: 'StoneCo achieved 55% shared code' |
| StoneCo trained 130 mobile engineers for the shift | present | Explicitly stated: 'training 130 mobile engineers' |
| Duolingo ships weekly to 40M+ daily users with KMP | present | Explicitly stated: 'Ships weekly to 40M+ daily users' |
| McDonald's uses KMP to drive navigation state while the UI stays native | present | Stated as 'Uses KMP to drive navigation state with a "dumb client" architecture' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.537 | 0.975 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ? Part 1: Production Case Studies | ? Part 1: Production Case Studies Theory is nice, but does it scale? These teams proved it does. Duolingo + KMP: A Case Study in Productivity \| John Rodriguez… |
| 2 | 0.518 | 0.205 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways | Key Takeaways - Real KMP pain points solved for Kotlin 2.3 — better iOS interop, stable Compose, better tooling - Compose Multiplatform If you need to share c… |
| 3 ✓ | 0.574 | 0.169 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog |  | Multiplatform The Ultimate KMP Watchlist: Level Up Your Skills in 10 Talks The best way to skip the “beginner mistakes” phase is to learn from the teams who h… |
| 4 | 0.448 | 0.160 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | What you can win | What you can win The award has a $30,000 prize pool split among three winners: $15,000, $10,000, and $5,000. The first-place app also receives Shipaton’s first… |
| 5 ✓ | 0.501 | 0.138 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ? Part 3: The iOS Perspective | ? Part 3: The iOS Perspective Because your iOS teammates need to love this too. KMP in Action: A Production Case Study \| Annyce Davis (2024)Convincing an iOS … |

<details><summary>Dropped candidates (22)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 9 | 0.492 | 0.115 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | The Real-World Impact |
| 12 | 0.471 | 0.038 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium |  |
| 4 ✓ | 0.547 | 0.037 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ? Part 4: The Deep Dive |
| 3 ✓ | 0.562 | 0.023 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ? Join us in the Real World |
| 13 | 0.468 | 0.018 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Why Should You Care About This in Your Codebase |
| 23 | 0.375 | 0.009 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Performance that’s ready for production |
| 19 | 0.433 | 0.008 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | Key Takeaways |
| 14 | 0.461 | 0.006 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Key priorities |
| 15 | 0.455 | 0.004 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › Support for Windows and Linux in the Kotlin Multiplatform IDE plugin |
| 7 | 0.504 | 0.004 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › General and quality improvements |
| 1 ✓ | 0.589 | 0.002 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ?️ Part 2: Getting Your Hands Dirty |
| 21 | 0.427 | 0.002 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency |
| 11 | 0.478 | 0.002 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Build tooling › Making Gradle build configurations more beginner friendly |
| 22 | 0.385 | 0.001 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  |
| 10 | 0.480 | 0.001 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Build tooling › Reducing the effort to publish KMP libraries |
| 25 | 0.366 | 0.000 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native |
| 16 | 0.453 | 0.000 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What You Should Actually Share › Share This: |
| 24 | 0.369 | 0.000 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Getting Started Without the Hype |
| 17 | 0.451 | 0.000 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | The Ship Kotlin Everywhere Award |
| 27 | 0.350 | 0.000 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt |
| 20 | 0.431 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/Native › Reducing Kotlin/Native build times |
| 26 | 0.358 | 0.000 | first-agent/src/mcp/oauthProvider.js | (module) |

</details>

## q06

**corpus** — Which compiler flags turn on context parameters and context-sensitive resolution in Kotlin 2.2.0, and is there a Kotlin/Native switch that reduces string memory?

*Why:* Exact flag and property names. A strong model may know the two -X flags; the Latin-1 property and the 50% figure come from the article. A made-up property name is a hallucination.

Expected sources: `Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium`

### plain — score 0.00, hallucination

78 in · 382 out · 4.3 s · fail

> # Kotlin 2.2.0 Compiler Flags
> 
> ## Context Parameters and Context-Sensitive Resolution
> 
> In Kotlin 2.2.0, context parameters are controlled by:
> 
> **`-Xcontext-receivers`**
> 
> This flag enables context receiver support, which allows functions and classes to declare implicit context parameters that are resolved based on the types available in scope.
> 
> Example usage:
> ```bash
> kotlinc -Xcontext-receivers myfile.kt
> ```
> 
> In Gradle:
> ```kotlin
> kotlin {
>     compilerOptions {
>         freeCompilerArgs.add("-Xcontext-receivers")
>     }
> }
> ```
> 
> ## Kotlin/Native String Memory Optimization
> 
> For reducing string memory in Kotlin/Native, use:
> 
> **`-Xshort-module-name`** or **`-Xopt-in=kotlin.native.internal.InternalNativeApi`**
> 
> However, the most relevant flag for string memory optimization is:
> 
> **`-Xbinary=memoryModel=experimental`** (for memory model changes)
> 
> Or more directly, **`-Xgc=noop`** or **`-Xgc=same-thread`** can affect memory behavior, though these are GC-related rather than string-specific.
> 
> **Note:** Kotlin/Native doesn't have a dedicated "reduce string memory" flag. String optimization typically happens through:
> - General optimization flags like `-opt`
> - Choosing appropriate GC settings
> - Using `const val` for compile-time constants instead of runtime strings
> 
> If you're looking for a specific string interning or deduplication feature, that would typically be handled through code patterns rather than compiler flags.

| expected fact | grade | note |
| --- | --- | --- |
| Context parameters are enabled with -Xcontext-parameters | contradicted | Answer states -Xcontext-receivers instead of -Xcontext-parameters |
| Context-sensitive resolution is enabled with -Xcontext-sensitive-resolution | missing | Answer does not mention -Xcontext-sensitive-resolution at all |
| kotlin.native.binary.latin1Strings=true enables Latin-1 strings on Kotlin/Native | missing | Answer does not mention this property; instead discusses unrelated flags |
| Latin-1 strings use about 50% less memory | missing | Answer does not mention Latin-1 strings or their memory savings |

Hallucination: The answer claims -Xcontext-receivers is the flag for context parameters, but the expected fact specifies -Xcontext-parameters. The answer also invents several unrelated flags (-Xshort-module-name, -Xopt-in=kotlin.native.internal.InternalNativeApi, -Xbinary=memoryModel=experimental, -Xgc flags) that do not address the actual question about Latin-1 strings.

### rag — score 1.00

1407 in · 135 out · 1.7 s · rank 1 · cited [4][2] · pass

> Based on the documents provided:
> 
> **Compiler flags for context features:**
> - Context parameters are enabled with the `-Xcontext-parameters` flag [4]
> - Context-sensitive resolution is enabled with the `-Xcontext-sensitive-resolution` flag [4]
> 
> **Kotlin/Native switch for string memory reduction:**
> Yes, there is a Gradle property that reduces string memory. Setting `kotlin.native.binary.latin1Strings=true` in gradle.properties enables Latin-1 string optimization, which reduces memory usage by 50% for strings containing only Latin-1 characters [2]

| expected fact | grade | note |
| --- | --- | --- |
| Context parameters are enabled with -Xcontext-parameters | present | Answer correctly states the flag |
| Context-sensitive resolution is enabled with -Xcontext-sensitive-resolution | present | Answer correctly states the flag |
| kotlin.native.binary.latin1Strings=true enables Latin-1 strings on Kotlin/Native | present | Answer correctly identifies the property and its purpose |
| Latin-1 strings use about 50% less memory | present | Answer states '50% less memory' which matches the expected fact |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.642 | — | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements › Per-Object Memory Allocation | 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements The Kotlin/Native improvements in 2.2.0 are substantial, especially for production applications.… |
| 2 ✓ | 0.621 | — | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements › Latin-1 String Optimization | Latin-1 String Optimization // gradle.properties kotlin.native.binary.latin1Strings=true // Strings with Latin-1 characters now use 50% less memory class TextP… |
| 3 ✓ | 0.603 | — | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🔮 What This Means for Your Daily Development | 🔮 What This Means for Your Daily Development After using these features for several weeks, here’s what I’ve noticed: Code Quality: My codebases are cleaner a… |
| 4 ✓ | 0.601 | — | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🚀 Getting Started Today | 🚀 Getting Started Today Ready to upgrade? Here’s your migration checklist: - Update your Kotlin version to 2.2.0 in build.gradle.kts - Enable context parame… |
| 5 ✓ | 0.579 | — | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🎯 Context-Sensitive @all Annotation Target | 🎯 Context-Sensitive @all Annotation Target This small feature saves enormous amounts of time when working with annotations. // Before: Tedious and error-pron… |

### rag+rerank — score 0.88, hallucination

1723 in · 173 out · 5.0 s · rank 1 · cited [2][5] · generation miss

> Based on the documents provided:
> 
> **Compiler flags for context parameters and context-sensitive resolution:** [2]
> - Context parameters: `-Xcontext-parameters`
> - Context-sensitive resolution: `-Xcontext-sensitive-resolution`
> 
> **Kotlin/Native switch for string memory reduction:** [5]
> Yes, there is a Gradle property that reduces string memory usage:
> - `kotlin.native.binary.latin1Strings=true` — This optimization reduces memory usage by 50% for strings containing only Latin-1 characters by enabling Latin-1 String Optimization.
> 
> According to the documents, this Latin-1 optimization resulted in approximately 30% memory reduction for text-heavy operations in a production Kotlin Multiplatform project with iOS targets. [5]

| expected fact | grade | note |
| --- | --- | --- |
| Context parameters are enabled with -Xcontext-parameters | present | Answer correctly states the flag |
| Context-sensitive resolution is enabled with -Xcontext-sensitive-resolution | present | Answer correctly states the flag |
| kotlin.native.binary.latin1Strings=true enables Latin-1 strings on Kotlin/Native | present | Answer correctly identifies the property and its purpose |
| Latin-1 strings use about 50% less memory | partial | Answer mentions 50% reduction but then contradicts this by stating 30% reduction for text-heavy operations |

Hallucination: The answer claims 'approximately 30% memory reduction for text-heavy operations' which contradicts the expected fact that Latin-1 strings use about 50% less memory. This is a specific quantitative claim that conflicts with the expected information."

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.563 | 0.500 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🎯 Context Parameters: Say Goodbye to Dependency Hell › The New Way (Welcome to Paradise) | The New Way (Welcome to Paradise) // Kotlin 2.2.0 - Context Parameters in action context(database: Database, logger: Logger) class UserService { fun getUse… |
| 2 ✓ | 0.601 | 0.455 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🚀 Getting Started Today | 🚀 Getting Started Today Ready to upgrade? Here’s your migration checklist: - Update your Kotlin version to 2.2.0 in build.gradle.kts - Enable context parame… |
| 3 | 0.519 | 0.397 | Kotlin 2.0.0_ A New Era in Kotlin Development _ by Halil Özel _ Medium | 1. Enhanced Language Features 🔥 | 1. Enhanced Language Features 🔥 Kotlin 2.0.0 introduces several new language features that enhance the expressiveness and conciseness of the language. Some of… |
| 4 ✓ | 0.603 | 0.301 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🔮 What This Means for Your Daily Development | 🔮 What This Means for Your Daily Development After using these features for several weeks, here’s what I’ve noticed: Code Quality: My codebases are cleaner a… |
| 5 ✓ | 0.621 | 0.292 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements › Latin-1 String Optimization | Latin-1 String Optimization // gradle.properties kotlin.native.binary.latin1Strings=true // Strings with Latin-1 characters now use 50% less memory class TextP… |

<details><summary>Dropped candidates (15)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 1 ✓ | 0.642 | 0.288 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements › Per-Object Memory Allocation |
| 10 ✓ | 0.562 | 0.186 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🎯 Context Parameters: Say Goodbye to Dependency Hell › The Old Way (We Don’t Miss This) |
| 20 ✓ | 0.511 | 0.153 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | The Bottom Line |
| 7 | 0.568 | 0.107 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Why Should You Care About This in Your Codebase |
| 14 | 0.524 | 0.093 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/Native › Reducing Kotlin/Native build times |
| 11 | 0.552 | 0.058 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 3. Smarter Exhaustiveness Checks in when |
| 8 | 0.567 | 0.033 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | Key Takeaways |
| 18 | 0.514 | 0.030 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Main Features |
| 13 | 0.532 | 0.027 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | headline change headlined: Explicit Context Arguments Go Stable |
| 15 | 0.520 | 0.022 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 1. Smarter overload resolution with suspend function |
| 12 | 0.539 | 0.016 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | What Kotlin 2.4 Actually Delivers › Language-level changes: |
| 19 | 0.512 | 0.015 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | 1. Context Parameters Are Stable |
| 5 ✓ | 0.579 | 0.007 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🎯 Context-Sensitive @all Annotation Target |
| 6 ✓ | 0.573 | 0.005 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🎭 Context-Sensitive Resolution: Code That Reads Like English |
| 16 | 0.520 | 0.001 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 5. Build & Gradle Improvements |

</details>

### rag+rewrite+rerank — score 0.88, hallucination

2674 in · 230 out · 7.8 s · rank 1 · cited [2][5] · generation miss

Queries searched: `Kotlin 2.2.0 context parameters compiler flags` · `Kotlin/Native string memory reduction switch`

> Based on the documents provided:
> 
> **Compiler flags for context parameters and context-sensitive resolution:** [2]
> - Context parameters: `-Xcontext-parameters`
> - Context-sensitive resolution: `-Xcontext-sensitive-resolution`
> 
> **Kotlin/Native switch for string memory reduction:** [5]
> Yes, there is a Gradle property that reduces string memory usage:
> - `kotlin.native.binary.latin1Strings=true` — This optimization reduces memory usage by 50% for strings containing only Latin-1 characters by enabling Latin-1 String Optimization.
> 
> According to the documents, this Latin-1 optimization resulted in approximately 30% memory reduction for text-heavy operations in a production Kotlin Multiplatform project with iOS targets. [5]

| expected fact | grade | note |
| --- | --- | --- |
| Context parameters are enabled with -Xcontext-parameters | present | Answer correctly states the flag |
| Context-sensitive resolution is enabled with -Xcontext-sensitive-resolution | present | Answer correctly states the flag |
| kotlin.native.binary.latin1Strings=true enables Latin-1 strings on Kotlin/Native | present | Answer correctly identifies the property and its purpose |
| Latin-1 strings use about 50% less memory | partial | Answer mentions 50% reduction but then contradicts this by stating 30% reduction for text-heavy operations |

Hallucination: The answer claims 'approximately 30% memory reduction for text-heavy operations' which contradicts the expected fact that Latin-1 strings use about 50% less memory. This is a specific quantitative claim that conflicts with the expected information."

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.619 | 0.500 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🎯 Context Parameters: Say Goodbye to Dependency Hell › The New Way (Welcome to Paradise) | The New Way (Welcome to Paradise) // Kotlin 2.2.0 - Context Parameters in action context(database: Database, logger: Logger) class UserService { fun getUse… |
| 2 ✓ | 0.618 | 0.455 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🚀 Getting Started Today | 🚀 Getting Started Today Ready to upgrade? Here’s your migration checklist: - Update your Kotlin version to 2.2.0 in build.gradle.kts - Enable context parame… |
| 3 | 0.541 | 0.397 | Kotlin 2.0.0_ A New Era in Kotlin Development _ by Halil Özel _ Medium | 1. Enhanced Language Features 🔥 | 1. Enhanced Language Features 🔥 Kotlin 2.0.0 introduces several new language features that enhance the expressiveness and conciseness of the language. Some of… |
| 4 ✓ | 0.542 | 0.301 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🔮 What This Means for Your Daily Development | 🔮 What This Means for Your Daily Development After using these features for several weeks, here’s what I’ve noticed: Code Quality: My codebases are cleaner a… |
| 5 ✓ | 0.652 | 0.292 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements › Latin-1 String Optimization | Latin-1 String Optimization // gradle.properties kotlin.native.binary.latin1Strings=true // Strings with Latin-1 characters now use 50% less memory class TextP… |

<details><summary>Dropped candidates (29)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 5 ✓ | 0.595 | 0.288 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements › Per-Object Memory Allocation |
| 18 | 0.532 | 0.230 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Quick Context: 2.3 is where we left off |
| 4 ✓ | 0.610 | 0.186 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🎯 Context Parameters: Say Goodbye to Dependency Hell › The Old Way (We Don’t Miss This) |
| 22 ✓ | 0.516 | 0.153 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | The Bottom Line |
| 20 | 0.529 | 0.120 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key takeaways: |
| 6 | 0.583 | 0.107 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Why Should You Care About This in Your Codebase |
| 11 | 0.550 | 0.093 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/Native › Reducing Kotlin/Native build times |
| 19 | 0.531 | 0.078 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 🚀 Final Thoughts |
| 12 | 0.543 | 0.058 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 3. Smarter Exhaustiveness Checks in when |
| 28 | 0.435 | 0.056 | Exploring Kotlin 2.1.0_ New Features _ by youssef moti _ Medium | 3. Multi-Dollar String Interpolation |
| 24 | 0.449 | 0.048 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 1. Sensible Native Interop That Plays Nice With You |
| 9 | 0.557 | 0.033 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | Key Takeaways |
| 31 | 0.422 | 0.030 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Main Features |
| 10 | 0.555 | 0.027 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | headline change headlined: Explicit Context Arguments Go Stable |
| 23 | 0.450 | 0.022 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 1. Smarter overload resolution with suspend function |
| 8 | 0.574 | 0.016 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | What Kotlin 2.4 Actually Delivers › Language-level changes: |
| 14 | 0.542 | 0.015 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | 1. Context Parameters Are Stable |
| 32 | 0.420 | 0.009 | Exploring Kotlin 2.1.0_ New Features _ by youssef moti _ Medium | 6. Kotlin/Native Improvements |
| 34 | 0.418 | 0.009 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium |  |
| 7 ✓ | 0.579 | 0.007 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🎯 Context-Sensitive @all Annotation Target |
| 25 | 0.442 | 0.005 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 2. return in Expression Body Functions |
| 17 ✓ | 0.535 | 0.005 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🎭 Context-Sensitive Resolution: Code That Reads Like English |
| 16 ✓ | 0.539 | 0.001 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🛠️ Gradle Plugin Enhancements: Developer Experience First › Binary Compatibility Validation |
| 21 | 0.526 | 0.001 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 5. Build & Gradle Improvements |
| 26 | 0.441 | 0.000 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | 9. Invokedynamic for when Expressions which is now the Default |
| 30 | 0.427 | 0.000 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 4. Reified Exceptions in catch |
| 27 ✓ | 0.435 | 0.000 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🔐 Stable Base64: Finally, Built-in Encoding That Works Everywhere |
| 29 | 0.433 | 0.000 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | But now name-based destructuring is as stable as well |
| 33 | 0.418 | 0.000 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | 3. Name-Based Destructuring (Experimental) |

</details>

## q07

**corpus** — How is Compose for Web supposed to run on older browsers that lack newer WebAssembly features?

*Why:* A roadmap item from the August 2025 update. Plain mode may guess (polyfills, 'not supported') rather than name the Kotlin/JS fallback.

Expected sources: `What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog`

### plain — score 0.13, hallucination

63 in · 369 out · 4.6 s · fail

> # Compose for Web and Older Browser Support
> 
> Compose for Web (Jetpack Compose for Web) has **limited support for older browsers** because it relies on WebAssembly, which has varying levels of support across browser versions.
> 
> ## The Reality
> 
> - **Modern browsers only**: Compose for Web is designed for browsers with solid WebAssembly support (Chrome 57+, Firefox 52+, Safari 14.1+, Edge 79+)
> - **No graceful degradation**: There's no built-in fallback mechanism for browsers lacking WebAssembly features
> - **Older browsers will fail**: If a browser doesn't support WebAssembly or required features, the application simply won't run
> 
> ## Why This Limitation Exists
> 
> 1. **WebAssembly is fundamental** - Compose for Web compiles Kotlin to WebAssembly; there's no alternative execution path
> 2. **Performance requirements** - The framework needs WebAssembly's performance characteristics to be practical
> 3. **Feature dependencies** - Modern Compose features rely on newer WASM capabilities
> 
> ## If You Need Older Browser Support
> 
> Your options are limited:
> 
> - **Use a different framework** - Consider web frameworks designed for broader compatibility (React, Vue, Angular)
> - **Require browser updates** - Document minimum browser requirements for your users
> - **Provide a compatibility check** - Detect WebAssembly support and show a helpful message if unavailable
> - **Use a transpiler/polyfill** - Some experimental tools exist, but they're not officially supported
> 
> **Bottom line**: Compose for Web is a modern framework for modern browsers. It's not designed as a backwards-compatible solution.

| expected fact | grade | note |
| --- | --- | --- |
| A compatibility mode falls back to Kotlin/JS | contradicted | Answer explicitly states there is NO built-in fallback mechanism and no graceful degradation for older browsers. |
| Compose for Web defaults to Kotlin/Wasm for performance | partial | Answer mentions WebAssembly is fundamental and needed for performance, but doesn't explicitly state it defaults to Kotlin/Wasm or discuss Kotlin/JS as an alternative. |
| The fallback targets browsers without Wasm garbage collection or exception handling | contradicted | Answer states there is no fallback mechanism at all, contradicting the premise of a fallback targeting specific browser capabilities. |
| It comes as part of the Compose for Web Beta | missing | Answer does not mention Beta status or any version/release information about Compose for Web. |

Hallucination: The answer claims there is NO fallback mechanism and NO graceful degradation for older browsers, which directly contradicts the expected facts about a compatibility mode that falls back to Kotlin/JS. The answer presents this as definitive fact when the expected facts indicate such a fallback does exist.

### rag — score 1.00

1310 in · 118 out · 1.9 s · rank 1 · cited [1] · pass

> According to the documents, Compose for Web is supposed to run on older browsers that lack newer WebAssembly features through a **fallback to Kotlin/JS** [1].
> 
> Here's how it works: Compose for Web defaults to Kotlin/Wasm for performance, but as part of the Compose for Web Beta, a compatibility mode using Kotlin/JS is being introduced as a fallback. This fallback allows apps to run on older browsers that don't support modern Wasm features like garbage collection or exception handling [1].

| expected fact | grade | note |
| --- | --- | --- |
| A compatibility mode falls back to Kotlin/JS | present | Explicitly stated: 'a compatibility mode using Kotlin/JS is being introduced as a fallback' |
| Compose for Web defaults to Kotlin/Wasm for performance | present | Explicitly stated: 'Compose for Web defaults to Kotlin/Wasm for performance' |
| The fallback targets browsers without Wasm garbage collection or exception handling | present | Explicitly stated: 'older browsers that don't support modern Wasm features like garbage collection or exception handling' |
| It comes as part of the Compose for Web Beta | present | Explicitly stated: 'as part of the Compose for Web Beta, a compatibility mode using Kotlin/JS is being introduced' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.645 | — | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/JS › Fallback to Kotlin/JS for Compose for Web | Kotlin/JS Fallback to Kotlin/JS for Compose for Web As part of the Compose for Web Beta, we will be introducing a compatibility mode using Kotlin/JS as a fall… |
| 2 | 0.518 | — | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile | Compose Multiplatform beyond mobile Compose Multiplatform for the web is also evolving rapidly. With 1.8.0, the Navigation library now supports browser back an… |
| 3 ✓ | 0.454 | — | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Release Compose Multiplatform for Web in Beta | Compose Multiplatform Release Compose Multiplatform for Web in Beta This Beta version embodies our commitment to support and evolve the existing APIs of Compo… |
| 4 | 0.445 | — | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | Automatic font fallback for web | Automatic font fallback for web Compose Multiplatform for web now handles characters that your application’s fonts don’t cover. When it encounters an unresolve… |
| 5 | 0.424 | — | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious | 2. Compose Multiplatform Gets Serious Multiplatform Jetpack Compose was also promising but also buggy. Compose for iOS is stabilized in Kotlin 2.3 with improve… |

### rag+rerank — score 1.00

1005 in · 117 out · 4.0 s · rank 1 · cited [1] · pass

> According to the documents, Compose for Web will run on older browsers that lack newer WebAssembly features through a **fallback to Kotlin/JS** [1].
> 
> Specifically, as part of the Compose for Web Beta, JetBrains is introducing a compatibility mode using Kotlin/JS as a fallback. While Compose for Web defaults to Kotlin/Wasm for performance, this fallback allows apps to run on older browsers that don't support modern Wasm features like garbage collection or exception handling [1].

| expected fact | grade | note |
| --- | --- | --- |
| A compatibility mode falls back to Kotlin/JS | present | Explicitly stated: 'compatibility mode using Kotlin/JS as a fallback' |
| Compose for Web defaults to Kotlin/Wasm for performance | present | Explicitly stated: 'Compose for Web defaults to Kotlin/Wasm for performance' |
| The fallback targets browsers without Wasm garbage collection or exception handling | present | Explicitly stated: 'older browsers that don't support modern Wasm features like garbage collection or exception handling' |
| It comes as part of the Compose for Web Beta | present | Explicitly stated: 'as part of the Compose for Web Beta' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.645 | 0.949 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/JS › Fallback to Kotlin/JS for Compose for Web | Kotlin/JS Fallback to Kotlin/JS for Compose for Web As part of the Compose for Web Beta, we will be introducing a compatibility mode using Kotlin/JS as a fall… |
| 2 | 0.518 | 0.047 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile | Compose Multiplatform beyond mobile Compose Multiplatform for the web is also evolving rapidly. With 1.8.0, the Navigation library now supports browser back an… |
| 3 ✓ | 0.417 | 0.020 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Key priorities | Key priorities Kotlin Multiplatform spans many areas, from language features and target-specific compilation to our IDE plugin. It’s a lot to track, so here ar… |

<details><summary>Dropped candidates (17)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 4 | 0.445 | 0.012 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | Automatic font fallback for web |
| 5 | 0.424 | 0.011 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious |
| 3 ✓ | 0.454 | 0.009 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Release Compose Multiplatform for Web in Beta |
| 14 | 0.387 | 0.004 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Everything you need to build apps for real-world use |
| 10 | 0.391 | 0.003 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Performance that’s ready for production |
| 18 | 0.381 | 0.003 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native |
| 12 | 0.389 | 0.003 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload |
| 6 ✓ | 0.423 | 0.002 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › General and quality improvements |
| 8 | 0.409 | 0.002 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog |  |
| 19 | 0.378 | 0.002 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  |
| 9 | 0.396 | 0.001 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  |
| 13 | 0.389 | 0.001 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency |
| 17 | 0.383 | 0.001 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt |
| 20 ✓ | 0.375 | 0.001 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › Support for Windows and Linux in the Kotlin Multiplatform IDE plugin |
| 15 ✓ | 0.386 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Make more ecosystem components available for Compose Multiplatform |
| 11 | 0.390 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Navigation 3 |
| 16 | 0.385 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Common @Preview annotation |

</details>

### rag+rewrite+rerank — score 1.00

1941 in · 175 out · 5.3 s · rank 1 · cited [1] · pass

Queries searched: `Compose for Web older browsers WebAssembly compatibility` · `Compose Web browser support legacy WebAssembly features`

> According to the documents, Compose for Web will run on older browsers that lack newer WebAssembly features through a **fallback to Kotlin/JS** [1].
> 
> Specifically, as part of the Compose for Web Beta, JetBrains is introducing a compatibility mode using Kotlin/JS as a fallback. While Compose for Web defaults to Kotlin/Wasm for performance, this fallback allows apps to run on older browsers that don't support modern Wasm features like garbage collection or exception handling [1].

| expected fact | grade | note |
| --- | --- | --- |
| A compatibility mode falls back to Kotlin/JS | present | Explicitly stated: 'compatibility mode using Kotlin/JS as a fallback' |
| Compose for Web defaults to Kotlin/Wasm for performance | present | Explicitly stated: 'Compose for Web defaults to Kotlin/Wasm for performance' |
| The fallback targets browsers without Wasm garbage collection or exception handling | present | Explicitly stated: 'older browsers that don't support modern Wasm features like garbage collection or exception handling' |
| It comes as part of the Compose for Web Beta | present | Explicitly stated: 'as part of the Compose for Web Beta' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.662 | 0.949 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/JS › Fallback to Kotlin/JS for Compose for Web | Kotlin/JS Fallback to Kotlin/JS for Compose for Web As part of the Compose for Web Beta, we will be introducing a compatibility mode using Kotlin/JS as a fall… |
| 2 | 0.518 | 0.047 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile | Compose Multiplatform beyond mobile Compose Multiplatform for the web is also evolving rapidly. With 1.8.0, the Navigation library now supports browser back an… |
| 3 ✓ | 0.414 | 0.020 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Key priorities | Key priorities Kotlin Multiplatform spans many areas, from language features and target-specific compilation to our IDE plugin. It’s a lot to track, so here ar… |

<details><summary>Dropped candidates (20)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 4 | 0.455 | 0.012 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | Automatic font fallback for web |
| 8 | 0.418 | 0.011 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious |
| 3 ✓ | 0.474 | 0.009 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Release Compose Multiplatform for Web in Beta |
| 14 | 0.409 | 0.004 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Everything you need to build apps for real-world use |
| 22 | 0.391 | 0.003 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Performance that’s ready for production |
| 16 | 0.404 | 0.003 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native |
| 21 | 0.394 | 0.003 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload |
| 7 ✓ | 0.423 | 0.002 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › General and quality improvements |
| 6 | 0.426 | 0.002 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog |  |
| 15 | 0.406 | 0.002 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  |
| 10 | 0.417 | 0.001 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  |
| 17 | 0.404 | 0.001 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency |
| 19 | 0.398 | 0.001 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt |
| 20 | 0.398 | 0.001 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Type-safe navigation |
| 5 | 0.445 | 0.001 | Exploring Kotlin 2.1.0_ New Features _ by youssef moti _ Medium | 7. Kotlin/Wasm Updates |
| 23 | 0.390 | 0.000 | first-agent/src/server.js | VENDOR |
| 18 ✓ | 0.403 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Make more ecosystem components available for Compose Multiplatform |
| 11 | 0.415 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Navigation 3 |
| 9 ✓ | 0.417 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/Wasm › Support for multi-module compilation |
| 13 ✓ | 0.411 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/Wasm › Beta release of the Kotlin/Wasm target |

</details>

## q08

**general** — What is Kotlin Multiplatform, and which parts of an app is it usually worth sharing across platforms?

*Why:* General knowledge a strong model answers well; one article (the Kotlin 2.3 multiplatform post, saved under a 2.4.20 file name) also has a 'share this / keep platform-specific' list. RAG should at least not hurt.

Expected sources: `Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium`

### plain — score 1.00

65 in · 410 out · 5.1 s · pass

> # Kotlin Multiplatform
> 
> **Kotlin Multiplatform** (KMP) is a framework that lets you write code once in Kotlin and share it across multiple platforms (Android, iOS, web, desktop, etc.). You compile the same code to different targets while still accessing platform-specific APIs when needed.
> 
> ## How It Works
> 
> - **Common code**: Business logic, data models, and algorithms written once
> - **Platform-specific code**: Native UI, device features, and platform APIs handled separately
> - **Expect/Actual**: A mechanism to define interfaces in common code and provide platform-specific implementations
> 
> ## Worth Sharing Across Platforms
> 
> ### ✅ **Highly Recommended**
> - **Business logic** – Calculations, algorithms, validation rules
> - **Data models** – Classes representing your app's core entities
> - **Networking** – API calls and data serialization (using Ktor, etc.)
> - **Database logic** – Data persistence layer (using SQLDelight, Realm, etc.)
> - **State management** – Redux-like patterns, ViewModels
> - **Utilities** – String formatting, date handling, encryption
> 
> ### ⚠️ **Conditional**
> - **UI logic** – Can share some (navigation, state), but UI frameworks differ significantly
> - **Platform-specific features** – Requires expect/actual wrappers (camera, location, notifications)
> 
> ### ❌ **Not Worth Sharing**
> - **UI/Presentation** – Use native frameworks (SwiftUI for iOS, Compose for Android)
> - **Platform-specific APIs** – Better handled natively
> 
> ## The Sweet Spot
> 
> KMP works best when you share **30-70% of your code** (typically the non-UI layers). This avoids the complexity of trying to share everything while maximizing code reuse where it matters most.

| expected fact | grade | note |
| --- | --- | --- |
| It shares Kotlin code across platforms such as Android, iOS and the backend | present | Answer explicitly states KMP lets you 'write code once in Kotlin and share it across multiple platforms (Android, iOS, web, desktop, etc.)' |
| Business logic and validation are good candidates to share | present | Answer lists 'Business logic – Calculations, algorithms, validation rules' under 'Highly Recommended' to share |
| Networking / API clients are commonly shared | present | Answer explicitly states 'Networking – API calls and data serialization (using Ktor, etc.)' as highly recommended to share |
| Platform APIs such as camera or notifications usually stay platform-specific | present | Answer states 'Platform-specific features – Requires expect/actual wrappers (camera, location, notifications)' and lists 'Platform-specific APIs – Better handled natively' under 'Not Worth Sharing' |

### rag — score 1.00

1128 in · 262 out · 2.9 s · rank 1 · cited [5][2][1][4] · pass

> # Kotlin Multiplatform (KMP)
> 
> Based on the documents, Kotlin Multiplatform is an approach to code sharing across iOS, Android, and backend platforms using Kotlin. [5]
> 
> ## What's Worth Sharing Across Platforms
> 
> According to the practical guidance in the documents, you should share: [2]
> 
> - **Business logic and validation**
> - **API client implementations** (GraphQL clients, Ktor)
> - **Data models and serialization**
> - **Authentication flows**
> - **Analytics and logging**
> 
> ## What Should Stay Platform-Specific
> 
> Keep these as native implementations: [1]
> 
> - **UI components** (though Compose Multiplatform can be used for common UI when needed)
> - **Platform APIs** (camera, notifications, HealthKit)
> - **Deep navigation patterns**
> - **Performance-critical animations**
> 
> ## The Key Philosophy
> 
> The documents emphasize that Kotlin 2.3 enables a pragmatic approach: "sharing what is really valuable and being native when it matters." [4] Rather than trying to share everything, the recommendation is to start gradually by exposing business logic first, then UI only when needed. [4]

| expected fact | grade | note |
| --- | --- | --- |
| It shares Kotlin code across platforms such as Android, iOS and the backend | present | Answer states 'code sharing across iOS, Android, and backend platforms using Kotlin' |
| Business logic and validation are good candidates to share | present | Answer explicitly lists 'Business logic and validation' under what's worth sharing |
| Networking / API clients are commonly shared | present | Answer mentions 'API client implementations (GraphQL clients, Ktor)' as shared components |
| Platform APIs such as camera or notifications usually stay platform-specific | present | Answer explicitly states 'Platform APIs (camera, notifications, HealthKit)' should stay native |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.678 | — | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What You Should Actually Share › Keep Platform-Specific: | Keep Platform-Specific: - UI components (if necessary use Compose Multiplatform for common UI) - Platform APIs (camera, notifications, HealthKit) - Deep navi… |
| 2 ✓ | 0.675 | — | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What You Should Actually Share › Share This: | What You Should Actually Share Not everything should go in shared code. Here’s the practical breakdown: Share This: - Business logic and validation - API cl… |
| 3 ✓ | 0.651 | — | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Getting Started Without the Hype | Getting Started Without the Hype Don’t rewrite your entire app. Start small: - Move Business Logic of a Feature Into a Shared Module - Expose your network la… |
| 4 ✓ | 0.626 | — | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways | Key Takeaways - Real KMP pain points solved for Kotlin 2.3 — better iOS interop, stable Compose, better tooling - Compose Multiplatform If you need to share c… |
| 5 ✓ | 0.610 | — | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium |  | Kotlin 2.3 Is Making Multiplatform Development Actually Work AndroidLab by Andre3 min readFeb 2, 2026 How the latest Kotlin release is finally delivering on t… |

### rag+rerank — score 0.50

1511 in · 325 out · 5.7 s · rank 1 → 3 · cited [1][2][3] · generation miss

> # Kotlin Multiplatform Overview
> 
> **What is Kotlin Multiplatform:**
> 
> Kotlin Multiplatform (KMP) is a feature that allows developers to share code across different platforms, including Android, iOS, the web, and WebAssembly. [1] It enables "flexible code sharing across both business logic and UI without compromising app quality or losing control over platform-specific capabilities." [2]
> 
> **What's Worth Sharing Across Platforms:**
> 
> According to the documents, the most practical approach is to share code strategically:
> 
> 1. **Business Logic** - This is the primary focus for code sharing. [3] The documents emphasize starting with business logic first, as it's the most straightforward to share across platforms. [3]
> 
> 2. **UI (User Interface)** - With the recent release of Compose Multiplatform 1.8.0, sharing UI code has become viable. However, the guidance is to "share corner of your UI across platforms" when it's production-ready, rather than attempting to share all UI code. [3]
> 
> 3. **Backend Integration** - Kotlin 2.3 enables "true full stack code sharing with Ktor and shared validation." [3]
> 
> The key philosophy is to "start gradually — expose business logic first, UI when it's needed," [3] rather than trying to share everything at once. This approach allows developers to be native when it matters while still benefiting from code reuse where it makes sense.

| expected fact | grade | note |
| --- | --- | --- |
| It shares Kotlin code across platforms such as Android, iOS and the backend | present | Answer states KMP allows sharing code across Android, iOS, web, and WebAssembly, and mentions backend integration with Ktor. |
| Business logic and validation are good candidates to share | present | Answer explicitly mentions business logic as primary focus and shared validation with Ktor. |
| Networking / API clients are commonly shared | missing | Answer does not mention networking or API clients as commonly shared components. |
| Platform APIs such as camera or notifications usually stay platform-specific | missing | Answer does not address platform-specific APIs like camera or notifications. |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.584 | 0.962 | Kotlin 2.0.0_ A New Era in Kotlin Development _ by Halil Özel _ Medium | 3. Expanded Multiplatform Support 🎗️ | 3. Expanded Multiplatform Support 🎗️ Kotlin’s multiplatform capabilities have been one of its standout features, allowing developers to share code across diff… |
| 2 | 0.527 | 0.896 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  | Multiplatform Compose Multiplatform 1.8.0 Released: Compose Multiplatform for iOS Is Stable and Production-Ready Today marks a major milestone in the Kotlin M… |
| 3 ✓ | 0.626 | 0.888 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways | Key Takeaways - Real KMP pain points solved for Kotlin 2.3 — better iOS interop, stable Compose, better tooling - Compose Multiplatform If you need to share c… |
| 4 | 0.563 | 0.795 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Key priorities | Key priorities Kotlin Multiplatform spans many areas, from language features and target-specific compilation to our IDE plugin. It’s a lot to track, so here ar… |
| 5 ✓ | 0.610 | 0.701 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium |  | Kotlin 2.3 Is Making Multiplatform Development Actually Work AndroidLab by Andre3 min readFeb 2, 2026 How the latest Kotlin release is finally delivering on t… |

<details><summary>Dropped candidates (15)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 12 | 0.553 | 0.669 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | The Ship Kotlin Everywhere Award |
| 18 | 0.529 | 0.403 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › Support for Windows and Linux in the Kotlin Multiplatform IDE plugin |
| 15 | 0.534 | 0.301 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Why Should You Care About This in Your Codebase |
| 6 ✓ | 0.605 | 0.290 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | The Real-World Impact |
| 13 | 0.547 | 0.267 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Multiplatform Development Enhancements |
| 3 ✓ | 0.651 | 0.125 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Getting Started Without the Hype |
| 16 | 0.531 | 0.088 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog |  |
| 9 ✓ | 0.568 | 0.058 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 1. Sensible Native Interop That Plays Nice With You |
| 11 ✓ | 0.556 | 0.048 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious |
| 8 ✓ | 0.578 | 0.030 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 3. Backend Integration That Makes Sense |
| 20 | 0.515 | 0.017 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Documentation and onboarding |
| 14 | 0.535 | 0.005 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Build tooling › Reducing the effort to publish KMP libraries |
| 17 | 0.530 | 0.003 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | Should You Upgrade Now? |
| 1 ✓ | 0.678 | 0.002 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What You Should Actually Share › Keep Platform-Specific: |
| 2 ✓ | 0.675 | 0.001 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What You Should Actually Share › Share This: |

</details>

### rag+rewrite+rerank — score 0.63

2449 in · 381 out · 7.5 s · rank 2 → 3 · cited [1][2][3] · generation miss

Queries searched: `Kotlin Multiplatform what is` · `Kotlin Multiplatform shared code business logic data layer`

> # Kotlin Multiplatform Overview
> 
> **What is Kotlin Multiplatform:**
> 
> Kotlin Multiplatform (KMP) is a feature that allows developers to share code across different platforms, including Android, iOS, the web, and WebAssembly. [1] It enables "flexible code sharing across both business logic and UI without compromising app quality or losing control over platform-specific capabilities." [2]
> 
> **What's Worth Sharing Across Platforms:**
> 
> According to the documents, the most practical approach is to share code strategically:
> 
> 1. **Business Logic** - This is the primary focus for code sharing. [3] The documents emphasize starting with business logic first, as it's the most straightforward to share across platforms. [3]
> 
> 2. **UI (User Interface)** - With the recent release of Compose Multiplatform 1.8.0, sharing UI code has become viable. However, the guidance is to "share corner of your UI across platforms" when it's production-ready, rather than attempting to share all UI code. [3]
> 
> 3. **Backend Integration** - Kotlin 2.3 enables "true full stack code sharing with Ktor and shared validation." [3]
> 
> The key philosophy is to "start gradually — expose business logic first, UI when it's needed," [3] rather than trying to share everything at once. This approach allows developers to be "native when it matters" while still achieving meaningful code reuse. [3]

| expected fact | grade | note |
| --- | --- | --- |
| It shares Kotlin code across platforms such as Android, iOS and the backend | present | Answer states KMP allows sharing code across Android, iOS, web, and WebAssembly, and mentions backend integration with Ktor. |
| Business logic and validation are good candidates to share | present | Answer explicitly mentions business logic as primary focus and validation in context of Kotlin 2.3 enabling 'shared validation'. |
| Networking / API clients are commonly shared | missing | The answer does not mention networking or API clients as candidates for sharing. |
| Platform APIs such as camera or notifications usually stay platform-specific | partial | Answer mentions 'losing control over platform-specific capabilities' and being 'native when it matters' but does not explicitly give examples like camera or notifications. |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.632 | 0.962 | Kotlin 2.0.0_ A New Era in Kotlin Development _ by Halil Özel _ Medium | 3. Expanded Multiplatform Support 🎗️ | 3. Expanded Multiplatform Support 🎗️ Kotlin’s multiplatform capabilities have been one of its standout features, allowing developers to share code across diff… |
| 2 | 0.585 | 0.896 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  | Multiplatform Compose Multiplatform 1.8.0 Released: Compose Multiplatform for iOS Is Stable and Production-Ready Today marks a major milestone in the Kotlin M… |
| 3 ✓ | 0.614 | 0.888 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways | Key Takeaways - Real KMP pain points solved for Kotlin 2.3 — better iOS interop, stable Compose, better tooling - Compose Multiplatform If you need to share c… |
| 4 | 0.592 | 0.795 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Key priorities | Key priorities Kotlin Multiplatform spans many areas, from language features and target-specific compilation to our IDE plugin. It’s a lot to track, so here ar… |
| 5 ✓ | 0.626 | 0.701 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium |  | Kotlin 2.3 Is Making Multiplatform Development Actually Work AndroidLab by Andre3 min readFeb 2, 2026 How the latest Kotlin release is finally delivering on t… |

<details><summary>Dropped candidates (20)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 20 | 0.545 | 0.669 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | The Ship Kotlin Everywhere Award |
| 19 | 0.547 | 0.542 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  |
| 8 | 0.599 | 0.403 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › Support for Windows and Linux in the Kotlin Multiplatform IDE plugin |
| 23 | 0.491 | 0.301 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Why Should You Care About This in Your Codebase |
| 7 ✓ | 0.601 | 0.290 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | The Real-World Impact |
| 10 | 0.594 | 0.267 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Multiplatform Development Enhancements |
| 6 ✓ | 0.608 | 0.125 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Getting Started Without the Hype |
| 13 | 0.586 | 0.088 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog |  |
| 18 | 0.553 | 0.075 | Exploring Kotlin 2.1.0_ New Features _ by youssef moti _ Medium | 5. Kotlin Multiplatform Enhancements |
| 12 ✓ | 0.589 | 0.058 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 1. Sensible Native Interop That Plays Nice With You |
| 16 ✓ | 0.554 | 0.048 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious |
| 9 ✓ | 0.596 | 0.030 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 3. Backend Integration That Makes Sense |
| 22 | 0.494 | 0.007 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | The One Feature That Really Matters: Context Parameters Going Stabile |
| 17 | 0.553 | 0.005 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Build tooling › Reducing the effort to publish KMP libraries |
| 15 | 0.559 | 0.003 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/Wasm › Support for multi-module compilation |
| 5 ✓ | 0.613 | 0.002 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What You Should Actually Share › Keep Platform-Specific: |
| 21 | 0.528 | 0.002 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Build tooling › Providing a Build tools API |
| 24 | 0.488 | 0.001 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🎯 Context Parameters: Say Goodbye to Dependency Hell › The New Way (Welcome to Paradise) |
| 3 ✓ | 0.617 | 0.001 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What You Should Actually Share › Share This: |
| 25 | 0.484 | 0.000 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | 1. Context Parameters Are Stable |

</details>

## q09

**general** — How are Kotlin coroutines different from threads, and what does the suspend keyword actually do?

*Why:* Textbook Kotlin that no article in the corpus explains. Plain mode should score well; strict RAG rules may make RAG decline, which would be RAG hurting a general question. Record which happens.

Expected sources: none

### plain — score 0.67

62 in · 621 out · 6.8 s · fail

> # Kotlin Coroutines vs Threads
> 
> ## Key Differences
> 
> | Aspect | Threads | Coroutines |
> |--------|---------|-----------|
> | **Creation cost** | Expensive (OS-level resource) | Cheap (lightweight) |
> | **Memory** | ~1-2 MB per thread | Kilobytes per coroutine |
> | **Switching** | Preemptive (OS decides) | Cooperative (code decides) |
> | **Quantity** | Hundreds practical limit | Thousands/millions possible |
> | **Blocking** | Blocks entire thread | Suspends without blocking thread |
> 
> ## What `suspend` Actually Does
> 
> The `suspend` keyword marks a function as **suspendable**—it can pause execution and resume later *without blocking the underlying thread*.
> 
> ### How it works:
> 
> ```kotlin
> // Regular function - blocks the thread
> fun regularFunction() {
>     Thread.sleep(1000)  // Thread is stuck here
>     println("Done")
> }
> 
> // Suspendable function - pauses without blocking
> suspend fun suspendFunction() {
>     delay(1000)  // Coroutine pauses, thread is FREE
>     println("Done")
> }
> ```
> 
> When `delay(1000)` is called:
> - The coroutine **suspends** (pauses)
> - The thread **continues** running other coroutines
> - After 1000ms, the coroutine **resumes** where it left off
> 
> ### Under the hood:
> 
> The Kotlin compiler transforms `suspend` functions into state machines. Simplified:
> 
> ```kotlin
> // What you write:
> suspend fun fetchData(): String {
>     val result = api.call()  // suspends here
>     return result
> }
> 
> // Roughly what happens:
> fun fetchData(continuation: Continuation<String>) {
>     when (continuation.label) {
>         0 -> {
>             continuation.label = 1
>             api.call(continuation)  // suspends
>         }
>         1 -> {
>             val result = continuation.result
>             continuation.resume(result)
>         }
>     }
> }
> ```
> 
> ## Practical Example
> 
> ```kotlin
> // Launch 10,000 coroutines (impossible with threads)
> repeat(10_000) {
>     launch {
>         delay(1000)  // Suspends, doesn't block
>         println("Coroutine $it done")
>     }
> }
> // All complete in ~1 second using maybe 1-2 threads
> ```
> 
> ## Key Takeaway
> 
> **`suspend` = "pause this coroutine, free up the thread for other work"**
> 
> This enables massive concurrency with minimal resources—the core power of coroutines.

| expected fact | grade | note |
| --- | --- | --- |
| Coroutines are lightweight: many of them can run on a few threads | present | Clearly stated in the table (cheap, kilobytes per coroutine) and the practical example showing 10,000 coroutines on 1-2 threads. |
| A suspend function can pause without blocking the thread it runs on | present | Explicitly stated multiple times: 'pause execution and resume later without blocking the underlying thread', the delay() example showing the thread continues running other coroutines, and the key takeaway. |
| A suspend function can only be called from a coroutine or another suspend function | missing | This important restriction is not mentioned anywhere in the answer. The answer explains what suspend does but not the constraint on where it can be called from. |

### rag — score 0.00, declined

1453 in · 136 out · 2.2 s · rank — · cited [1][3] · wrong decline (model)

> The provided documents do not contain information about how Kotlin coroutines differ from threads or a detailed explanation of what the suspend keyword does.
> 
> The documents mention suspend functions in a few contexts—such as overload resolution improvements in Kotlin 2.2.20 [1] and a note that suspend function behavior changed slightly in Kotlin 2.4.20 [3]—but they don't explain the fundamental differences between coroutines and threads or the mechanics of the suspend keyword itself.
> 
> To get a complete answer to your question, you would need additional resources that cover coroutine fundamentals and the suspend mechanism in detail.

| expected fact | grade | note |
| --- | --- | --- |
| Coroutines are lightweight: many of them can run on a few threads | missing |  |
| A suspend function can pause without blocking the thread it runs on | missing |  |
| A suspend function can only be called from a coroutine or another suspend function | missing |  |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.504 | — | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 1. Smarter overload resolution with suspend function | 1. Smarter overload resolution with suspend function If you’ve ever had both a suspend and non suspend overload of the same function, you know how confusing it… |
| 2 | 0.421 | — | Kotlin 1.9.20 _ Medium | 2. Concurrent Programming Enhancements: › Task API: | 2. Concurrent Programming Enhancements: Task API: Kotlin 1.9.20 brings improvements to concurrent programming through the introduction of the Task API. This A… |
| 3 | 0.420 | — | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Should You Upgrade Right Now? | Should You Upgrade Right Now? - First things first: check for Gradle compatibility and update Android Studio — 2.4 requires Gradle 9.5.0+ - Rewriting all your… |
| 4 | 0.410 | — | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Main Features | Main Features Kotlin 2.0.20 boasts concurrent marking for the garbage collector, which allows the marking phase to run simultaneously with application threads.… |
| 5 | 0.407 | — | Exploring Kotlin 2.1.0_ New Features _ by youssef moti _ Medium | 2. Non-Local break and continue | 2. Non-Local break and continue Before Kotlin 2.1.0: Developers used labels to handle complex loops in lambdas, leading to verbose and less readable code. fun… |

### rag+rerank — score 0.00, declined

691 in · 99 out · 5.0 s · rank — · cited nothing · wrong decline (model)

> The provided documents do not contain information about how Kotlin coroutines differ from threads or what the suspend keyword actually does at a fundamental level.
> 
> The documents mention suspend functions in the context of overload resolution and compatibility notes, but they don't explain the underlying concepts or mechanisms of coroutines versus threads.
> 
> To get a complete answer to your question, you would need additional resources that cover coroutine architecture and the suspend keyword's role in the Kotlin runtime.

| expected fact | grade | note |
| --- | --- | --- |
| Coroutines are lightweight: many of them can run on a few threads | missing | Answer declines to provide information |
| A suspend function can pause without blocking the thread it runs on | missing | Answer declines to provide information |
| A suspend function can only be called from a coroutine or another suspend function | missing | Answer declines to provide information |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.420 | 0.189 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Should You Upgrade Right Now? | Should You Upgrade Right Now? - First things first: check for Gradle compatibility and update Android Studio — 2.4 requires Gradle 9.5.0+ - Rewriting all your… |
| 2 | 0.504 | 0.029 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 1. Smarter overload resolution with suspend function | 1. Smarter overload resolution with suspend function If you’ve ever had both a suspend and non suspend overload of the same function, you know how confusing it… |

<details><summary>Dropped candidates (18)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 4 | 0.410 | 0.016 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Main Features |
| 12 | 0.376 | 0.011 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Enhanced Performance and Bug Fixes |
| 13 | 0.373 | 0.003 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/JS › Extending the capabilities of JavaScript Export |
| 11 | 0.380 | 0.002 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🏗️ Nested Type Aliases: Organization That Makes Sense |
| 6 | 0.404 | 0.002 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🎯 Context Parameters: Say Goodbye to Dependency Hell › The Old Way (We Don’t Miss This) |
| 14 | 0.369 | 0.002 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium |  |
| 7 | 0.395 | 0.001 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Quick Hits Worth Knowing |
| 19 | 0.363 | 0.001 | Exploring Kotlin 2.1.0_ New Features _ by youssef moti _ Medium | 1. Guard Conditions in “when” Expressions |
| 10 | 0.386 | 0.001 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/Native › Continued development of Swift Export |
| 20 | 0.356 | 0.001 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Why Should You Care About This in Your Codebase |
| 15 | 0.368 | 0.001 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🎯 Context Parameters: Say Goodbye to Dependency Hell › The New Way (Welcome to Paradise) |
| 8 | 0.393 | 0.001 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | The One Feature That Really Matters: Context Parameters Going Stabile |
| 5 | 0.407 | 0.001 | Exploring Kotlin 2.1.0_ New Features _ by youssef moti _ Medium | 2. Non-Local break and continue |
| 2 | 0.421 | 0.001 | Kotlin 1.9.20 _ Medium | 2. Concurrent Programming Enhancements: › Task API: |
| 18 | 0.363 | 0.000 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Why This Matters |
| 9 | 0.389 | 0.000 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | Key Takeaways |
| 17 | 0.365 | 0.000 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🎭 Context-Sensitive Resolution: Code That Reads Like English › After: Clean and Intuitive |
| 16 | 0.366 | 0.000 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | 1. Context Parameters Are Stable |

</details>

### rag+rewrite+rerank — score 0.00, declined

1887 in · 194 out · 7.8 s · rank — · cited [1][2][3] · wrong decline (model)

Queries searched: `Kotlin coroutines vs threads differences` · `suspend keyword Kotlin coroutines`

> The provided documents do not contain information about how Kotlin coroutines differ from threads or what the suspend keyword actually does at a fundamental level.
> 
> The documents mention suspend functions in a few contexts—such as testing suspend function behavior in Kotlin 2.4 [1], using suspend functions with iOS interop [2], and improved overload resolution between suspend and non-suspend functions [3]—but they don't explain the underlying mechanics of coroutines versus threads or the purpose of the suspend keyword itself.
> 
> To get a proper answer to your question, you would need documentation that covers coroutine fundamentals and the suspend keyword's role in the coroutine system.

| expected fact | grade | note |
| --- | --- | --- |
| Coroutines are lightweight: many of them can run on a few threads | missing |  |
| A suspend function can pause without blocking the thread it runs on | missing |  |
| A suspend function can only be called from a coroutine or another suspend function | missing |  |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.421 | 0.189 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Should You Upgrade Right Now? | Should You Upgrade Right Now? - First things first: check for Gradle compatibility and update Android Studio — 2.4 requires Gradle 9.5.0+ - Rewriting all your… |
| 2 | 0.397 | 0.029 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 1. Sensible Native Interop That Plays Nice With You | What Actually Changed Let’s skip the marketing fluff. This is how all the Kotlin 2.3 multiplatform updates that matter: 1. Sensible Native Interop That Plays … |
| 3 | 0.529 | 0.029 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 1. Smarter overload resolution with suspend function | 1. Smarter overload resolution with suspend function If you’ve ever had both a suspend and non suspend overload of the same function, you know how confusing it… |

<details><summary>Dropped candidates (28)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 3 | 0.448 | 0.016 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Main Features |
| 5 | 0.436 | 0.011 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Enhanced Performance and Bug Fixes |
| 30 | 0.375 | 0.003 | Kotlin 2.0.0_ A New Era in Kotlin Development _ by Halil Özel _ Medium | 1. Enhanced Language Features 🔥 |
| 22 | 0.395 | 0.003 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/JS › Extending the capabilities of JavaScript Export |
| 24 | 0.391 | 0.002 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🏗️ Nested Type Aliases: Organization That Makes Sense |
| 10 | 0.414 | 0.002 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🎯 Context Parameters: Say Goodbye to Dependency Hell › The Old Way (We Don’t Miss This) |
| 16 | 0.401 | 0.002 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium |  |
| 28 | 0.386 | 0.002 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium |  |
| 7 | 0.435 | 0.001 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Quick Hits Worth Knowing |
| 23 | 0.395 | 0.001 | Exploring Kotlin 2.1.0_ New Features _ by youssef moti _ Medium | 1. Guard Conditions in “when” Expressions |
| 27 | 0.387 | 0.001 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 3. Smarter Exhaustiveness Checks in when |
| 12 | 0.409 | 0.001 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/Native › Continued development of Swift Export |
| 9 | 0.417 | 0.001 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Why Should You Care About This in Your Codebase |
| 6 | 0.436 | 0.001 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | The One Feature That Really Matters: Context Parameters Going Stabile |
| 11 | 0.413 | 0.001 | Exploring Kotlin 2.1.0_ New Features _ by youssef moti _ Medium | 2. Non-Local break and continue |
| 31 | 0.371 | 0.001 | Kotlin 1.9.20 _ Medium | 5. Enhanced Null Safety: › Safe Navigation Operator and let: |
| 2 | 0.488 | 0.001 | Kotlin 1.9.20 _ Medium | 2. Concurrent Programming Enhancements: › Task API: |
| 21 | 0.397 | 0.001 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Quick Context: 2.3 is where we left off |
| 13 | 0.408 | 0.001 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 🚀 Final Thoughts |
| 26 | 0.390 | 0.000 | Kotlin 1.9.20 _ Medium | 3. Extension Functions with Receiver Types: › DSLs and Receiver Types: |
| 15 | 0.402 | 0.000 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 2. return in Expression Body Functions |
| 17 | 0.401 | 0.000 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways |
| 14 | 0.407 | 0.000 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🔮 What This Means for Your Daily Development |
| 19 | 0.398 | 0.000 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | What Kotlin 2.4 Actually Delivers › Platform support: |
| 18 | 0.398 | 0.000 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | The Real-World Impact |
| 4 | 0.436 | 0.000 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | Key Takeaways |
| 29 | 0.377 | 0.000 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🎭 Context-Sensitive Resolution: Code That Reads Like English › After: Clean and Intuitive |
| 25 | 0.391 | 0.000 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | 1. Context Parameters Are Stable |

</details>

## q10

**unanswerable** (should be declined) — What were the headline features of Compose Multiplatform 1.9.0?

*Why:* The corpus has release posts for 1.7.0, 1.8.0, 1.10.0 and 1.12.0 but not 1.9.0, so retrieval will bring neighbouring releases. RAG should say the documents do not cover it instead of borrowing 1.8 or 1.10 features. Plain mode will probably answer from memory; record that.

Expected sources: none

### plain — score 1.00, declined

61 in · 176 out · 2.0 s · pass

> # Compose Multiplatform 1.9.0 Headline Features
> 
> I don't have specific information about Compose Multiplatform 1.9.0's release notes in my training data. To get accurate details about this release, I'd recommend:
> 
> 1. **Official JetBrains Blog** - Check the Kotlin/Compose announcements
> 2. **GitHub Releases** - Visit the [Compose Multiplatform repository](https://github.com/JetBrains/compose-multiplatform)
> 3. **Release Notes** - Look for the official release notes on the JetBrains website
> 
> If you can share what you're trying to accomplish or have questions about specific Compose Multiplatform features, I'd be happy to help with that instead!

| expected fact | grade | note |
| --- | --- | --- |
| Says the available information does not cover Compose Multiplatform 1.9.0 | present | The answer explicitly states 'I don't have specific information about Compose Multiplatform 1.9.0's release notes in my training data.' |
| Does not present a list of 1.9.0 features as fact | present | The answer declines to provide features and instead directs to official sources without claiming any features as fact. |

### rag — score 1.00, declined

1456 in · 67 out · 1.1 s · rank — · cited nothing · pass

> The provided documents do not contain information about Compose Multiplatform 1.9.0. The documents cover versions 1.7.0, 1.8.0, and 1.10.0, but version 1.9.0 is not mentioned in any of them.

| expected fact | grade | note |
| --- | --- | --- |
| Says the available information does not cover Compose Multiplatform 1.9.0 | present | The answer explicitly states 'The provided documents do not contain information about Compose Multiplatform 1.9.0' |
| Does not present a list of 1.9.0 features as fact | present | The answer declines to provide features and instead explains what versions are covered |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.624 | — | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency | Development tools that boost your efficiency To make building Compose Multiplatform apps faster, smoother, and more enjoyable, we’re actively improving the KMP… |
| 2 | 0.622 | — | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.10.0: Unified @Preview, Navigation 3, and Stable Compose Hot Reload Compose Multiplatform 1.10.0 has been rele… |
| 3 | 0.611 | — | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.7.0 Released Compose Multiplatform is a declarative UI framework built by JetBrains that allows developers to … |
| 4 | 0.602 | — | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload | Compose Hot Reload Compose Hot Reload is designed to speed up UI iteration by letting you instantly see changes without restarting the application: The Compos… |
| 5 | 0.598 | — | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  | Multiplatform Compose Multiplatform 1.8.0 Released: Compose Multiplatform for iOS Is Stable and Production-Ready Today marks a major milestone in the Kotlin M… |

### rag+rerank — score 1.00, declined

1730 in · 75 out · 3.5 s · rank — · cited nothing · pass

> The provided documents do not contain information about Compose Multiplatform 1.9.0. The documents cover version 1.8.0 (which is described as stable and production-ready for iOS) and version 1.7.0, but there is no mention of version 1.9.0 or its features.

| expected fact | grade | note |
| --- | --- | --- |
| Says the available information does not cover Compose Multiplatform 1.9.0 | present | The answer explicitly states 'The provided documents do not contain information about Compose Multiplatform 1.9.0' |
| Does not present a list of 1.9.0 features as fact | present | The answer declines to provide features and instead explains what versions are covered in the documents |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.598 | 0.726 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Everything you need to build apps for real-world use | Everything you need to build apps for real-world use Compose Multiplatform for iOS now includes everything you need to build beautiful UIs for real-world apps:… |
| 2 | 0.579 | 0.500 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native | Apps that feel truly native Smooth, native behavior is what iOS users expect – and notice. Compose Multiplatform for iOS focuses on getting the details right, … |
| 3 | 0.591 | 0.469 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt | Production-ready and easy to adopt Compose Multiplatform for iOS now gives you the full package: stable APIs, great performance, a native feel, and modern tool… |
| 4 | 0.565 | 0.463 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile | Compose Multiplatform beyond mobile Compose Multiplatform for the web is also evolving rapidly. With 1.8.0, the Navigation library now supports browser back an… |
| 5 | 0.611 | 0.307 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.7.0 Released Compose Multiplatform is a declarative UI framework built by JetBrains that allows developers to … |

<details><summary>Dropped candidates (15)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 12 | 0.571 | 0.216 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Resources updates and improvements |
| 2 | 0.622 | 0.200 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  |
| 5 | 0.598 | 0.196 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  |
| 13 | 0.567 | 0.145 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Shared element transitions |
| 1 | 0.624 | 0.145 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency |
| 17 | 0.558 | 0.115 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Type-safe navigation |
| 7 | 0.593 | 0.115 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Improved touch interop between Compose Multiplatform and native iOS |
| 16 | 0.559 | 0.101 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog |  |
| 4 | 0.602 | 0.071 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload |
| 18 | 0.554 | 0.060 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | Automatic font fallback for web |
| 11 | 0.573 | 0.045 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Drag and drop on desktop |
| 9 | 0.584 | 0.028 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | New common modules |
| 19 | 0.553 | 0.010 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Read more |
| 20 | 0.545 | 0.010 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Navigation 3 |
| 15 | 0.562 | 0.002 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Common @Preview annotation |

</details>

### rag+rewrite+rerank — score 1.00, declined

2664 in · 123 out · 4.3 s · rank — · cited nothing · pass

Queries searched: `Compose Multiplatform 1.9.0 features`

> The provided documents do not contain information about Compose Multiplatform 1.9.0. The documents cover version 1.8.0 (which is described as stable and production-ready for iOS) and version 1.7.0, but there is no mention of version 1.9.0 or its features.

| expected fact | grade | note |
| --- | --- | --- |
| Says the available information does not cover Compose Multiplatform 1.9.0 | present | The answer explicitly states 'The provided documents do not contain information about Compose Multiplatform 1.9.0' |
| Does not present a list of 1.9.0 features as fact | present | The answer declines to provide features and instead explains what versions are covered in the documents |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.609 | 0.726 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Everything you need to build apps for real-world use | Everything you need to build apps for real-world use Compose Multiplatform for iOS now includes everything you need to build beautiful UIs for real-world apps:… |
| 2 | 0.595 | 0.500 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native | Apps that feel truly native Smooth, native behavior is what iOS users expect – and notice. Compose Multiplatform for iOS focuses on getting the details right, … |
| 3 | 0.597 | 0.469 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt | Production-ready and easy to adopt Compose Multiplatform for iOS now gives you the full package: stable APIs, great performance, a native feel, and modern tool… |
| 4 | 0.561 | 0.463 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile | Compose Multiplatform beyond mobile Compose Multiplatform for the web is also evolving rapidly. With 1.8.0, the Navigation library now supports browser back an… |
| 5 | 0.622 | 0.307 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.7.0 Released Compose Multiplatform is a declarative UI framework built by JetBrains that allows developers to … |

<details><summary>Dropped candidates (15)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 6 | 0.600 | 0.216 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Resources updates and improvements |
| 2 | 0.616 | 0.200 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  |
| 4 | 0.611 | 0.196 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  |
| 13 | 0.577 | 0.145 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Shared element transitions |
| 3 | 0.611 | 0.145 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency |
| 14 | 0.568 | 0.115 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Type-safe navigation |
| 8 | 0.597 | 0.115 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Improved touch interop between Compose Multiplatform and native iOS |
| 17 | 0.559 | 0.101 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog |  |
| 12 | 0.593 | 0.071 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload |
| 18 | 0.558 | 0.060 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | Automatic font fallback for web |
| 11 | 0.593 | 0.045 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Drag and drop on desktop |
| 7 | 0.599 | 0.028 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | New common modules |
| 20 | 0.546 | 0.010 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Read more |
| 19 | 0.556 | 0.010 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Navigation 3 |
| 15 | 0.567 | 0.002 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Common @Preview annotation |

</details>

## q11

**near_miss** — Is there a talk on how Compose Hot Reload is implemented? What did they have to work around?

*Why:* Near miss: four chunks in three release posts are about Compose Hot Reload, but only one paragraph of the KMP watchlist names the talk. Baseline vector search (doc_index search, structural, k = 20) put it 4th, behind the 1.10.0 Hot Reload section, the 1.12.0 MCP section and the 1.8.0 tooling section.

Expected sources: `The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog`

### plain — score 0.00, declined

64 in · 324 out · 3.7 s · fail

> # Compose Hot Reload Implementation
> 
> I don't have specific information about a particular talk on Compose Hot Reload implementation in my training data. However, I can tell you that **Jetpack Compose hot reload** (which allows you to see UI changes instantly without recompiling) is a real feature, and the Android team has discussed it in various contexts.
> 
> ## General challenges they likely addressed:
> 
> 1. **State preservation** - Keeping app state intact while reloading composables
> 2. **Recomposition tracking** - Identifying which composables changed and need reloading
> 3. **Class reloading** - Managing how the JVM/Android runtime handles updated code
> 4. **Dependency injection** - Ensuring dependencies are properly re-injected after reload
> 5. **Lifecycle management** - Handling lifecycle callbacks during hot reload
> 
> ## Where to find this information:
> 
> - **Google I/O talks** - Search for "Compose" talks from recent years
> - **Android Dev Summit** - Often features Compose deep-dives
> - **Official Compose documentation** - May have technical details
> - **Android Developers YouTube channel** - Likely has relevant sessions
> 
> If you're looking for a specific talk, I'd recommend:
> - Searching YouTube for "Jetpack Compose hot reload"
> - Checking the official Android Developers blog
> - Looking at Compose release notes and documentation
> 
> Do you remember any other details about the talk (year, speaker, or conference)?

| expected fact | grade | note |
| --- | --- | --- |
| The talk is "Implementing Compose Hot Reload" by Sebastian Sellmair (2025) | missing | Answer declines to provide specific information about the talk, saying it doesn't have it in training data |
| It covers fighting ClassLoaders on the JVM | missing | Not mentioned; answer only provides generic challenges |
| It covers patching the Kotlin compiler to handle "shifting lambda names" | missing | Not mentioned; answer only provides generic challenges |

### rag — score 1.00

1514 in · 155 out · 1.8 s · rank 4 · cited [4] · pass

> Yes, there is a talk on how Compose Hot Reload is implemented. [4]
> 
> According to the documents, Sebastian Sellmair gave a talk in 2025 titled "Implementing Compose Hot Reload" that breaks down the engineering work required to implement Hot Reload on the JVM. [4]
> 
> The specific challenges they had to work around include:
> 
> 1. **Fighting ClassLoaders** - dealing with Java's ClassLoader system [4]
> 2. **Patching the Kotlin Compiler** - modifying the compiler to handle "shifting lambda names" [4]
> 
> The talk is described as "a fascinating look under the hood of the tooling we take for granted." [4]

| expected fact | grade | note |
| --- | --- | --- |
| The talk is "Implementing Compose Hot Reload" by Sebastian Sellmair (2025) | present | Answer correctly identifies the talk title, speaker, and year. |
| It covers fighting ClassLoaders on the JVM | present | Answer explicitly mentions "Fighting ClassLoaders - dealing with Java's ClassLoader system" |
| It covers patching the Kotlin compiler to handle "shifting lambda names" | present | Answer states "Patching the Kotlin Compiler - modifying the compiler to handle 'shifting lambda names'" |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.534 | — | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload | Compose Hot Reload Compose Hot Reload is designed to speed up UI iteration by letting you instantly see changes without restarting the application: The Compos… |
| 2 | 0.493 | — | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | MCP server for AI agents in Compose Hot Reload | MCP server for AI agents in Compose Hot Reload Compose Hot Reload now ships with an experimental Model Context Protocol (MCP) server that connects AI coding ag… |
| 3 | 0.473 | — | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency | Development tools that boost your efficiency To make building Compose Multiplatform apps faster, smoother, and more enjoyable, we’re actively improving the KMP… |
| 4 ✓ | 0.473 | — | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ? Part 4: The Deep Dive | ? Part 4: The Deep Dive For those who want to see how the magic trick is performed. Using C & native platforms in Kotlin: Building a multi-platform advanced l… |
| 5 | 0.434 | — | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.10.0: Unified @Preview, Navigation 3, and Stable Compose Hot Reload Compose Multiplatform 1.10.0 has been rele… |

### rag+rerank — score 1.00

1514 in · 143 out · 5.5 s · rank 4 → 1 · cited [1] · pass

> Yes, there is a talk on how Compose Hot Reload is implemented. [1]
> 
> The talk is titled "Implementing Compose Hot Reload" by Sebastian Sellmair (2025). According to the description, implementing Hot Reload on the JVM required deep engineering work, and Sebastian breaks down the journey by working around two main challenges: [1]
> 
> 1. **Fighting ClassLoaders** - dealing with Java's class loading mechanism
> 2. **Patching the Kotlin Compiler** - to handle "shifting lambda names"
> 
> The talk is described as "a fascinating look under the hood of the tooling we take for granted." [1]

| expected fact | grade | note |
| --- | --- | --- |
| The talk is "Implementing Compose Hot Reload" by Sebastian Sellmair (2025) | present | Answer correctly identifies the talk title, speaker, and year. |
| It covers fighting ClassLoaders on the JVM | present | Answer explicitly states 'Fighting ClassLoaders - dealing with Java's class loading mechanism'. |
| It covers patching the Kotlin compiler to handle "shifting lambda names" | present | Answer explicitly states 'Patching the Kotlin Compiler - to handle "shifting lambda names"'. |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.473 | 0.964 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ? Part 4: The Deep Dive | ? Part 4: The Deep Dive For those who want to see how the magic trick is performed. Using C & native platforms in Kotlin: Building a multi-platform advanced l… |
| 2 | 0.534 | 0.857 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload | Compose Hot Reload Compose Hot Reload is designed to speed up UI iteration by letting you instantly see changes without restarting the application: The Compos… |
| 3 | 0.473 | 0.343 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency | Development tools that boost your efficiency To make building Compose Multiplatform apps faster, smoother, and more enjoyable, we’re actively improving the KMP… |
| 4 | 0.493 | 0.214 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | MCP server for AI agents in Compose Hot Reload | MCP server for AI agents in Compose Hot Reload Compose Hot Reload now ships with an experimental Model Context Protocol (MCP) server that connects AI coding ag… |
| 5 | 0.434 | 0.096 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.10.0: Unified @Preview, Navigation 3, and Stable Compose Hot Reload Compose Multiplatform 1.10.0 has been rele… |

<details><summary>Dropped candidates (15)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 7 | 0.412 | 0.032 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog |  |
| 17 ✓ | 0.365 | 0.006 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ? Part 1: Production Case Studies |
| 19 | 0.359 | 0.003 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Performance improvements on iOS |
| 8 | 0.400 | 0.003 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious |
| 9 | 0.396 | 0.002 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Performance that’s ready for production |
| 6 ✓ | 0.419 | 0.002 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ?️ Part 2: Getting Your Hands Dirty |
| 16 | 0.368 | 0.002 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile |
| 10 | 0.389 | 0.002 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native |
| 18 | 0.364 | 0.001 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt |
| 11 | 0.377 | 0.001 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways |
| 14 | 0.370 | 0.001 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Release Compose Multiplatform for Web in Beta |
| 20 | 0.359 | 0.001 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Improved touch interop between Compose Multiplatform and native iOS |
| 12 | 0.373 | 0.000 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  |
| 15 | 0.369 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/JS › Fallback to Kotlin/JS for Compose for Web |
| 13 | 0.371 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Common @Preview annotation |

</details>

### rag+rewrite+rerank — score 1.00

2451 in · 202 out · 7.1 s · rank 3 → 1 · cited [1] · pass

Queries searched: `Compose Hot Reload implementation talk` · `Compose Hot Reload workarounds challenges`

> Yes, there is a talk on how Compose Hot Reload is implemented. [1]
> 
> The talk is titled "Implementing Compose Hot Reload" by Sebastian Sellmair (2025). According to the description, implementing Hot Reload on the JVM required deep engineering work, and Sebastian breaks down the journey by working around two main challenges: [1]
> 
> 1. **Fighting ClassLoaders** - dealing with the complexity of Java's class loading mechanism
> 2. **Patching the Kotlin Compiler** - modifying the compiler to handle "shifting lambda names"
> 
> The talk is described as "a fascinating look under the hood of the tooling we take for granted." [1]

| expected fact | grade | note |
| --- | --- | --- |
| The talk is "Implementing Compose Hot Reload" by Sebastian Sellmair (2025) | present | Answer correctly identifies the talk title, speaker, and year. |
| It covers fighting ClassLoaders on the JVM | present | Answer explicitly states 'Fighting ClassLoaders' as one of the main challenges. |
| It covers patching the Kotlin compiler to handle "shifting lambda names" | present | Answer mentions 'Patching the Kotlin Compiler' and specifically references 'shifting lambda names' in quotes. |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.505 | 0.964 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ? Part 4: The Deep Dive | ? Part 4: The Deep Dive For those who want to see how the magic trick is performed. Using C & native platforms in Kotlin: Building a multi-platform advanced l… |
| 2 | 0.553 | 0.857 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload | Compose Hot Reload Compose Hot Reload is designed to speed up UI iteration by letting you instantly see changes without restarting the application: The Compos… |
| 3 | 0.474 | 0.343 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency | Development tools that boost your efficiency To make building Compose Multiplatform apps faster, smoother, and more enjoyable, we’re actively improving the KMP… |
| 4 | 0.515 | 0.214 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | MCP server for AI agents in Compose Hot Reload | MCP server for AI agents in Compose Hot Reload Compose Hot Reload now ships with an experimental Model Context Protocol (MCP) server that connects AI coding ag… |
| 5 | 0.461 | 0.096 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.10.0: Unified @Preview, Navigation 3, and Stable Compose Hot Reload Compose Multiplatform 1.10.0 has been rele… |

<details><summary>Dropped candidates (20)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 6 | 0.439 | 0.032 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog |  |
| 10 | 0.402 | 0.028 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › Support for Windows and Linux in the Kotlin Multiplatform IDE plugin |
| 15 ✓ | 0.383 | 0.006 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ? Part 1: Production Case Studies |
| 17 | 0.381 | 0.003 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious |
| 12 | 0.394 | 0.002 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Performance that’s ready for production |
| 7 ✓ | 0.438 | 0.002 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ?️ Part 2: Getting Your Hands Dirty |
| 11 | 0.394 | 0.002 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native |
| 21 | 0.375 | 0.001 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt |
| 24 | 0.369 | 0.001 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | Automatic font fallback for web |
| 16 | 0.382 | 0.001 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways |
| 23 | 0.372 | 0.001 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  |
| 19 | 0.378 | 0.001 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › General and quality improvements |
| 22 | 0.373 | 0.001 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Drag and drop on desktop |
| 13 | 0.389 | 0.001 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Release Compose Multiplatform for Web in Beta |
| 18 | 0.381 | 0.000 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  |
| 9 | 0.402 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Commonize Compose @Preview annotations |
| 14 | 0.383 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/JS › Fallback to Kotlin/JS for Compose for Web |
| 20 | 0.375 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Navigation 3 |
| 8 | 0.405 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Common @Preview annotation |
| 25 | 0.354 | 0.000 | scheduler_mcp_server/src/steps.js | templateProblems |

</details>

## q12

**near_miss** — Can I ship a Compose Multiplatform web app to production yet, or is the web target still experimental?

*Why:* Near miss: 'production-ready' is all over the 1.8.0 post (about iOS), and its web section says web is only 'one step closer' to production-ready. The specific answer (a Beta with most essential APIs) is one section of the August 2025 roadmap. Baseline vector search ranked that chunk 2nd, behind the 1.8.0 web section.

Expected sources: `What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog`

### plain — score 0.17, hallucination

66 in · 294 out · 3.7 s · fail

> # Compose Multiplatform Web Status
> 
> The **web target is still experimental** as of my last update (April 2024). Jetbrains has not yet promoted it to stable.
> 
> ## Current State
> 
> - **Experimental status**: The web target remains marked as experimental in the Compose Multiplatform documentation
> - **Usable for projects**: Many developers are using it in production despite the experimental label, but you do so at your own risk
> - **Active development**: Jetbrains continues improving it, but breaking changes are possible between releases
> 
> ## Considerations Before Shipping to Production
> 
> ✅ **Reasonable to use if:**
> - You're willing to handle potential API changes
> - Your project can tolerate occasional breaking updates
> - You have the capacity to maintain/update code as the platform evolves
> 
> ⚠️ **Be cautious if:**
> - You need guaranteed API stability
> - You can't easily update code when breaking changes occur
> - You need extensive third-party library support
> 
> ## Recommendation
> 
> Check the [official Compose Multiplatform documentation](https://www.jetbrains.com/help/kotlin-multiplatform-dev/compose-multiplatform-getting-started.html) for the latest status, as this may have changed since my knowledge cutoff. The team regularly updates the stability status of different targets.

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform for Web is being released as a Beta (not Stable) | contradicted | Answer states web target is 'experimental', not 'Beta'. These are different stability levels. |
| With the Beta, most essential APIs are available so early adopters can move to production with the existing feature set | partial | Answer mentions developers using it in production despite experimental label, but doesn't explicitly state that essential APIs are available or that early adopters can move to production with the existing feature set. |
| After the Beta, JetBrains keeps working on the remaining Compose APIs and performance | missing | Answer mentions active development and potential breaking changes, but doesn't specifically address what happens after Beta or the focus on remaining APIs and performance improvements. |

Hallucination: The answer states the web target is 'experimental' when the expected facts indicate it should be in 'Beta' status. These are different stability designations, and the answer contradicts the expected information about the release status."

### rag — score 1.00

1518 in · 282 out · 3.6 s · rank 2 · cited [2][1][3] · pass

> Based on the documents, **Compose Multiplatform for Web is moving toward production-readiness, but the status depends on timing**:
> 
> **Current Status (August 2025):**
> Compose Multiplatform for Web is being released in **Beta** [2]. According to the documentation, "Most essential APIs will be available, enabling early adopters to confidently move to production with the existing feature set" [2]. This suggests you *can* ship to production with the current feature set, though it's still in Beta rather than fully stable.
> 
> **What's Available:**
> - Version 1.8.0 includes improvements like Navigation library support for browser back/forward buttons and pointer cursor customization [1]
> - A compatibility mode using Kotlin/JS as a fallback will be introduced to support older browsers [3]
> 
> **Important Caveat:**
> The documents note that "After this Beta release, we will keep working on the remaining Compose APIs and further performance improvements" [2], indicating that not all APIs are yet available and improvements are still planned.
> 
> **Bottom Line:** You can move to production with Compose Multiplatform for Web if your app uses the essential APIs currently available, but it's still in Beta rather than a stable release. The team is actively developing additional features and improvements.

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform for Web is being released as a Beta (not Stable) | present | Answer clearly states 'Compose Multiplatform for Web is being released in Beta' and contrasts it with 'fully stable' |
| With the Beta, most essential APIs are available so early adopters can move to production with the existing feature set | present | Answer quotes the documentation: 'Most essential APIs will be available, enabling early adopters to confidently move to production with the existing feature set' |
| After the Beta, JetBrains keeps working on the remaining Compose APIs and performance | present | Answer states: 'After this Beta release, we will keep working on the remaining Compose APIs and further performance improvements' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.594 | — | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile | Compose Multiplatform beyond mobile Compose Multiplatform for the web is also evolving rapidly. With 1.8.0, the Navigation library now supports browser back an… |
| 2 ✓ | 0.584 | — | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Release Compose Multiplatform for Web in Beta | Compose Multiplatform Release Compose Multiplatform for Web in Beta This Beta version embodies our commitment to support and evolve the existing APIs of Compo… |
| 3 ✓ | 0.547 | — | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/JS › Fallback to Kotlin/JS for Compose for Web | Kotlin/JS Fallback to Kotlin/JS for Compose for Web As part of the Compose for Web Beta, we will be introducing a compatibility mode using Kotlin/JS as a fall… |
| 4 | 0.544 | — | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt | Production-ready and easy to adopt Compose Multiplatform for iOS now gives you the full package: stable APIs, great performance, a native feel, and modern tool… |
| 5 ✓ | 0.537 | — | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Key priorities | Key priorities Kotlin Multiplatform spans many areas, from language features and target-specific compilation to our IDE plugin. It’s a lot to track, so here ar… |

### rag+rerank — score 1.00

1708 in · 269 out · 6.3 s · rank 2 · cited [2][1][4][5] · pass

> Based on the documents provided, Compose Multiplatform for Web is **not yet fully production-ready**, though it's moving in that direction.
> 
> Here's the current status:
> 
> **Beta Release (Planned/Recent):** Compose Multiplatform for Web is being released in Beta, with "most essential APIs" available. According to the documents, this Beta version is designed so that "early adopters can confidently move to production with the existing feature set." [2]
> 
> **Still Evolving:** However, the documents indicate that after the Beta release, JetBrains will "keep working on the remaining Compose APIs and further performance improvements." [2] Additionally, the web target is described as one step closer to "providing a polished, production-ready experience" rather than already being fully production-ready. [1]
> 
> **In Contrast to iOS:** It's worth noting that Compose Multiplatform for iOS has already reached stable status and is described as "production-ready," [4][5] but the web target has not yet reached that same level of maturity.
> 
> So while early adopters can experiment with shipping web apps to production using the Beta version, the web target is not yet officially stable like the iOS target is.

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform for Web is being released as a Beta (not Stable) | present | Answer clearly states 'Compose Multiplatform for Web is being released in Beta' and contrasts it with iOS being 'stable' |
| With the Beta, most essential APIs are available so early adopters can move to production with the existing feature set | present | Answer quotes directly: 'most essential APIs' available and 'early adopters can confidently move to production with the existing feature set' |
| After the Beta, JetBrains keeps working on the remaining Compose APIs and performance | present | Answer states JetBrains will 'keep working on the remaining Compose APIs and further performance improvements' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.594 | 0.962 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile | Compose Multiplatform beyond mobile Compose Multiplatform for the web is also evolving rapidly. With 1.8.0, the Navigation library now supports browser back an… |
| 2 ✓ | 0.584 | 0.914 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Release Compose Multiplatform for Web in Beta | Compose Multiplatform Release Compose Multiplatform for Web in Beta This Beta version embodies our commitment to support and evolve the existing APIs of Compo… |
| 3 ✓ | 0.537 | 0.904 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Key priorities | Key priorities Kotlin Multiplatform spans many areas, from language features and target-specific compilation to our IDE plugin. It’s a lot to track, so here ar… |
| 4 | 0.494 | 0.888 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Everything you need to build apps for real-world use | Everything you need to build apps for real-world use Compose Multiplatform for iOS now includes everything you need to build beautiful UIs for real-world apps:… |
| 5 | 0.544 | 0.443 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt | Production-ready and easy to adopt Compose Multiplatform for iOS now gives you the full package: stable APIs, great performance, a native feel, and modern tool… |

<details><summary>Dropped candidates (15)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 7 | 0.513 | 0.231 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  |
| 6 | 0.522 | 0.106 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Performance that’s ready for production |
| 16 ✓ | 0.477 | 0.066 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › General and quality improvements |
| 9 | 0.507 | 0.052 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  |
| 8 | 0.511 | 0.050 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native |
| 11 | 0.499 | 0.041 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  |
| 10 | 0.500 | 0.017 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog |  |
| 15 | 0.484 | 0.015 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious |
| 12 | 0.496 | 0.009 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency |
| 13 | 0.494 | 0.009 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | Automatic font fallback for web |
| 17 | 0.471 | 0.004 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | MCP server for AI agents in Compose Hot Reload |
| 19 ✓ | 0.464 | 0.004 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Make more ecosystem components available for Compose Multiplatform |
| 18 | 0.469 | 0.003 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Type-safe navigation |
| 20 | 0.464 | 0.001 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Improved touch interop between Compose Multiplatform and native iOS |
| 3 ✓ | 0.547 | 0.001 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/JS › Fallback to Kotlin/JS for Compose for Web |

</details>

### rag+rewrite+rerank — score 1.00

2647 in · 330 out · 7.6 s · rank 1 → 2 · cited [2][1][4][5] · pass

Queries searched: `Compose Multiplatform web target production ready` · `Compose Multiplatform web experimental status`

> Based on the documents provided, Compose Multiplatform for Web is **not yet fully production-ready**, though it's moving in that direction.
> 
> Here's the current status:
> 
> **Beta Release (Planned/Recent):** Compose Multiplatform for Web is being released in Beta, with "most essential APIs" available. According to the documents, this Beta version is designed so that "early adopters can confidently move to production with the existing feature set." [2]
> 
> **Still Evolving:** However, the documents indicate that after the Beta release, JetBrains will "keep working on the remaining Compose APIs and further performance improvements." [2] Additionally, the web target is described as one step closer to "providing a polished, production-ready experience" rather than already being fully production-ready. [1]
> 
> **In Contrast to iOS:** It's worth noting that Compose Multiplatform for iOS has already reached stable status and is described as "production-ready," [4][5] but the web target has not yet reached that same level of maturity.
> 
> So while early adopters can move to production with the Beta version, the web target is still in active development and not yet at the stable, production-ready status that iOS has achieved.

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform for Web is being released as a Beta (not Stable) | present | Answer clearly states 'Compose Multiplatform for Web is being released in Beta' and contrasts it with iOS being 'stable' |
| With the Beta, most essential APIs are available so early adopters can move to production with the existing feature set | present | Answer quotes directly: 'most essential APIs' available and 'early adopters can confidently move to production with the existing feature set' |
| After the Beta, JetBrains keeps working on the remaining Compose APIs and performance | present | Answer states JetBrains will 'keep working on the remaining Compose APIs and further performance improvements' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.618 | 0.962 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile | Compose Multiplatform beyond mobile Compose Multiplatform for the web is also evolving rapidly. With 1.8.0, the Navigation library now supports browser back an… |
| 2 ✓ | 0.628 | 0.914 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Release Compose Multiplatform for Web in Beta | Compose Multiplatform Release Compose Multiplatform for Web in Beta This Beta version embodies our commitment to support and evolve the existing APIs of Compo… |
| 3 ✓ | 0.567 | 0.904 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Key priorities | Key priorities Kotlin Multiplatform spans many areas, from language features and target-specific compilation to our IDE plugin. It’s a lot to track, so here ar… |
| 4 | 0.545 | 0.888 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Everything you need to build apps for real-world use | Everything you need to build apps for real-world use Compose Multiplatform for iOS now includes everything you need to build beautiful UIs for real-world apps:… |
| 5 | 0.581 | 0.443 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt | Production-ready and easy to adopt Compose Multiplatform for iOS now gives you the full package: stable APIs, great performance, a native feel, and modern tool… |

<details><summary>Dropped candidates (18)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 8 | 0.572 | 0.231 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  |
| 21 | 0.505 | 0.123 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways |
| 11 | 0.554 | 0.106 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Performance that’s ready for production |
| 19 ✓ | 0.534 | 0.066 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › General and quality improvements |
| 6 | 0.581 | 0.052 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  |
| 12 | 0.547 | 0.050 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native |
| 7 | 0.576 | 0.041 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  |
| 22 | 0.503 | 0.018 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Drag and drop on desktop |
| 4 | 0.585 | 0.017 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog |  |
| 20 | 0.529 | 0.015 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious |
| 15 | 0.543 | 0.009 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency |
| 9 | 0.570 | 0.009 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | Automatic font fallback for web |
| 16 | 0.542 | 0.006 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Resources updates and improvements |
| 18 | 0.535 | 0.005 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload |
| 23 ✓ | 0.492 | 0.004 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › Support for Windows and Linux in the Kotlin Multiplatform IDE plugin |
| 17 | 0.538 | 0.004 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | MCP server for AI agents in Compose Hot Reload |
| 13 | 0.546 | 0.001 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Improved touch interop between Compose Multiplatform and native iOS |
| 3 ✓ | 0.610 | 0.001 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/JS › Fallback to Kotlin/JS for Compose for Web |

</details>

## q13

**off_topic** (should be declined) — How long should I proof sourdough bread in the fridge overnight, and at what temperature?

*Why:* Nothing in the corpus is about cooking; the best vector match scores about 0.19 (scheduler source code). With RAG the right answer is a decline; with rerank on, the cutoff should drop every candidate and decline without calling the model. Plain mode will answer from general knowledge, which counts as not declining.

Expected sources: none

### plain — score 0.00

62 in · 289 out · 3.7 s · not declined

> # Sourdough Cold Proof Guidelines
> 
> **Duration:** 8-16 hours (overnight is ideal)
> 
> **Temperature:** 35-40°F (2-4°C)
> 
> ## Key Points
> 
> - **Longer is better** within reason—up to 24 hours can work and develops more flavor
> - **Shorter proofs** (8-12 hours) are fine if you're in a hurry
> - **Too warm** (above 45°F) risks over-proofing; **too cold** (below 32°F) slows fermentation significantly
> 
> ## Why Cold Proof?
> 
> - Develops deeper flavor through slow fermentation
> - Makes dough easier to score and handle
> - Improves oven spring and crumb structure
> 
> ## Tips
> 
> - Shape your dough, place it seam-side up in a banneton or bowl, cover it, then refrigerate
> - You can test if it's ready by the "poke test"—gently poke the dough; it should spring back slowly (not immediately, not not at all)
> - Remove from fridge 30-60 minutes before baking for a slight room-temperature rest, or bake straight from cold
> 
> Most bakers find 12-16 hours at fridge temperature to be the sweet spot.

| expected fact | grade | note |
| --- | --- | --- |
| Says the available information does not cover baking or sourdough | missing | The answer provides detailed baking advice without disclaiming that this is outside the scope of available documents. |
| Does not present proofing times or temperatures as coming from the documents | contradicted | The answer presents specific proofing times (8-16 hours) and temperatures (35-40°F) as authoritative guidance without any indication these come from external knowledge rather than the documents. |

### rag — score 1.00, declined

1693 in · 69 out · 1.3 s · rank — · cited nothing · pass

> The provided documents do not contain information about sourdough bread proofing. They cover topics related to software development, including task scheduling, memory management, and document indexing.
> 
> To answer your question about sourdough bread proofing times and temperatures, you would need to consult cooking or baking resources instead.

| expected fact | grade | note |
| --- | --- | --- |
| Says the available information does not cover baking or sourdough | present | Answer explicitly states 'The provided documents do not contain information about sourdough bread proofing' and notes they cover software development topics instead. |
| Does not present proofing times or temperatures as coming from the documents | present | Answer does not provide any proofing times or temperatures from the documents. It correctly declines to answer and directs to external resources. |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.191 | — | scheduler_mcp_server/src/tools.js | intervalSeconds | const intervalSeconds = z.number().int().min(MIN_INTERVAL_SECONDS).max(7 * 24 * 3600).describe(`Seconds between runs, at least ${MIN_INTERVAL_SECONDS}.`); |
| 2 | 0.191 | — | first-agent/src/context/memory.js | MemoryStrategy | let result; try { result = await this.#proposerFor(provider).propose({ text: typed, invariants: orderInvariants(invariants.entries), … |
| 3 | 0.190 | — | first-agent/src/context/invariants.js | InvariantProposer | /** * @param {object} params * @param {string} params.text - What the person typed, verbatim. * @param {{ key: string, text: string, check: string }[]}… |
| 4 | 0.183 | — | first-agent/src/context/invariants.js | PROPOSER_PROMPT | const PROPOSER_PROMPT = [ "A person has typed, in prose, the rules their project does not break. You turn that", "prose into structured proposals. You are *… |
| 5 | 0.178 | — | PROMPT.md | Pipeline › Chunk record | Chunk record ```js { chunk_id,      // `${doc_id}:${strategy}:${index}`; stable across runs if inputs are unchanged strategy,      // "fixed" \| "structural… |

### rag+rerank — score 1.00, declined by the cutoff

0 in · 0 out · 5.2 s · rank — · cited nothing · pass

> The provided documents do not cover this question: none of the retrieved passages was relevant enough to answer from, so no answer was generated. The closest passages are listed below.

| expected fact | grade | note |
| --- | --- | --- |
| Says the available information does not cover baking or sourdough | present | Answer explicitly states 'The provided documents do not cover this question' and that 'none of the retrieved passages was relevant enough to answer from' |
| Does not present proofing times or temperatures as coming from the documents | present | Answer declines to provide an answer and does not cite any proofing times or temperatures from the documents |

Kept chunks: none (declined).

<details><summary>Dropped candidates (20)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 3 | 0.190 | 0.001 | first-agent/src/context/invariants.js | InvariantProposer |
| 15 | 0.157 | 0.000 | first-agent/src/context/memory.js | MemoryStrategy |
| 17 | 0.156 | 0.000 | first-agent/src/store/conversationStore.js | normaliseRecord |
| 5 | 0.178 | 0.000 | PROMPT.md | Pipeline › Chunk record |
| 10 | 0.163 | 0.000 | first-agent/src/store/invariantStore.js | (module) |
| 14 | 0.157 | 0.000 | first-agent/src/context/memory.js | MemoryStrategy |
| 12 | 0.157 | 0.000 | first-agent/src/context/memory.js | MemoryStrategy |
| 13 | 0.157 | 0.000 | scheduler_mcp_server/src/steps.js | validateProposal |
| 9 | 0.163 | 0.000 | first-agent/src/store/profileStore.js | (module) |
| 4 | 0.183 | 0.000 | first-agent/src/context/invariants.js | PROPOSER_PROMPT |
| 20 | 0.152 | 0.000 | first-agent/src/context/memory.js | MemoryStrategy |
| 19 | 0.154 | 0.000 | first-agent/src/context/memory.js | writeProfile |
| 6 | 0.178 | 0.000 | first-agent/src/context/invariants.js | proposalPrompt |
| 11 | 0.161 | 0.000 | first-agent/src/store/memoryStore.js | MemoryStore |
| 16 | 0.156 | 0.000 | first-agent/src/memoryRoutes.js | memoryRoutes |
| 8 | 0.165 | 0.000 | first-agent/src/context/memory.js | MemoryStrategy |
| 18 | 0.156 | 0.000 | PROMPT.md | Project setup |
| 7 | 0.170 | 0.000 | first-agent/src/context/memory.js | HISTORY_DEPTH |
| 2 | 0.191 | 0.000 | first-agent/src/context/memory.js | MemoryStrategy |
| 1 | 0.191 | 0.000 | scheduler_mcp_server/src/tools.js | intervalSeconds |

</details>

### rag+rewrite+rerank — score 1.00, declined by the cutoff

935 in · 43 out · 6.2 s · rank — · cited nothing · pass

Queries searched: `sourdough bread fridge proof overnight temperature`

> The provided documents do not cover this question: none of the retrieved passages was relevant enough to answer from, so no answer was generated. The closest passages are listed below.

| expected fact | grade | note |
| --- | --- | --- |
| Says the available information does not cover baking or sourdough | present | Answer explicitly states 'The provided documents do not cover this question' and that 'none of the retrieved passages was relevant enough to answer from' |
| Does not present proofing times or temperatures as coming from the documents | present | Answer declines to provide an answer and does not cite any proofing times or temperatures from the documents |

Kept chunks: none (declined).

<details><summary>Dropped candidates (20)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 4 | 0.168 | 0.001 | first-agent/src/context/invariants.js | InvariantProposer |
| 12 | 0.159 | 0.000 | first-agent/src/context/memory.js | MemoryStrategy |
| 20 | 0.154 | 0.000 | first-agent/src/context/memory.js | MemoryStrategy |
| 5 | 0.167 | 0.000 | first-agent/src/store/conversationStore.js | normaliseRecord |
| 17 | 0.156 | 0.000 | first-agent/src/context/memory.js | applyOps |
| 2 | 0.179 | 0.000 | PROMPT.md | Pipeline › Chunk record |
| 11 | 0.160 | 0.000 | first-agent/src/store/invariantStore.js | (module) |
| 18 | 0.154 | 0.000 | first-agent/src/context/memory.js | MemoryStrategy |
| 13 | 0.158 | 0.000 | first-agent/src/store/invariantStore.js | writeInvariant |
| 19 | 0.154 | 0.000 | scheduler_mcp_server/src/steps.js | validateProposal |
| 8 | 0.164 | 0.000 | first-agent/src/context/invariants.js | PROPOSER_PROMPT |
| 9 | 0.164 | 0.000 | first-agent/src/context/invariants.js | proposalPrompt |
| 3 | 0.170 | 0.000 | first-agent/src/store/memoryStore.js | MemoryStore |
| 10 | 0.160 | 0.000 | first-agent/src/memoryRoutes.js | memoryRoutes |
| 14 | 0.158 | 0.000 | first-agent/src/context/memory.js | MemoryStrategy |
| 6 | 0.167 | 0.000 | first-agent/src/context/memory.js | HISTORY_DEPTH |
| 1 | 0.180 | 0.000 | first-agent/src/context/memory.js | MemoryStrategy |
| 7 | 0.166 | 0.000 | scheduler_mcp_server/src/tools.js | intervalSeconds |
| 15 | 0.157 | 0.000 | first-agent/src/store/memoryStore.js | clone |
| 16 | 0.157 | 0.000 | first-agent/src/agent.js | difference |

</details>

## q14

**paraphrased** — In JetBrains' cross-platform UI toolkit, can people using my app on a Windows or Mac computer grab an element with the mouse, carry it across and let go of it over another element? Which version brought that, and what do I attach to the two elements?

*Why:* Paraphrased: none of 'Compose', 'drag', 'drop', 'desktop' or 'modifier' appears in the question. Baseline vector search still found the 1.7.0 post (its intro chunk 1st, the drag-and-drop section 2nd).

Expected sources: `Compose Multiplatform 1.7.0 Released - The JetBrains Blog`

### plain — score 0.00, hallucination

100 in · 320 out · 3.2 s · fail

> # Drag and Drop in Compose for Desktop
> 
> Yes, this is possible in **Compose for Desktop** (JetBrains' cross-platform UI toolkit based on Jetpack Compose).
> 
> ## Version
> 
> Drag and drop support was introduced in **Compose for Desktop 1.0** and has been refined in subsequent releases.
> 
> ## What to Attach
> 
> You need to use two modifiers:
> 
> 1. **`Modifier.draggable()`** - Attach to the element you want to drag
> 2. **`Modifier.dropTarget()`** - Attach to the element that should receive the drop
> 
> ## Basic Example
> 
> ```kotlin
> var draggedItem by remember { mutableStateOf<String?>(null) }
> 
> Box(
>     modifier = Modifier
>         .draggable(
>             state = rememberDraggableState { delta ->
>                 draggedItem = "item1"
>             }
>         )
> ) {
>     Text("Drag me")
> }
> 
> Box(
>     modifier = Modifier
>         .dropTarget(
>             onDrop = { transferable ->
>                 // Handle the drop
>                 draggedItem = null
>             }
>         )
> ) {
>     Text("Drop here")
> }
> ```
> 
> For more sophisticated drag-and-drop scenarios, you can also work with the lower-level `TransferableContent` API to handle different data types being dragged and dropped.

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform 1.7.0 added drag and drop on desktop | contradicted | Answer states drag and drop was introduced in Compose for Desktop 1.0, not 1.7.0 |
| The dragAndDropSource modifier marks the composable where a drag starts | contradicted | Answer mentions Modifier.draggable() instead of dragAndDropSource |
| The dragAndDropTarget modifier marks the composable that accepts the dropped data | contradicted | Answer mentions Modifier.dropTarget() instead of dragAndDropTarget |

Hallucination: The answer provides incorrect modifier names (Modifier.draggable() and Modifier.dropTarget() instead of dragAndDropSource and dragAndDropTarget) and an incorrect version number (1.0 instead of 1.7.0). The code example uses non-existent APIs that don't match the actual Compose Multiplatform drag-and-drop implementation.

### rag — score 1.00

1148 in · 93 out · 1.6 s · rank 1 · cited [2] · pass

> Yes, people using your app on Windows or Mac can do that. [2]
> 
> **Version:** Compose Multiplatform 1.7.0 brought drag and drop support for desktop. [2]
> 
> **What to attach:** You use two modifiers:
> - `dragAndDropSource` on the element being dragged
> - `dragAndDropTarget` on the element that accepts the dropped data [2]

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform 1.7.0 added drag and drop on desktop | present | Answer correctly states that Compose Multiplatform 1.7.0 brought drag and drop support for desktop. |
| The dragAndDropSource modifier marks the composable where a drag starts | present | Answer correctly identifies dragAndDropSource as the modifier for the element being dragged. |
| The dragAndDropTarget modifier marks the composable that accepts the dropped data | present | Answer correctly identifies dragAndDropTarget as the modifier for the element that accepts the dropped data. |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.465 | — | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.7.0 Released Compose Multiplatform is a declarative UI framework built by JetBrains that allows developers to … |
| 2 ✓ | 0.456 | — | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Drag and drop on desktop | Drag and drop on desktop Compose Multiplatform 1.7.0 implements drag and drop for desktop. You can now use the dragAndDropSource and dragAndDropTarget modifier… |
| 3 ✓ | 0.437 | — | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Shared element transitions | Shared element transitions Compose Multiplatform now supports seamless transitions between composables that share consistent elements. These transitions are of… |
| 4 | 0.398 | — | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Getting Started Without the Hype | Getting Started Without the Hype Don’t rewrite your entire app. Start small: - Move Business Logic of a Feature Into a Shared Module - Expose your network la… |
| 5 | 0.397 | — | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | The Real-World Impact | The Real-World Impact In an article about their migration to KMP with Kotlin 2.3, Basecamp reported that code duplication was reduced by 40%. Auth, data sync, … |

### rag+rerank — score 0.00, declined

692 in · 115 out · 4.6 s · rank 1 · cited nothing · wrong decline (model)

> The provided documents do not contain information about drag-and-drop functionality in Compose Multiplatform, which version introduced it, or how to implement it. While the documents discuss Compose Multiplatform as a cross-platform UI framework and mention the 1.7.0 release features, they don't cover drag-and-drop capabilities or the APIs needed to attach to elements for this functionality.
> 
> To answer your question, I would need documentation that specifically addresses drag-and-drop features in Compose Multiplatform.

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform 1.7.0 added drag and drop on desktop | missing |  |
| The dragAndDropSource modifier marks the composable where a drag starts | missing |  |
| The dragAndDropTarget modifier marks the composable that accepts the dropped data | missing |  |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.465 | 0.055 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.7.0 Released Compose Multiplatform is a declarative UI framework built by JetBrains that allows developers to … |
| 2 | 0.396 | 0.030 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | The Ship Kotlin Everywhere Award | The Ship Kotlin Everywhere Award JetBrains is a Gold Sponsor of Shipaton this year, with our own category. The idea is simple: reuse the Kotlin you already kno… |

<details><summary>Dropped candidates (18)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 5 | 0.397 | 0.005 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | The Real-World Impact |
| 15 | 0.379 | 0.003 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Everything you need to build apps for real-world use |
| 9 | 0.391 | 0.001 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways |
| 4 | 0.398 | 0.001 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Getting Started Without the Hype |
| 3 ✓ | 0.437 | 0.001 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Shared element transitions |
| 17 | 0.366 | 0.001 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native |
| 20 | 0.358 | 0.001 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload |
| 14 | 0.380 | 0.001 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious |
| 18 | 0.360 | 0.000 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency |
| 2 ✓ | 0.456 | 0.000 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Drag and drop on desktop |
| 11 | 0.390 | 0.000 | Kotlin 2.0.0_ A New Era in Kotlin Development _ by Halil Özel _ Medium | 3. Expanded Multiplatform Support 🎗️ |
| 10 | 0.390 | 0.000 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile |
| 16 | 0.369 | 0.000 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 1. Sensible Native Interop That Plays Nice With You |
| 6 | 0.396 | 0.000 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What You Should Actually Share › Keep Platform-Specific: |
| 19 | 0.360 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Common @Preview annotation |
| 8 ✓ | 0.393 | 0.000 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Improved touch interop between Compose Multiplatform and native iOS |
| 12 | 0.384 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  |
| 13 | 0.381 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › Support for Windows and Linux in the Kotlin Multiplatform IDE plugin |

</details>

### rag+rewrite+rerank — score 0.00, declined

1481 in · 161 out · 7.0 s · rank 1 · cited nothing · wrong decline (model)

Queries searched: `Compose Multiplatform drag and drop Windows Mac` · `Compose drag drop API version` · `draggable droppable Compose Multiplatform`

> The provided documents do not contain information about drag-and-drop functionality in Compose Multiplatform, which version introduced it, or how to implement it between elements. The document only covers the highlights of version 1.7.0, which focuses on Material3 components, type-safe navigation, and iOS performance improvements.
> 
> To answer your question about drag-and-drop implementation, I would need documentation that specifically covers that feature.

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform 1.7.0 added drag and drop on desktop | missing | The answer declines to answer, stating the documents don't contain this information. |
| The dragAndDropSource modifier marks the composable where a drag starts | missing | The answer declines to answer, stating the documents don't contain this information. |
| The dragAndDropTarget modifier marks the composable that accepts the dropped data | missing | The answer declines to answer, stating the documents don't contain this information. |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.537 | 0.055 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.7.0 Released Compose Multiplatform is a declarative UI framework built by JetBrains that allows developers to … |

<details><summary>Dropped candidates (27)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 5 | 0.520 | 0.003 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Everything you need to build apps for real-world use |
| 14 | 0.470 | 0.001 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways |
| 11 ✓ | 0.485 | 0.001 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Shared element transitions |
| 2 | 0.543 | 0.001 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native |
| 12 | 0.480 | 0.001 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog |  |
| 9 | 0.494 | 0.001 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload |
| 10 | 0.489 | 0.001 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious |
| 17 | 0.460 | 0.001 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | Window and dialog API v2 |
| 13 | 0.475 | 0.000 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency |
| 1 ✓ | 0.724 | 0.000 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Drag and drop on desktop |
| 15 | 0.470 | 0.000 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Performance that’s ready for production |
| 20 | 0.451 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Common @Preview annotation |
| 7 | 0.517 | 0.000 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  |
| 18 ✓ | 0.459 | 0.000 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Performance improvements on iOS |
| 19 ✓ | 0.458 | 0.000 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Resources updates and improvements |
| 8 ✓ | 0.506 | 0.000 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Improved touch interop between Compose Multiplatform and native iOS |
| 4 | 0.523 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  |
| 6 | 0.518 | 0.000 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt |
| 22 | 0.447 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › Support for Windows and Linux in the Kotlin Multiplatform IDE plugin |
| 23 | 0.422 | 0.000 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | Automatic font fallback for web |
| 16 | 0.461 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Release Compose Multiplatform for Web in Beta |
| 28 ✓ | 0.409 | 0.000 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Type-safe navigation |
| 21 ✓ | 0.449 | 0.000 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | New common modules |
| 24 | 0.421 | 0.000 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | MCP server for AI agents in Compose Hot Reload |
| 26 | 0.415 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Navigation 3 |
| 25 | 0.415 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/JS › Fallback to Kotlin/JS for Compose for Web |
| 27 | 0.410 | 0.000 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Make more ecosystem components available for Compose Multiplatform |

</details>

## q15

**messy** — hi! ok so long story — we're rewriting our notes app and my coworker insists we keep our hand-rolled ID generator in the shared module because "kotlin doesn't have UUIDs in common code", which sounds wrong to me?? we're on kotlin 2.4 btw, just upgraded last sprint. anyway: is there a stable UUID type in common code now or do we still need a library, and can we generate v4/v7 ones without opting into anything? thanks, sorry for the wall of text lol

*Why:* Messy: a two-line question wrapped in backstory and filler. Rewriting should reduce it to one or two short queries; the answer is one short section of the Kotlin 2.4 features article.

Expected sources: `Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium`

### plain — score 0.50, hallucination

159 in · 344 out · 4.1 s · fail

> # UUID in Kotlin Multiplatform
> 
> Good news: **your coworker is outdated!** Kotlin 2.0+ added stable UUID support to `kotlin-stdlib` for common code.
> 
> ## What you get
> 
> - `kotlin.uuid.Uuid` class in common code (no library needed)
> - Built-in v4 (random) and v7 (time-based) generation
> - Fully stable, no experimental opt-in required
> 
> ## Basic usage
> 
> ```kotlin
> // V4 (random)
> val id = Uuid.random()
> 
> // V7 (time-based, sortable)
> val id = Uuid.random(UuidVersion.V7)
> 
> // Parse from string
> val id = Uuid.parse("550e8400-e29b-41d4-a716-446655440000")
> 
> // Convert to string
> val str = id.toString()
> ```
> 
> ## For your case
> 
> You can absolutely replace the hand-rolled generator with:
> 
> ```kotlin
> // In your shared module
> fun generateNoteId(): String = Uuid.random(UuidVersion.V7).toString()
> ```
> 
> V7 is probably better for notes anyway since it's sortable by timestamp.
> 
> ## One caveat
> 
> Make sure your `build.gradle.kts` targets Kotlin 2.0+. If you're on 2.4, you're definitely fine. The UUID API is in the standard library, so no extra dependency needed.
> 
> You can safely delete the custom generator! 🎉

| expected fact | grade | note |
| --- | --- | --- |
| Kotlin 2.4 has a stable kotlin.uuid.Uuid usable in common code | present | Answer states 'Kotlin 2.0+ added stable UUID support' and confirms it works in common code with no library needed. |
| The V4/V7 generation functions are still experimental (need an opt-in) | contradicted | Answer claims 'Built-in v4 (random) and v7 (time-based) generation' with 'no experimental opt-in required', directly contradicting the expected fact that these need opt-in. |

Hallucination: The answer claims V4/V7 generation functions require no experimental opt-in, but the expected facts indicate they are still experimental and require opt-in. This is a specific, verifiable claim that contradicts the expected information.

### rag — score 1.00

1295 in · 287 out · 4.0 s · rank 1 · cited [1][3] · pass

> No need to apologize! Your coworker is actually outdated on this one.
> 
> **Yes, there's now a stable UUID type in common code.** As of Kotlin 2.4, `kotlin.uuid.Uuid` is stable and available for common code, which is perfect for your shared module use case. It's specifically designed for things like "offline-first Room entities and multiplatform IDs." [1]
> 
> **However, there's a catch with V4/V7 generation:** The V4 and V7 UUID generation functions are still experimental, so you *would* need to opt into them if you want to use those. [1] The stable part is the UUID type itself, not the generators.
> 
> So your options are:
> - Use the stable `Uuid` type and generate UUIDs however you're currently doing it
> - Use the stable `Uuid` type with experimental V4/V7 generators (requires opt-in)
> - Keep your hand-rolled solution if you need non-experimental generation
> 
> For a notes app on Kotlin 2.4, I'd lean toward ditching the hand-rolled generator and using the stable `Uuid` type at minimum—you can always add the experimental generators later if needed. [3] suggests the UUID API is now safe to use.

| expected fact | grade | note |
| --- | --- | --- |
| Kotlin 2.4 has a stable kotlin.uuid.Uuid usable in common code | present | Answer clearly states 'As of Kotlin 2.4, `kotlin.uuid.Uuid` is stable and available for common code' |
| The V4/V7 generation functions are still experimental (need an opt-in) | present | Answer explicitly states 'The V4 and V7 UUID generation functions are still experimental, so you *would* need to opt into them' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.658 | — | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | 4. Stable UUID API | 4. Stable UUID API kotlin.uuid.Uuid Common code has a stable Uuid, used for offline-first Room entities and multiplatform IDs. V4/V7 generation functions remai… |
| 2 | 0.528 | — | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | What Kotlin 2.4 Actually Delivers › Platform support: | Standard library: - Support for the unsupported UUID API, and implement support for checking order Platform support: - Kotlin/JVM : support for Java 26, anno… |
| 3 ✓ | 0.501 | — | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | Key Takeaways | Key Takeaways - Context Parameters are production-ready — begin using them. To thread dependencies - Make UUID API and annotation use-site targets opt-out saf… |
| 4 | 0.470 | — | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Should You Upgrade Right Now? | Should You Upgrade Right Now? - First things first: check for Gradle compatibility and update Android Studio — 2.4 requires Gradle 9.5.0+ - Rewriting all your… |
| 5 | 0.459 | — | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 💼 @JvmExposeBoxed: Finally, Seamless Java Interop | 💼 @JvmExposeBoxed: Finally, Seamless Java Interop This annotation solves one of the biggest pain points when using Kotlin from Java. // Before: Impossible to… |

### rag+rerank — score 1.00

1638 in · 251 out · 7.7 s · rank 1 · cited [1] · pass

> No need to apologize! Your coworker is actually outdated on this one — you *do* have a stable UUID type in common code now.
> 
> Here's what Kotlin 2.4 gives you:
> 
> **The good news:** `kotlin.uuid.Uuid` is now stable in common code [1], so you can use it across your shared module without any external libraries.
> 
> **The caveat:** V4 and V7 generation functions are still experimental [1], so if you want to generate those UUID versions, you'd need to opt into the experimental API (using `@OptIn` or similar).
> 
> So your options are:
> - Use the stable `Uuid` type itself without any opt-ins ✅
> - Generate V4/V7 UUIDs, but you'll need to explicitly opt into experimental APIs ⚠️
> 
> For a notes app, you could probably just use the stable API and handle generation however works best for your use case, or bite the bullet on the experimental opt-in if V4/V7 generation is important to you. Either way, you can definitely ditch that hand-rolled generator!

| expected fact | grade | note |
| --- | --- | --- |
| Kotlin 2.4 has a stable kotlin.uuid.Uuid usable in common code | present | Answer clearly states 'kotlin.uuid.Uuid is now stable in common code' |
| The V4/V7 generation functions are still experimental (need an opt-in) | present | Answer states 'V4 and V7 generation functions are still experimental' and 'you'd need to opt into the experimental API' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.658 | 0.955 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | 4. Stable UUID API | 4. Stable UUID API kotlin.uuid.Uuid Common code has a stable Uuid, used for offline-first Room entities and multiplatform IDs. V4/V7 generation functions remai… |
| 2 | 0.421 | 0.157 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🔐 Stable Base64: Finally, Built-in Encoding That Works Everywhere | import kotlin.io.encoding.Base64 import kotlin.io.encoding.ExperimentalEncodingApi // Multiple encoding schemes for different use cases class SecureDataHandler … |
| 3 | 0.528 | 0.152 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | What Kotlin 2.4 Actually Delivers › Platform support: | Standard library: - Support for the unsupported UUID API, and implement support for checking order Platform support: - Kotlin/JVM : support for Java 26, anno… |
| 4 | 0.443 | 0.140 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium |  | Kotlin 2.4 vs Kotlin 2.3: What Actually Changed? AndroidLab by Andre3 min readSep 17, 2026 From experimental context parameters to stable features — here’s wh… |
| 5 | 0.470 | 0.083 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Should You Upgrade Right Now? | Should You Upgrade Right Now? - First things first: check for Gradle compatibility and update Android Studio — 2.4 requires Gradle 9.5.0+ - Rewriting all your… |

<details><summary>Dropped candidates (15)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 6 | 0.445 | 0.060 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🚀 Getting Started Today |
| 11 | 0.437 | 0.048 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Getting Started Without the Hype |
| 8 | 0.441 | 0.027 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Why Should You Care About This in Your Codebase |
| 17 | 0.424 | 0.013 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways |
| 12 | 0.437 | 0.012 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🔮 What This Means for Your Daily Development |
| 13 | 0.435 | 0.012 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 🚀 Final Thoughts |
| 5 | 0.459 | 0.011 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 💼 @JvmExposeBoxed: Finally, Seamless Java Interop |
| 18 | 0.424 | 0.007 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | The One Feature That Really Matters: Context Parameters Going Stabile |
| 20 | 0.421 | 0.007 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements › Per-Object Memory Allocation |
| 15 | 0.432 | 0.006 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium |  |
| 10 | 0.439 | 0.005 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Support for New Gradle Versions |
| 14 | 0.434 | 0.004 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 1. Sensible Native Interop That Plays Nice With You |
| 3 ✓ | 0.501 | 0.003 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | Key Takeaways |
| 16 ✓ | 0.432 | 0.001 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | Should You Upgrade Now? |
| 9 | 0.441 | 0.000 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Quick Hits Worth Knowing |

</details>

### rag+rewrite+rerank — score 1.00

2760 in · 307 out · 13.7 s · rank 1 · cited [1] · pass

Queries searched: `Kotlin UUID common code multiplatform` · `Kotlin 2.4 UUID generation v4 v7` · `kotlin.uuid stable release`

> No need to apologize! Your coworker is outdated — you can definitely ditch that hand-rolled generator.
> 
> **Stable UUID in common code:** Yes! Kotlin 2.4 has a stable `kotlin.uuid.Uuid` type available in common code, which is perfect for your use case. [1] It's specifically designed for things like offline-first Room entities and multiplatform IDs. [1]
> 
> **V4/V7 generation:** Here's the catch though — the UUID type itself is stable, but the V4 and V7 generation functions are still experimental. [1] So you can use `Uuid` as a type without any opt-in, but if you want to generate V4 or V7 UUIDs, you'll need to opt into the experimental API.
> 
> **Bottom line:** You can replace your hand-rolled generator with Kotlin's built-in `Uuid` type. If V4/V7 generation being experimental is a blocker for you, you might still need a library, but the core UUID type is production-ready now.

| expected fact | grade | note |
| --- | --- | --- |
| Kotlin 2.4 has a stable kotlin.uuid.Uuid usable in common code | present | Answer explicitly states 'Kotlin 2.4 has a stable kotlin.uuid.Uuid type available in common code' |
| The V4/V7 generation functions are still experimental (need an opt-in) | present | Answer clearly states 'the V4 and V7 generation functions are still experimental' and 'you'll need to opt into the experimental API' |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.715 | 0.955 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | 4. Stable UUID API | 4. Stable UUID API kotlin.uuid.Uuid Common code has a stable Uuid, used for offline-first Room entities and multiplatform IDs. V4/V7 generation functions remai… |
| 2 | 0.453 | 0.204 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Quick Context: 2.3 is where we left off | Quick Context: 2.3 is where we left off Kotlin 2.3.0 was shipped on December 2025, and to be honest with you, it felt a little bit like getting stuff ready rel… |
| 3 | 0.448 | 0.157 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🔐 Stable Base64: Finally, Built-in Encoding That Works Everywhere | import kotlin.io.encoding.Base64 import kotlin.io.encoding.ExperimentalEncodingApi // Multiple encoding schemes for different use cases class SecureDataHandler … |
| 4 | 0.531 | 0.152 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | What Kotlin 2.4 Actually Delivers › Platform support: | Standard library: - Support for the unsupported UUID API, and implement support for checking order Platform support: - Kotlin/JVM : support for Java 26, anno… |
| 5 | 0.424 | 0.140 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium |  | Kotlin 2.4 vs Kotlin 2.3: What Actually Changed? AndroidLab by Andre3 min readSep 17, 2026 From experimental context parameters to stable features — here’s wh… |

<details><summary>Dropped candidates (40)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 41 | 0.423 | 0.083 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Should You Upgrade Right Now? |
| 33 | 0.449 | 0.068 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | TAKEAWAY: |
| 13 | 0.474 | 0.048 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Getting Started Without the Hype |
| 18 | 0.462 | 0.048 | Exploring Kotlin 1.9.0_ What’s New in the Latest Release _ by Nandhu Raj _ Stackademic |  |
| 45 | 0.404 | 0.030 | Exploring Kotlin 2.1.0_ New Features _ by youssef moti _ Medium | 3. Multi-Dollar String Interpolation |
| 44 | 0.404 | 0.027 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Why Should You Care About This in Your Codebase |
| 6 | 0.495 | 0.026 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium |  |
| 20 | 0.460 | 0.020 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What You Should Actually Share › Share This: |
| 17 | 0.463 | 0.018 | first-agent/src/store/conversationStore.js | UUID_V4 |
| 42 | 0.414 | 0.017 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | What Kotlin 2.4 Actually Delivers |
| 38 ✓ | 0.434 | 0.016 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | 10. Kotlin/Native and Multiplatform Polish |
| 11 | 0.484 | 0.013 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways |
| 21 | 0.460 | 0.012 | Kotlin 2.0.0_ A New Era in Kotlin Development _ by Halil Özel _ Medium | Conclusion ✅ |
| 39 | 0.433 | 0.011 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 💼 @JvmExposeBoxed: Finally, Seamless Java Interop |
| 7 | 0.491 | 0.011 | Kotlin 2.0.0_ A New Era in Kotlin Development _ by Halil Özel _ Medium | 3. Expanded Multiplatform Support 🎗️ |
| 22 | 0.459 | 0.010 | Exploring Kotlin 1.9.0_ What’s New in the Latest Release _ by Nandhu Raj _ Stackademic |  |
| 25 | 0.456 | 0.010 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Key priorities |
| 37 ✓ | 0.435 | 0.008 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | 5. Java 26 Support |
| 36 | 0.437 | 0.007 | Exploring Kotlin 2.1.0_ New Features _ by youssef moti _ Medium | 5. Kotlin Multiplatform Enhancements |
| 32 | 0.450 | 0.006 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  |
| 34 | 0.448 | 0.006 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium |  |
| 19 | 0.461 | 0.006 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 3. Backend Integration That Makes Sense |
| 14 | 0.474 | 0.006 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin Multiplatform IDE plugin › Support for Windows and Linux in the Kotlin Multiplatform IDE plugin |
| 23 | 0.457 | 0.005 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key takeaways: |
| 15 | 0.471 | 0.004 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | headline change headlined: Explicit Context Arguments Go Stable |
| 3 | 0.529 | 0.004 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  |
| 8 | 0.489 | 0.004 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 1. Sensible Native Interop That Plays Nice With You |
| 26 | 0.456 | 0.003 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Multiplatform Development Enhancements |
| 4 ✓ | 0.528 | 0.003 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | Key Takeaways |
| 9 | 0.487 | 0.002 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium |  |
| 10 | 0.485 | 0.002 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | The Real-World Impact |
| 28 | 0.453 | 0.001 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious |
| 31 | 0.450 | 0.001 | Exploring Kotlin 2.1.0_ New Features _ by youssef moti _ Medium | 6. Kotlin/Native Improvements |
| 30 | 0.452 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  |
| 12 | 0.476 | 0.000 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Quick Hits Worth Knowing |
| 27 | 0.453 | 0.000 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | But now name-based destructuring is as stable as well |
| 16 | 0.471 | 0.000 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium |  |
| 24 ✓ | 0.457 | 0.000 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | 7. Unsigned Integer → BigInteger Conversions |
| 5 | 0.510 | 0.000 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What You Should Actually Share › Keep Platform-Specific: |
| 43 ✓ | 0.409 | 0.000 | Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium | 2. Explicit Backing Fields |

</details>

## q16

**multi_part** — Which Compose Multiplatform release added type-safe navigation, and which one brought Navigation 3? What does each give me?

*Why:* Multi-part: two facts from the 1.7.0 post and two from the 1.10.0 post. A single query can find both, but both have to reach the final chunks; rewriting should split it into one query per release.

Expected sources: `Compose Multiplatform 1.7.0 Released - The JetBrains Blog`, `Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog`

### plain — score 0.13, hallucination

70 in · 310 out · 3.4 s · fail

> # Compose Multiplatform Navigation Features
> 
> ## Type-Safe Navigation
> 
> **Compose Multiplatform 1.5.0** (released August 2023) introduced **type-safe navigation** through the `androidx.navigation:navigation-compose` library integration.
> 
> **What it gives you:**
> - Compile-time safety for navigation routes
> - Type-safe argument passing between screens
> - Eliminates string-based route definitions
> - Catches navigation errors at compile time rather than runtime
> 
> ## Navigation 3
> 
> **Compose Multiplatform 1.6.0** (released November 2023) brought **Navigation 3** (part of Jetpack Navigation 2.7.0+).
> 
> **What it gives you:**
> - **Predictable back stack behavior** — more intuitive handling of navigation state
> - **Type-safe route definitions** — using Kotlin serialization instead of string routes
> - **Improved deep linking** — better support for complex navigation scenarios
> - **Better state management** — cleaner handling of navigation state across configuration changes
> - **Multiplatform support** — navigation works consistently across Android, iOS, Desktop, and Web
> 
> ## Key Difference
> 
> Navigation 3 is a more comprehensive upgrade that builds on type-safe navigation with better architecture and multiplatform consistency, while type-safe navigation (1.5.0) was the initial step toward eliminating string-based routes.

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform 1.7.0 added type-safe navigation, with compile-time safety in navigation graphs | contradicted | Answer states 1.5.0 added type-safe navigation, not 1.7.0 |
| It follows Jetpack Compose's type-safe approach to passing objects along a navigation route | partial | Answer mentions type-safe argument passing but doesn't explicitly reference following Jetpack Compose's approach |
| Compose Multiplatform 1.10.0 added support for Navigation 3 | contradicted | Answer states 1.6.0 brought Navigation 3, not 1.10.0 |
| Navigation 3 lets you manipulate the navigation stack directly | missing | Answer mentions back stack behavior and state management but not direct stack manipulation |

Hallucination: The answer provides specific version numbers (1.5.0 and 1.6.0) that contradict the expected facts (1.7.0 and 1.10.0). These are concrete claims that directly conflict with the expected facts.

### rag — score 1.00

1196 in · 256 out · 3.0 s · rank 1 · cited [2][4][1][3] · pass

> # Type-Safe Navigation vs Navigation 3
> 
> ## Type-Safe Navigation (Compose Multiplatform 1.7.0)
> 
> **Release:** Compose Multiplatform 1.7.0 added type-safe navigation [2][4]
> 
> **What it gives you:** Compile-time safety in navigation graphs. Compose Multiplatform adopted Jetpack Compose's type-safe approach to passing objects along a navigation route, so you can rely on type checking at compile time rather than runtime [2].
> 
> ## Navigation 3 (Compose Multiplatform 1.10.0)
> 
> **Release:** Compose Multiplatform 1.10.0 introduced Navigation 3 support [1][3]
> 
> **What it gives you:** A new library for managing navigation that allows you to manipulate your navigation stack directly, making tasks like adding or removing destinations more straightforward [1].
> 
> ---
> 
> In summary: version 1.7.0 focused on **type safety** for your navigation code, while version 1.10.0 brought a **new navigation library** (Navigation 3) with more direct control over the navigation stack.

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform 1.7.0 added type-safe navigation, with compile-time safety in navigation graphs | present | Answer correctly states 1.7.0 added type-safe navigation with compile-time safety in navigation graphs. |
| It follows Jetpack Compose's type-safe approach to passing objects along a navigation route | present | Answer explicitly mentions adopting Jetpack Compose's type-safe approach to passing objects along a navigation route. |
| Compose Multiplatform 1.10.0 added support for Navigation 3 | present | Answer correctly states Compose Multiplatform 1.10.0 introduced Navigation 3 support. |
| Navigation 3 lets you manipulate the navigation stack directly | present | Answer states Navigation 3 allows you to manipulate your navigation stack directly. |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.694 | — | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Navigation 3 | Navigation 3 We’ve introduced support for Navigation 3, a new library for managing navigation. With Navigation 3, you can manipulate your navigation stack dire… |
| 2 ✓ | 0.687 | — | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Type-safe navigation | Type-safe navigation You can now rely on Compose Multiplatform for compile-time safety in navigation graphs. To ensure type safety, we adopted Jetpack Compose’… |
| 3 ✓ | 0.626 | — | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.10.0: Unified @Preview, Navigation 3, and Stable Compose Hot Reload Compose Multiplatform 1.10.0 has been rele… |
| 4 ✓ | 0.592 | — | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.7.0 Released Compose Multiplatform is a declarative UI framework built by JetBrains that allows developers to … |
| 5 ✓ | 0.563 | — | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | New common modules | New common modules With Compose Multiplatform 1.7.0, the following components have become available in common code: - Material3 adaptive modules from material… |

### rag+rerank — score 1.00

1433 in · 229 out · 4.8 s · rank 1 · cited [1][3][2][5] · pass

> # Type-Safe Navigation and Navigation 3
> 
> ## Type-Safe Navigation (Compose Multiplatform 1.7.0)
> 
> **Release:** Compose Multiplatform 1.7.0 [1]
> 
> **What it gives you:** Compile-time safety for your navigation graph. It adopts Jetpack Compose's type-safe approach to passing objects along a navigation route. [3]
> 
> ## Navigation 3 (Compose Multiplatform 1.10.0)
> 
> **Release:** Compose Multiplatform 1.10.0 [2]
> 
> **What it gives you:** A new library for managing navigation that allows you to manipulate your navigation stack directly, making tasks like adding or removing destinations more straightforward. [5]
> 
> ---
> 
> In summary: Version 1.7.0 introduced type-safe navigation for compile-time safety, while version 1.10.0 brought Navigation 3, which offers more direct control over your navigation stack with a simpler API for common navigation tasks.

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform 1.7.0 added type-safe navigation, with compile-time safety in navigation graphs | present | Answer correctly states 1.7.0 added type-safe navigation with compile-time safety |
| It follows Jetpack Compose's type-safe approach to passing objects along a navigation route | present | Answer explicitly mentions adopting Jetpack Compose's type-safe approach |
| Compose Multiplatform 1.10.0 added support for Navigation 3 | present | Answer correctly identifies 1.10.0 as the release that brought Navigation 3 |
| Navigation 3 lets you manipulate the navigation stack directly | present | Answer states Navigation 3 allows you to manipulate your navigation stack directly |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.592 | 0.992 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.7.0 Released Compose Multiplatform is a declarative UI framework built by JetBrains that allows developers to … |
| 2 ✓ | 0.626 | 0.959 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.10.0: Unified @Preview, Navigation 3, and Stable Compose Hot Reload Compose Multiplatform 1.10.0 has been rele… |
| 3 ✓ | 0.687 | 0.926 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Type-safe navigation | Type-safe navigation You can now rely on Compose Multiplatform for compile-time safety in navigation graphs. To ensure type safety, we adopted Jetpack Compose’… |
| 4 | 0.498 | 0.825 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Everything you need to build apps for real-world use | Everything you need to build apps for real-world use Compose Multiplatform for iOS now includes everything you need to build beautiful UIs for real-world apps:… |
| 5 ✓ | 0.694 | 0.748 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Navigation 3 | Navigation 3 We’ve introduced support for Navigation 3, a new library for managing navigation. With Navigation 3, you can manipulate your navigation stack dire… |

<details><summary>Dropped candidates (15)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 10 | 0.497 | 0.515 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Make more ecosystem components available for Compose Multiplatform |
| 12 | 0.480 | 0.248 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native |
| 7 | 0.515 | 0.216 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile |
| 19 | 0.439 | 0.209 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways |
| 15 | 0.458 | 0.109 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  |
| 13 | 0.473 | 0.095 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious |
| 17 | 0.443 | 0.070 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog |  |
| 8 ✓ | 0.505 | 0.040 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Shared element transitions |
| 5 ✓ | 0.563 | 0.018 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | New common modules |
| 18 ✓ | 0.442 | 0.017 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Resources updates and improvements |
| 6 ✓ | 0.523 | 0.015 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload |
| 14 ✓ | 0.462 | 0.009 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Improved touch interop between Compose Multiplatform and native iOS |
| 16 | 0.448 | 0.007 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency |
| 20 | 0.439 | 0.003 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | Automatic font fallback for web |
| 11 ✓ | 0.496 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Common @Preview annotation |

</details>

### rag+rewrite+rerank — score 1.00

2376 in · 292 out · 6.3 s · rank 1 · cited [1][3][2][5] · pass

Queries searched: `Compose Multiplatform type-safe navigation release` · `Compose Multiplatform Navigation 3` · `Compose Multiplatform navigation features`

> # Type-Safe Navigation and Navigation 3
> 
> ## Type-Safe Navigation (Compose Multiplatform 1.7.0)
> 
> **Release:** Compose Multiplatform 1.7.0 [1]
> 
> **What it gives you:** Compile-time safety for your navigation graph. It adopts Jetpack Compose's type-safe approach to passing objects along a navigation route. [3]
> 
> ## Navigation 3 (Compose Multiplatform 1.10.0)
> 
> **Release:** Compose Multiplatform 1.10.0 [2]
> 
> **What it gives you:** A new library for managing navigation that allows you to manipulate your navigation stack directly, making tasks like adding or removing destinations more straightforward. [5]
> 
> ---
> 
> In summary: Version 1.7.0 introduced type-safe navigation for compile-time safety, while version 1.10.0 brought Navigation 3, which offers more direct control over your navigation stack with simpler manipulation of destinations.

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform 1.7.0 added type-safe navigation, with compile-time safety in navigation graphs | present | Answer correctly states 1.7.0 added type-safe navigation with compile-time safety |
| It follows Jetpack Compose's type-safe approach to passing objects along a navigation route | present | Answer explicitly mentions adopting Jetpack Compose's type-safe approach |
| Compose Multiplatform 1.10.0 added support for Navigation 3 | present | Answer correctly identifies 1.10.0 as the release that brought Navigation 3 |
| Navigation 3 lets you manipulate the navigation stack directly | present | Answer states Navigation 3 allows direct manipulation of the navigation stack |

Kept chunks:

| n | vector | rerank | source | section | text |
| ---: | ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.716 | 0.992 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.7.0 Released Compose Multiplatform is a declarative UI framework built by JetBrains that allows developers to … |
| 2 ✓ | 0.689 | 0.959 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.10.0: Unified @Preview, Navigation 3, and Stable Compose Hot Reload Compose Multiplatform 1.10.0 has been rele… |
| 3 ✓ | 0.777 | 0.926 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Type-safe navigation | Type-safe navigation You can now rely on Compose Multiplatform for compile-time safety in navigation graphs. To ensure type safety, we adopted Jetpack Compose’… |
| 4 | 0.627 | 0.825 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Everything you need to build apps for real-world use | Everything you need to build apps for real-world use Compose Multiplatform for iOS now includes everything you need to build beautiful UIs for real-world apps:… |
| 5 ✓ | 0.738 | 0.748 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Navigation 3 | Navigation 3 We’ve introduced support for Navigation 3, a new library for managing navigation. With Navigation 3, you can manipulate your navigation stack dire… |

<details><summary>Dropped candidates (20)</summary>

| vector rank | vector | rerank | source | section |
| ---: | ---: | ---: | --- | --- |
| 15 | 0.561 | 0.515 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Make more ecosystem components available for Compose Multiplatform |
| 9 | 0.606 | 0.248 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native |
| 7 | 0.618 | 0.216 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile |
| 25 | 0.477 | 0.209 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways |
| 8 | 0.617 | 0.109 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  |
| 20 | 0.545 | 0.095 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious |
| 14 | 0.569 | 0.070 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog |  |
| 11 ✓ | 0.588 | 0.040 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Shared element transitions |
| 17 | 0.558 | 0.019 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Release Compose Multiplatform for Web in Beta |
| 6 ✓ | 0.625 | 0.018 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | New common modules |
| 22 ✓ | 0.537 | 0.017 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Resources updates and improvements |
| 13 ✓ | 0.582 | 0.015 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload |
| 23 | 0.534 | 0.012 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Read more |
| 12 | 0.586 | 0.011 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt |
| 19 | 0.548 | 0.009 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Performance that’s ready for production |
| 10 ✓ | 0.591 | 0.009 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Improved touch interop between Compose Multiplatform and native iOS |
| 18 | 0.557 | 0.008 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What You Should Actually Share › Keep Platform-Specific: |
| 24 | 0.497 | 0.007 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency |
| 16 ✓ | 0.559 | 0.006 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Drag and drop on desktop |
| 21 ✓ | 0.541 | 0.000 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Common @Preview annotation |

</details>

## Appendix: the RAG user message for q01

Built by `buildRagPrompt(question, chunks)` in `src/rag/prompt.js`.

````text
<documents>
<doc n="1" source="knowledge_database/Compose Multiplatform 1.7.0 Released - The JetBrains Blog.html" section="Performance improvements on iOS" title="Compose Multiplatform 1.7.0 Released">
Performance improvements on iOS

In Kotlin 2.0.20, the Kotlin/Native team contributed significantly to making Compose apps on iOS perform faster and smoother. The Compose Multiplatform 1.7.0 release makes the best of these optimizations, along with performance improvements from Jetpack Compose 1.7.0.

We benchmarked Compose Multiplatform 1.6.11 paired with Kotlin 2.0.0 and Compose Multiplatform 1.7.0 paired with Kotlin 2.0.20, and the comparison shows the following improvements:

- The LazyGrid benchmark simulates LazyVerticalGrid scrolling, which is closest to real-life use cases, and performs ~9% faster on average. It also shows a significantly reduced number of missed frames. Take a look at the p1/p50 percentile graph below: It shows increased frame stability and confirms that there are now hardly any missed frames, as the average processing time is less than the standard 8.33 ms latency of a 120Hz iPhone screen.

- The VisualEffects benchmark renders many randomly placed components and works 3.6 times faster – the average CPU time per 1000 frames was reduced from 8.8 to 2.4 seconds.

- The AnimatedVisibility composable animates showing and hiding an image and demonstrates ~6% faster rendering.

Feel free to test it yourself and let us know whether your iOS app feels smoother!

On top of that, Kotlin 2.0.20 introduces experimental support for concurrent marking in the garbage collector (GC). Enabling concurrent marking shortens GC pauses and demonstrates even bigger improvements for all benchmarks. We measured only half as many missed frames as before, as well as a drop in the worst p25 GC pause time from 1.7 ms to 0.4 ms for the LazyGrid benchmark. Give it a try and share your feedback.

Update to Compose Multiplatform 1.7.0
</doc>
<doc n="2" source="knowledge_database/Compose Multiplatform 1.7.0 Released - The JetBrains Blog.html" section="" title="Compose Multiplatform 1.7.0 Released">
Multiplatform

Releases

Compose Multiplatform 1.7.0 Released

Compose Multiplatform is a declarative UI framework built by JetBrains that allows developers to share UI implementations across different platforms. The 1.7.0 release brings more components to common code, support for type-safe navigation, significant performance improvements on iOS, and changes from the latest Jetpack Compose update.

Here are the highlights of this release:

- Material3 adaptive and WindowSizeClass are now available in common code.

- Compose Multiplatform now provides compile-time safety for your navigation graph.

- Compose Multiplatform 1.7.0 paired with Kotlin 2.0.20 performs significantly faster and smoother on iOS than the combination of previous stable releases.

For the complete list of changes, refer to our What’s New page or release notes on GitHub.

Get Started with Compose Multiplatform
</doc>
<doc n="3" source="knowledge_database/Kotlin 2.4.20 Release_ What's New &amp; Why It Matters (2026) _ Medium.html" section="What Actually Changed › 2. Compose Multiplatform Gets Serious" title="Kotlin 2.3 Is Making Multiplatform Development Actually Work">
2. Compose Multiplatform Gets Serious

Multiplatform Jetpack Compose was also promising but also buggy. Compose for iOS is stabilized in Kotlin 2.3 with improvements performance wise that makes it usable:

- 60fps animations on older iPhones

- Native-feeling navigation without custom wrappers

- Non-memory leaking lifecycle handling

@Composable
fun ProfileScreen(viewModel: ProfileViewModel) {
    val state by viewModel.state.collectAsState()
    LazyColumn(
        modifier = Modifier.fillMaxSize()
    ) {
        item {
            ProfileHeader(
                user = state.user,
                onEditClick = { viewModel.editProfile() }
            )
        }
        items(state.posts) { post ->
            PostCard(post = post)
        }
    }
}

This will render the same on Android or iOS and without any platform check or conditional imports.
</doc>
<doc n="4" source="knowledge_database/Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog.html" section="Performance that’s ready for production" title="Compose Multiplatform 1.8.0 Released: Compose Multiplatform for iOS Is Stable and Production-Ready">
Performance that’s ready for production

A great user experience comes down to more than just UI behavior; it’s about performance, too. Smooth, responsive interactions are key to user satisfaction. That’s why performance was a core focus throughout this stabilization effort. With 1.8.0:

- Startup time is comparable to native apps, so your first frame arrives just as fast.

- Scrolling performance is on par with SwiftUI, even on high-refresh-rate devices.

- Compose Multiplatform adds only ~9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets.

You can find the benchmark project on GitHub. A detailed description of the methodology will be published soon at KMP Development portal.

And most importantly, this matches what developers are seeing in practice. According to our latest survey, over 96% of teams using Compose Multiplatform on iOS report no major performance concerns.
</doc>
<doc n="5" source="knowledge_database/Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium.html" section="Main Features" title="Kotlin 2.0.20: Major Update Brings Performance Improvements and Bug Fixes — Tech News">
Main Features

Kotlin 2.0.20 boasts concurrent marking for the garbage collector, which allows the marking phase to run simultaneously with application threads. This should significantly shorten GC pause times and improve overall application responsiveness.
</doc>
</documents>

Question: After moving to Compose Multiplatform 1.7 with Kotlin 2.0.20, how much faster did iOS rendering get in JetBrains' benchmarks, and did GC pauses improve too?
````
