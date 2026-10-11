# Local RAG eval (quick): 3 questions, `rag+rerank`, Claude vs local

Generated 2026-10-11T15:19:03.629Z by `npm run eval:local -- --quick` on Apple M2, 16 GB RAM. Raw results: [`local_rag_quick_results.json`](local_rag_quick_results.json).

**Where each call ran**

| stage | where | what |
| --- | --- | --- |
| retrieval | local | EmbeddingGemma vectors (doc_index), k_retrieve 20, strategy structural — once per question, cached in [`local_rag_retrieval.json`](local_rag_retrieval.json) |
| rerank | local | bge-reranker-v2-m3, cutoff 0.02, top 5 kept — the same cached run |
| generation | cloud | `claude-haiku-4-5-20251001`, forced tool use, streamed (for TTFT) — `submit_answer` / `submit_clarification`, temperature 0 |
| generation | local | `gemma4:12b` under Ollama 0.40.2, num_ctx 16384, num_predict ≤ 2048, JSON-schema output — `submit_answer` / `submit_clarification`, temperature 0 |
| judging | cloud | `claude-haiku-4-5-20251001`: faithfulness (claims + the quotes they cite) and Day 22's fact judge |

Every generator answers from the same chunks, through the same contract (markers, chunk_ids, verbatim quotes of 4–60 words, one retry with the errors, then drop or downgrade). Run order: Claude Haiku 4.5 → gemma4:12b, one model in memory at a time (each local model unloaded before the next loads).

## Summary

Shared retrieval cost (local, once): vector search 1.07 s mean · rerank 3.52 s mean (max 4.33 s) · 4.0 chunks kept on average · declined by the cutoff before any model call: 0.

| quality | Claude Haiku 4.5 (cloud) | gemma4:12b (local) |
| --- | --- | --- |
| answered with ≥ 1 source / valid citation | 1/1 · 1/1 | 1/1 · 1/1 |
| answerable questions answered (of 7) | 50% (1/2) | 50% (1/2) |
| fabricated quotes on the first attempt | 0 of 2 | 0 of 1 |
| first attempt valid | 3/3 | 2/3 |
| retries · dropped citations · downgrades | 0 (0 fixed) · 0 · 0 | 1 (1 fixed) · 0 · 0 |
| invalid JSON / schema failures | n/a (tool use) | 0 of 4 calls · 0 |
| faithfulness (supported / partial / unsupported) | 1.00 · 2 / 0 / 0 | 1.00 · 2 / 0 / 0 |
| uncited claims | 0 | 0 |
| correct "I don't know" · false "I don't know" | 1/1 · q14 (model) | 1/1 · q14 (model) |
| mean fact score (7 answerable) | 0.17 | 0.25 |
| errors | 0 | 0 |

| speed | Claude Haiku 4.5 (cloud) | gemma4:12b (local) |
| --- | --- | --- |
| time to first token (≈ prompt processing) | 0.81 s | 24.8 s |
| generation tokens/s | 132.2 | 11.0 |
| answer latency incl. retry: mean · max | 2.36 s · 3.73 s | 41.8 s · 69.2 s |
| prompt tokens · output tokens (mean per question) | 2744 · 200 | 2435 · 187 |
| model load time | n/a (cloud) | 10.0 s |
| possible truncations | 0 | 0 |
| memory in use (/api/ps: total · in GPU) | n/a (cloud) | 9.3 GB · 9.3 GB · ctx 16384 |
| first half → second half: tok/s · latency | 131.1 → 134.3 · 2.60 s → 1.86 s | 11.1 → 10.7 · 46.3 s → 32.8 s |

TTFT: for a local model, Ollama's load + prompt-evaluation time of the first answer call (non-streaming, so this is its own account of everything before the first token); for Claude, the time to the first streamed token, network included. Latency: the generator's own time for the question — the answer call with its retry, or the clarifying call — without the shared retrieval.

## Per question

| id | type | Claude Haiku 4.5 | gemma4:12b |
| --- | --- | --- | --- |
| [q02](#q02) | corpus | answered · 5/5 · 3.73 s | answered · 5/5 · 69.2 s |
| [q10](#q10) | unanswerable | IDK (model) · 1/1 · 1.86 s | IDK (model) · 1/1 · 32.8 s |
| [q14](#q14) | paraphrased | IDK (model) · 0/3 · 1.47 s | IDK (model) · 0/3 · 23.4 s |

Cells: status · checks passed (has sources, has citations, quotes are real, meaning matches citations, correct "I don't know") · answer latency.

## q02

**corpus** — Is Compose Multiplatform for iOS production-ready yet, and how much does it add to app size compared with a pure SwiftUI app?

Shared retrieval: 1.39 s search · 4.10 s rerank · 5 chunk(s)

1. 0.999 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Performance that’s ready for production · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:3`
2. 0.970 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:0`
3. 0.962 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Production-ready and easy to adopt · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:5`
4. 0.827 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Everything you need to build apps for real-world use · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:1`
5. 0.783 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Apps that feel truly native · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:2`

### q02 · Claude Haiku 4.5

Status **answered** · verified · checks 5/5 · run #1 at 15:16:25 · TTFT 0.98 s · 126.3 tok/s · latency 3.73 s · 3174 prompt / 347 output tokens

> Yes, Compose Multiplatform for iOS is production-ready. [c1] Compose Multiplatform adds only ~9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets. [c2]

- **[c1]** "the release of Compose Multiplatform 1.8.0, which brings Compose for iOS to Stable" — Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog
- **[c2]** "Compose Multiplatform adds only ~9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets." — Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Performance that’s ready for production

Faithfulness 1.00 (2 supported, 0 partial, 0 unsupported)

Fact score 0.33: missing — Compose Multiplatform 1.8.0 made Compose for iOS Stable; present — It adds only about 9 MB to an iOS app compared with a native SwiftUI app; missing — Over 96% of teams using it on iOS report no major performance concerns

### q02 · gemma4:12b

Status **answered** · retried → verified · checks 5/5 · run #4 at 15:16:45 · TTFT 33.4 s · 13.0 tok/s · latency 69.2 s · 4340 prompt / 411 output tokens

> Compose Multiplatform for iOS is now stable and production-ready [c2]. It adds only about 9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets [c1].

- **[c1]** "Compose Multiplatform adds only ~9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets." — Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Performance that’s ready for production
- **[c2]** "Today marks a major milestone in the Kotlin Multiplatform journey: the release of Compose Multiplatform 1.8.0, which brings Compose for iOS to Stable." — Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog

First-attempt errors:

- Rule 2: the answer uses [c2], but there is no citation with id c2.

Faithfulness 1.00 (2 supported, 0 partial, 0 unsupported)

Fact score 0.50: partial — Compose Multiplatform 1.8.0 made Compose for iOS Stable; present — It adds only about 9 MB to an iOS app compared with a native SwiftUI app; missing — Over 96% of teams using it on iOS report no major performance concerns

## q10

**unanswerable** (should be "I don't know") — What were the headline features of Compose Multiplatform 1.9.0?

Shared retrieval: 0.09 s search · 2.14 s rerank · 5 chunk(s)

1. 0.726 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Everything you need to build apps for real-world use · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:1`
2. 0.500 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Apps that feel truly native · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:2`
3. 0.469 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Production-ready and easy to adopt · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:5`
4. 0.463 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Compose Multiplatform beyond mobile · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:6`
5. 0.307 · Compose Multiplatform 1.7.0 Released - The JetBrains Blog · `kb/compose-multiplatform-1.7.0-released-the-jetbrains-blog.html:structural:0`

### q10 · Claude Haiku 4.5

Status **dont_know** (model) · verified · checks 1/1 · run #3 at 15:16:30 · TTFT 0.81 s · 134.3 tok/s · latency 1.86 s · 3135 prompt / 141 output tokens

> I don't know. The documents cover Compose Multiplatform versions 1.7.0 and 1.8.0, but do not contain information about version 1.9.0. Do you have documents about Compose Multiplatform 1.9.0?

### q10 · gemma4:12b

Status **dont_know** (model) · verified · checks 1/1 · run #6 at 15:18:18 · TTFT 25.9 s · 10.7 tok/s · latency 32.8 s · 2008 prompt / 73 output tokens

> I don't know. The provided documents only contain information regarding versions 1.7.0 and 1.8.0 of Compose Multiplatform. Could you provide information regarding version 1.9.0?

## q14

**paraphrased** — In JetBrains' cross-platform UI toolkit, can people using my app on a Windows or Mac computer grab an element with the mouse, carry it across and let go of it over another element? Which version brought that, and what do I attach to the two elements?

Shared retrieval: 1.74 s search · 4.33 s rerank · 2 chunk(s)

1. 0.055 · Compose Multiplatform 1.7.0 Released - The JetBrains Blog · `kb/compose-multiplatform-1.7.0-released-the-jetbrains-blog.html:structural:0`
2. 0.030 · Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog › The Ship Kotlin Everywhere Award · `kb/know-kotlin-ship-it-everywhere-and-win-at-shipaton-2026-the-jetbrains-blog.html:structural:1`

### q14 · Claude Haiku 4.5

Status **dont_know** (model) · verified · checks 0/3 · run #2 at 15:16:29 · TTFT 0.65 s · 135.9 tok/s · latency 1.47 s · 1923 prompt / 112 output tokens

> I don't know. Do the documents discuss drag-and-drop functionality in Compose Multiplatform, or what specific features were added in different versions?

Fact score 0.00: missing — Compose Multiplatform 1.7.0 added drag and drop on desktop; missing — The dragAndDropSource modifier marks the composable where a drag starts; missing — The dragAndDropTarget modifier marks the composable that accepts the dropped data

### q14 · gemma4:12b

Status **dont_know** (model) · verified · checks 0/3 · run #5 at 15:17:55 · TTFT 15.1 s · 9.2 tok/s · latency 23.4 s · 956 prompt / 76 output tokens

> I don't know. The provided documents discuss the release of Compose Multiplatform 1.7.0 and the Ship Kotlin Everywhere Award, but they do not contain information regarding drag-and-drop functionality, specific UI element interactions, or the technical implementation of attaching items to elements.

Fact score 0.00: missing — Compose Multiplatform 1.7.0 added drag and drop on desktop; missing — The dragAndDropSource modifier marks the composable where a drag starts; missing — The dragAndDropTarget modifier marks the composable that accepts the dropped data

## Run order

| # | started (UTC) | generator | question | answer latency | tok/s | TTFT |
| ---: | --- | --- | --- | ---: | ---: | ---: |
| 1 | 15:16:25 | Claude Haiku 4.5 | q02 | 3.73 s | 126.3 | 0.98 s |
| 2 | 15:16:29 | Claude Haiku 4.5 | q14 | 1.47 s | 135.9 | 0.65 s |
| 3 | 15:16:30 | Claude Haiku 4.5 | q10 | 1.86 s | 134.3 | 0.81 s |
| 4 | 15:16:45 | gemma4:12b | q02 | 69.2 s | 13.0 | 33.4 s |
| 5 | 15:17:55 | gemma4:12b | q14 | 23.4 s | 9.2 | 15.1 s |
| 6 | 15:18:18 | gemma4:12b | q10 | 32.8 s | 10.7 | 25.9 s |
