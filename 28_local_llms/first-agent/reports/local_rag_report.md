# Local RAG eval: 10 questions, `rag+rerank`, Claude vs local

Generated 2026-10-11T15:35:50.279Z by `npm run eval:local` on Apple M2, 16 GB RAM. Raw results: [`local_rag_results.json`](local_rag_results.json).

**Where each call ran**

| stage | where | what |
| --- | --- | --- |
| retrieval | local | EmbeddingGemma vectors (doc_index), k_retrieve 20, strategy structural — once per question, cached in [`local_rag_retrieval.json`](local_rag_retrieval.json) |
| rerank | local | bge-reranker-v2-m3, cutoff 0.02, top 5 kept — the same cached run |
| generation | cloud | `claude-haiku-4-5-20251001`, forced tool use, streamed (for TTFT) — `submit_answer` / `submit_clarification`, temperature 0 |
| generation | local | `gemma4:12b` under Ollama 0.40.2, num_ctx 16384, num_predict ≤ 2048, JSON-schema output — `submit_answer` / `submit_clarification`, temperature 0 |
| generation | local | `qwen3.5:9b` under Ollama 0.40.2, num_ctx 16384, num_predict ≤ 2048, JSON-schema output — `submit_answer` / `submit_clarification`, temperature 0 |
| judging | cloud | `claude-haiku-4-5-20251001`: faithfulness (claims + the quotes they cite) and Day 22's fact judge |

Every generator answers from the same chunks, through the same contract (markers, chunk_ids, verbatim quotes of 4–60 words, one retry with the errors, then drop or downgrade). Run order: Claude Haiku 4.5 → gemma4:12b → qwen3.5:9b, one model in memory at a time (each local model unloaded before the next loads).

## Summary

Shared retrieval cost (local, once): vector search 0.52 s mean · rerank 4.08 s mean (max 7.20 s) · 4.2 chunks kept on average · declined by the cutoff before any model call: 1: q13.

| quality | Claude Haiku 4.5 (cloud) | gemma4:12b (local) | qwen3.5:9b (local) |
| --- | --- | --- | --- |
| answered with ≥ 1 source / valid citation | 6/6 · 6/6 | 6/6 · 6/6 | 5/5 · 5/5 |
| answerable questions answered (of 7) | 86% (6/7) | 86% (6/7) | 71% (5/7) |
| fabricated quotes on the first attempt | 2 of 15 | 1 of 12 | 1 of 13 |
| first attempt valid | 7/9 | 5/9 | 8/9 |
| retries · dropped citations · downgrades | 2 (2 fixed) · 0 · 0 | 4 (4 fixed) · 0 · 0 | 1 (0 fixed) · 1 · 0 |
| invalid JSON / schema failures | n/a (tool use) | 0 of 14 calls · 0 | 0 of 11 calls · 0 |
| faithfulness (supported / partial / unsupported) | 0.86 · 14 / 3 / 0 | 0.74 · 12 / 4 / 1 | 0.53 · 6 / 4 / 0 |
| uncited claims | 9 | 0 | 0 |
| correct "I don't know" · false "I don't know" | 3/3 · q14 (model) | 3/3 · q14 (model) | 3/3 · q12 (model), q14 (model) |
| mean fact score (7 answerable) | 0.76 | 0.74 | 0.66 |
| errors | 0 | 0 | 0 |

| speed | Claude Haiku 4.5 (cloud) | gemma4:12b (local) | qwen3.5:9b (local) |
| --- | --- | --- | --- |
| time to first token (≈ prompt processing) | 0.71 s | 25.1 s | 15.3 s |
| generation tokens/s | 129.3 | 11.8 | 16.1 |
| answer latency incl. retry: mean · max | 3.88 s · 7.95 s | 52.9 s · 98.1 s | 28.9 s · 50.7 s |
| prompt tokens · output tokens (mean per question) | 3526 · 392 | 2764 · 326 | 1966 · 226 |
| model load time | n/a (cloud) | 7.44 s | 6.13 s |
| possible truncations | 0 | 0 | 0 |
| memory in use (/api/ps: total · in GPU) | n/a (cloud) | 15.2 GB · 15.2 GB · ctx 16384 | 9.6 GB · 9.6 GB · ctx 16384 |
| first half → second half: tok/s · latency | 130.7 → 128.0 · 4.91 s → 2.85 s | 12.7 → 10.8 · 52.4 s → 53.5 s | 16.3 → 15.8 · 34.4 s → 23.5 s |

TTFT: for a local model, Ollama's load + prompt-evaluation time of the first answer call (non-streaming, so this is its own account of everything before the first token); for Claude, the time to the first streamed token, network included. Latency: the generator's own time for the question — the answer call with its retry, or the clarifying call — without the shared retrieval.

## Per question

| id | type | Claude Haiku 4.5 | gemma4:12b | qwen3.5:9b |
| --- | --- | --- | --- | --- |
| [q02](#q02) | corpus | answered · 5/5 · 3.44 s | answered · 5/5 · 66.1 s | answered · 5/5 · 36.4 s |
| [q04](#q04) | corpus | answered · 5/5 · 7.95 s | answered · 4/5 · 44.4 s | answered · 4/5 · 41.1 s |
| [q06](#q06) | corpus | answered · 4/5 · 6.82 s | answered · 4/5 · 74.0 s | answered · 3/5 · 50.7 s |
| [q10](#q10) | unanswerable | IDK (model) · 1/1 · 1.68 s | IDK (model) · 1/1 · 32.6 s | IDK (model) · 1/1 · 21.1 s |
| [q12](#q12) | near_miss | answered · 4/5 · 4.68 s | answered · 4/5 · 45.0 s | IDK (model) · 0/3 · 22.9 s |
| [q13](#q13) | off_topic | IDK (low_relevance) · 1/1 · 1.13 s | IDK (low_relevance) · 1/1 · 11.2 s | IDK (low_relevance) · 1/1 · 8.05 s |
| [q14](#q14) | paraphrased | IDK (model) · 0/3 · 1.42 s | IDK (model) · 0/3 · 15.6 s | IDK (model) · 0/3 · 11.7 s |
| [q15](#q15) | messy | answered · 5/5 · 4.44 s | answered · 5/5 · 78.2 s | answered · 5/5 · 24.8 s |
| [q16](#q16) | multi_part | answered · 4/5 · 5.40 s | answered · 4/5 · 98.1 s | answered · 4/5 · 36.4 s |
| [q17](#q17) | ambiguous | IDK (model) · 1/1 · 1.86 s | IDK (model) · 1/1 · 64.2 s | IDK (model) · 1/1 · 36.3 s |

Cells: status · checks passed (has sources, has citations, quotes are real, meaning matches citations, correct "I don't know") · answer latency.

## Findings

From the run on 2026-10-11 (MacBook Air M2, 16 GB, Ollama 0.40.2, MLX runner). There were 10 `citations` questions in `rag+rerank`. Generators ran one at a time: Claude Haiku 4.5, then gemma4:12b, then qwen3.5:9b. All three answered from the same cached chunks. Samples are small (6–7 answered questions per generator, 10–17 judged claims), so a difference of one question is one question, not a trend.

**1. The JSON-schema path is not where local models lose.** Every structured call came back as valid JSON for its schema on the first try: 0 of 14 (gemma) and 0 of 11 (qwen), with no schema failures and no truncation. Ollama's `format` constrains decoding, so the JSON shape is enforced. The *content* inside the shape isn't. gemma filled the citation `id` field with the chunk_id (`kb/…:structural:0` instead of `c1`) on q15 and q16, and wrote no `[cN]` markers. On q02 it used a marker `[c2]` with no matching citation. These are contract errors, not JSON errors, and the single retry fixed all four (gemma: 5/9 first attempts valid, 4 retries, 4 fixed). qwen's first attempts were the cleanest of the three (8/9 valid, Claude 7/9).

**2. Quotes: the same trap for all three, and only Claude and gemma got out of it.** On q06 every generator joined two separate lines of the chunk ("Enable context parameters with -Xcontext-parameters" / "Try context-sensitive resolution with …") into one quote. That's the fabricated quote on the first attempt in each column (Claude 2 of 15 quotes, gemma 1 of 12, qwen 1 of 13). Claude and gemma fixed it on the retry. qwen's retry kept the joined quote, so verification dropped that citation and the sentence it supported. That sentence held the answer: the remaining text was a side fact about Latin-1 strings with the wrong number (30% from a blog post instead of the 50% in the expected facts). This one question accounts for most of qwen's fact-score gap (q06: 0.13 vs 1.00 for both others). The contract worked as designed: it removed the unsupported quote instead of showing it. The cost was a weaker answer.

**3. Declines: right on the 3 to decline, but qwen is more cautious.** All three gave the correct "I don't know" on q10 (1.9.0 isn't in the index), q13 (off-topic, rejected by the rerank cutoff before any model call) and q17 (ambiguous). All three also declined q14. That's a retrieval miss, not a generation one: the rerank kept two weakly related chunks (0.055, 0.03), and Day 24's Claude run declined it too. qwen also declined q12 (Web is Beta: can I ship to production?). The chunks say early adopters can move to production with the Beta, but qwen answered that they "do not explicitly confirm" it. That's a false "I don't know" from over-reading the rule against stretching loosely related text. Claude and gemma answered q12.

**4. Faithfulness numbers favour long-sentence writers less than they look.** qwen's 0.53 comes from 10 claims, none *unsupported*: 6 supported, 4 partial. The partials are long sentences carrying two markers where the judge wanted the version number in the quote itself, not only in the document title (q16: fact score 1.00, faithfulness 0.00). gemma had the only `unsupported` claim ("Navigation 3 was introduced in 1.10.0", with a quote that doesn't name the version). Both local models had 0 uncited claims; Claude had 9, mostly lead-in and wrap-up sentences that restate facts cited elsewhere in the same answer (q15 alone has 4, e.g. "So for your notes app: you can use the stable `kotlin.uuid.Uuid` type…"). The contract checks markers that are present; it doesn't force a marker on every sentence. Read the faithfulness row with the claim counts next to it.

**5. Where the time goes: reading the prompt, not writing the answer.** The shared retrieval is cheap and local: 0.5 s vector search and 4.1 s rerank on average (the reranker is the slow part, up to 7.2 s). Generation is where the models differ:
- **TTFT.** It is load + prompt evaluation, since the model is already warm. qwen took 15.3 s and gemma 25.1 s for prompts of about 2k tokens: roughly 125 tok/s (qwen) and 80 tok/s (gemma) of prompt processing. Claude's first streamed token arrived in 0.7 s.
- **Writing.** Generation ran at 16.1 tok/s (qwen) and 11.8 tok/s (gemma), against Claude's 129.
- **Per question,** that's 28.9 s mean / 50.7 s max for qwen, 52.9 s / 98.1 s for gemma, and 3.9 s / 8.0 s for Claude.
- **Retries.** A contract retry re-sends the whole prompt plus the first answer. That's why gemma's retried questions are the slowest: q16 had 4.3k prompt tokens and 976 output tokens across two calls, 98 s.

**6. Memory and thermals.**
- **Memory.** At `num_ctx` 16384, `/api/ps` reported **15.2 GB** for gemma4:12b and **9.6 GB** for qwen3.5:9b once real prompts had run. Right after loading it showed 7.7 GB, so the KV cache grows with use. gemma at this window takes nearly all of the 16 GB machine, which leaves no room for the reranker or anything else.
- **Run order.** The run was Claude → gemma → qwen.
- **gemma (thermals).** Its generation rate fell from 12.7 tok/s in its first five questions to 10.8 in its last five (−15%). Its last question (q17, 3k-token prompt) evaluated the prompt at about 57 tok/s, against about 80 earlier. That points to throttling or memory pressure, or both.
- **qwen (thermals).** qwen, which ran right after gemma, held steady: 16.3 → 15.8 tok/s (−3%). Its second-half latency dropped only because those questions were shorter.
- **Claude** didn't change (131 → 128 tok/s, cloud).

**7. In a real chat (`verify:local`, 3 RAG turns per model), the router is the weak link.** The run made 0 non-localhost requests and 0 calls to the Claude provider, and every call was local. It still ended FAIL, 80/83 checks, on three RAG checks:
- **gemma4:12b, turn 2** ("keep answers to 3 sentences; CMP means Compose Multiplatform"): the router sent this rule-setting message to `search` instead of `memory_only` and wrote no memory patch. The answer was "I don't know" plus a question asking what to look up, so the check "search turns have verified citations" failed. It stored both rules a turn late, on turn 3.
- **qwen3.5:9b, turn 2:** routed correctly to `memory_only` and replied "Got it…", but it returned an **empty memory patch**, so the task memory never held the CMP term. Turn 3 still resolved "CMP" to "Compose Multiplatform", from the recent messages rather than the memory, so the check "relies on the task memory" failed. The answer itself was right (~9 MB, cited).
- **qwen3.5:9b, turn 1:** 2 of its 3 citations failed again after the retry (a quote not in its chunk, an unused citation) and were dropped. The reply kept one verified citation plus an uncited first sentence. The check requires no leftover verification errors, so it failed. Nothing unverified was shown.

**8. Chat-turn times, measured.** A RAG turn means the router, then retrieval and rerank, then the answer.
- **qwen3.5:9b:** 103 s, 19 s (memory only) and 54 s; the router alone took 8–19 s.
- **gemma4:12b:** 248 s, 238 s and 96 s; its router took 138–175 s on the first two turns. Those turns ran with the embedding model and the reranker loaded in the same process, next to gemma's 15 GB at a 16k window. The machine was out of memory headroom. The first RAG turn also reloads the model, because `num_ctx` changes from the plain chat's 8192 to 16384.

**9. Is local usable for this task?**
- **qwen3.5:9b: yes, for a patient or offline user.** It keeps the same safety properties: every displayed quote is verified, no JSON was invalid, and the declines are correct. It is somewhat less complete (fact score 0.66 vs 0.76, one extra false "I don't know"), and its router under-uses the task memory. Expect 20–100 s per chat turn, against about 5–10 s with Claude.
- **gemma4:12b: no, on this machine.** It answers about as well as Claude in isolation (0.74 vs 0.76), but it's about twice as slow as qwen, needs a retry on almost half the answers, fills the RAM at a 16k window, and makes multi-minute chat turns.
- **The bar didn't move.** No rule was loosened for the local models: the gap shows up as dropped citations, declines and missed memory updates, not as unverified quotes on screen.

## q02

**corpus** — Is Compose Multiplatform for iOS production-ready yet, and how much does it add to app size compared with a pure SwiftUI app?

Shared retrieval: 1.39 s search · 4.10 s rerank · 5 chunk(s)

1. 0.999 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Performance that’s ready for production · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:3`
2. 0.970 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:0`
3. 0.962 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Production-ready and easy to adopt · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:5`
4. 0.827 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Everything you need to build apps for real-world use · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:1`
5. 0.783 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Apps that feel truly native · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:2`

### q02 · Claude Haiku 4.5

Status **answered** · verified · checks 5/5 · run #1 at 15:19:50 · TTFT 0.74 s · 128.5 tok/s · latency 3.44 s · 3174 prompt / 347 output tokens

> Yes, Compose Multiplatform for iOS is production-ready. [c1] Compose Multiplatform adds only ~9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets. [c2]

- **[c1]** "the release of Compose Multiplatform 1.8.0, which brings Compose for iOS to Stable" — Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog
- **[c2]** "Compose Multiplatform adds only ~9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets." — Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Performance that’s ready for production

Faithfulness 1.00 (2 supported, 0 partial, 0 unsupported)

Fact score 0.33: missing — Compose Multiplatform 1.8.0 made Compose for iOS Stable; present — It adds only about 9 MB to an iOS app compared with a native SwiftUI app; missing — Over 96% of teams using it on iOS report no major performance concerns

### q02 · gemma4:12b

Status **answered** · retried → verified · checks 5/5 · run #11 at 15:20:37 · TTFT 32.4 s · 14.0 tok/s · latency 66.1 s · 4340 prompt / 411 output tokens

> Compose Multiplatform for iOS is now stable and production-ready [c2]. It adds only about 9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets [c1].

- **[c1]** "Compose Multiplatform adds only ~9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets." — Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Performance that’s ready for production
- **[c2]** "Today marks a major milestone in the Kotlin Multiplatform journey: the release of Compose Multiplatform 1.8.0, which brings Compose for iOS to Stable." — Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog

First-attempt errors:

- Rule 2: the answer uses [c2], but there is no citation with id c2.

Faithfulness 1.00 (2 supported, 0 partial, 0 unsupported)

Fact score 0.50: partial — Compose Multiplatform 1.8.0 made Compose for iOS Stable; present — It adds only about 9 MB to an iOS app compared with a native SwiftUI app; missing — Over 96% of teams using it on iOS report no major performance concerns

### q02 · qwen3.5:9b

Status **answered** · verified · checks 5/5 · run #21 at 15:29:33 · TTFT 19.8 s · 16.5 tok/s · latency 36.4 s · 1974 prompt / 273 output tokens

> Compose Multiplatform for iOS is now stable and production-ready [c2]. Compared to a fully native SwiftUI app with the same UI logic and assets, Compose Multiplatform adds only about 9 MB to the size of an iOS app [c1].

- **[c1]** "Compose Multiplatform adds only ~9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets." — Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Performance that’s ready for production
- **[c2]** "Today marks a major milestone in the Kotlin Multiplatform journey: the release of Compose Multiplatform 1.8.0, which brings Compose for iOS to Stable." — Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog

Faithfulness 1.00 (2 supported, 0 partial, 0 unsupported)

Fact score 0.50: partial — Compose Multiplatform 1.8.0 made Compose for iOS Stable; present — It adds only about 9 MB to an iOS app compared with a native SwiftUI app; missing — Over 96% of teams using it on iOS report no major performance concerns

## q04

**corpus** — Can an AI coding agent work with my running Compose app through hot reload? What exactly can it do there?

Shared retrieval: 1.50 s search · 5.58 s rerank · 5 chunk(s)

1. 0.999 · Compose Multiplatform 1.12.0 Released - The JetBrains Blog › MCP server for AI agents in Compose Hot Reload · `kb/compose-multiplatform-1.12.0-released-the-jetbrains-blog.html:structural:1`
2. 0.649 · Compose Multiplatform 1.12.0 Released - The JetBrains Blog · `kb/compose-multiplatform-1.12.0-released-the-jetbrains-blog.html:structural:0`
3. 0.446 · Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog › Compose Hot Reload · `kb/compose-multiplatform-1.10.0-unified-preview-navigation-3-and-stable-compose-hot-reload-the-jetbrains-blog.html:structural:3`
4. 0.392 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Development tools that boost your efficiency · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:4`
5. 0.025 · What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog › Kotlin Multiplatform IDE plugin › Support for Windows and Linux in the Kotlin Multiplatform IDE plugin · `kb/what-s-next-for-kotlin-multiplatform-and-compose-multiplatform-august-2025-update-the-jetbrains-blog.html:structural:6`

### q04 · Claude Haiku 4.5

Status **answered** · retried → verified · checks 5/5 · run #2 at 15:19:53 · TTFT 0.65 s · 135.6 tok/s · latency 7.95 s · 6038 prompt / 883 output tokens

> Yes, an AI coding agent can work with your running Compose app through hot reload. [c1] Compose Hot Reload now ships with an experimental Model Context Protocol (MCP) server that connects AI coding agents to your running application.
> 
> Here's what the agent can do:
> 
> [c2] Using the MCP server, an agent can trigger reloads, take screenshots, inspect the semantic tree, simulate clicks and text input, and read application logs. [c3] The agent can verify the results of its own edits, confirm that the reload succeeded, inspect the rendered UI, catch a runtime exception, and iterate – all without you describing what's on screen.

- **[c1]** "Compose Hot Reload now ships with an experimental Model Context Protocol (MCP) server that connects AI coding agents to your running application." — Compose Multiplatform 1.12.0 Released - The JetBrains Blog › MCP server for AI agents in Compose Hot Reload
- **[c2]** "Using the MCP server, an agent can trigger reloads, take screenshots, inspect the semantic tree, simulate clicks and text input, and read application logs." — Compose Multiplatform 1.12.0 Released - The JetBrains Blog › MCP server for AI agents in Compose Hot Reload
- **[c3]** "It can confirm that the reload succeeded, inspect the rendered UI, catch a runtime exception, and iterate – all without you describing what's on screen." — Compose Multiplatform 1.12.0 Released - The JetBrains Blog › MCP server for AI agents in Compose Hot Reload

First-attempt errors:

- Rule 5: citation c2's quote is 62 words; it must be 4–60 (one or two whole sentences).

Faithfulness 1.00 (2 supported, 0 partial, 0 unsupported) · uncited: Compose Hot Reload now ships with an experimental Model Context Protocol (MCP) server that connects AI coding agents to your running application.

Fact score 1.00: present — Compose Hot Reload ships an experimental MCP (Model Context Protocol) server for AI agents; present — The agent can trigger reloads and take screenshots; present — It can inspect the semantic tree and simulate clicks and text input; present — It can read the application logs

### q04 · gemma4:12b

Status **answered** · verified · checks 4/5 · run #12 at 15:21:43 · TTFT 26.4 s · 12.4 tok/s · latency 44.4 s · 1683 prompt / 223 output tokens

> Yes, an AI coding agent can connect to your running application using the experimental Model Context Protocol (MCP) server included in Compose Hot Reload [c1]. This allows the agent to perform several actions, including triggering reloads, taking screenshots, reading application logs, and inspecting the semantic tree [c1]. Additionally, the agent can simulate clicks and text input, which enables it to verify its own edits by confirming successful reloads, inspecting the rendered UI, and catching runtime exceptions [c1].

- **[c1]** "Compose Hot Reload now ships with an experimental Model Context Protocol (MCP) server that connects AI coding agents to your running application. Using the MCP server, an agent can trigger reloads, take screenshots, inspect the semantic tree, simulate clicks and text input, and read application logs." — Compose Multiplatform 1.12.0 Released - The JetBrains Blog › MCP server for AI agents in Compose Hot Reload

Faithfulness 0.67 (2 supported, 1 partial, 0 unsupported)

- partial: Additionally, the agent can simulate clicks and text input, which enables it to verify its own edits by confirming successful reloads, inspecting the rendered UI, and catching runtime exceptions. — Quote supports that agent can simulate clicks and text input, but does not state that this enables verification of edits by confirming reloads, inspecting UI, or catching exceptions.

Fact score 1.00: present — Compose Hot Reload ships an experimental MCP (Model Context Protocol) server for AI agents; present — The agent can trigger reloads and take screenshots; present — It can inspect the semantic tree and simulate clicks and text input; present — It can read the application logs

### q04 · qwen3.5:9b

Status **answered** · verified · checks 4/5 · run #22 at 15:30:09 · TTFT 16.6 s · 18.9 tok/s · latency 41.1 s · 1647 prompt / 462 output tokens

> Yes, an AI coding agent can work with a running Compose app through hot reload using an experimental Model Context Protocol (MCP) server. [c1] Through this MCP server, the agent can trigger reloads, take screenshots, inspect the semantic tree, simulate clicks and text input, and read application logs. [c2][c3] In practice, this allows the agent to verify the results of its own edits by confirming that a reload succeeded, inspecting the rendered UI, catching runtime exceptions, and iterating without needing a description of what is on screen. [c4]

- **[c1]** "Compose Hot Reload now ships with an experimental Model Context Protocol (MCP) server that connects AI coding agents to your running application." — Compose Multiplatform 1.12.0 Released - The JetBrains Blog › MCP server for AI agents in Compose Hot Reload
- **[c2]** "Using the MCP server, an agent can trigger reloads, take screenshots, inspect the semantic tree, simulate clicks and text input, and read application logs." — Compose Multiplatform 1.12.0 Released - The JetBrains Blog › MCP server for AI agents in Compose Hot Reload
- **[c3]** "In practice, this means the agent can verify the results of its own edits." — Compose Multiplatform 1.12.0 Released - The JetBrains Blog › MCP server for AI agents in Compose Hot Reload
- **[c4]** "It can confirm that the reload succeeded, inspect the rendered UI, catch a runtime exception, and iterate – all without you describing what’s on screen." — Compose Multiplatform 1.12.0 Released - The JetBrains Blog › MCP server for AI agents in Compose Hot Reload

Faithfulness 0.67 (2 supported, 1 partial, 0 unsupported)

- partial: In practice, this allows the agent to verify the results of its own edits by confirming that a reload succeeded, inspecting the rendered UI, catching runtime exceptions, and iterating without needing a description of what is on screen. — c4 says 'catch a runtime exception' (singular), not 'catching runtime exceptions' (plural); also c4 doesn't explicitly mention 'confirming that a reload succeeded' as part of verifying results, it's stated separately.

Fact score 1.00: present — Compose Hot Reload ships an experimental MCP (Model Context Protocol) server for AI agents; present — The agent can trigger reloads and take screenshots; present — It can inspect the semantic tree and simulate clicks and text input; present — It can read the application logs

## q06

**corpus** — Which compiler flags turn on context parameters and context-sensitive resolution in Kotlin 2.2.0, and is there a Kotlin/Native switch that reduces string memory?

Shared retrieval: 0.10 s search · 2.84 s rerank · 5 chunk(s)

1. 0.500 · Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium › 🎯 Context Parameters: Say Goodbye to Dependency Hell › The New Way (Welcome to Paradise) · `kb/kotlin-2.2.0-game-changing-features-that-will-transform-your-development-workflow-by-praveen-sharma-medium.html:structural:2`
2. 0.455 · Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium › 🚀 Getting Started Today · `kb/kotlin-2.2.0-game-changing-features-that-will-transform-your-development-workflow-by-praveen-sharma-medium.html:structural:18`
3. 0.397 · Kotlin 2.0.0_ A New Era in Kotlin Development _ by Halil Özel _ Medium › 1. Enhanced Language Features 🔥 · `kb/kotlin-2.0.0-a-new-era-in-kotlin-development-by-halil-ozel-medium.html:structural:1`
4. 0.301 · Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium › 🔮 What This Means for Your Daily Development · `kb/kotlin-2.2.0-game-changing-features-that-will-transform-your-development-workflow-by-praveen-sharma-medium.html:structural:17`
5. 0.292 · Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium › 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements › Latin-1 String Optimization · `kb/kotlin-2.2.0-game-changing-features-that-will-transform-your-development-workflow-by-praveen-sharma-medium.html:structural:12`

### q06 · Claude Haiku 4.5

Status **answered** · retried → verified · checks 4/5 · run #3 at 15:20:01 · TTFT 0.77 s · 141.4 tok/s · latency 6.82 s · 6869 prompt / 762 output tokens

> In Kotlin 2.2.0, the compiler flags for enabling these features are:
> 
> - **Context parameters**: `-Xcontext-parameters` [c1]
> - **Context-sensitive resolution**: `-Xcontext-sensitive-resolution` [c1]
> 
> For Kotlin/Native, there is a switch that reduces string memory: `kotlin.native.binary.latin1Strings=true` [c2]. When enabled, strings with Latin-1 characters use 50% less memory [c2].

- **[c1]** "Enable context parameters with -Xcontext-parameters - Try context-sensitive resolution with -Xcontext-sensitive-resolution" — Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium › 🚀 Getting Started Today
- **[c2]** "// gradle.properties kotlin.native.binary.latin1Strings=true // Strings with Latin-1 characters now use 50% less memory" — Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium › 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements › Latin-1 String Optimization

First-attempt errors:

- Rule 4: citation c1's quote is not in chunk "kb/kotlin-2.2.0-game-changing-features-that-will-transform-your-development-workflow-by-praveen-sharma-medium.html:structural:18": "Enable context parameters with -Xcontext-parameters. Try context-sensitive resolution with -Xcontext-sensitive-resolution". Copy the sentence exactly as it appears in that document.
- Rule 4: citation c2's quote is not in chunk "kb/kotlin-2.2.0-game-changing-features-that-will-transform-your-development-workflow-by-praveen-sharma-medium.html:structural:12": "kotlin.native.binary.latin1Strings=true. Strings with Latin-1 characters now use 50% less memory". Copy the sentence exactly as it appears in that document.

Faithfulness 1.00 (4 supported, 0 partial, 0 unsupported) · uncited: In Kotlin 2.2.0, the compiler flags for enabling these features are:

Fact score 1.00: present — Context parameters are enabled with -Xcontext-parameters; present — Context-sensitive resolution is enabled with -Xcontext-sensitive-resolution; present — kotlin.native.binary.latin1Strings=true enables Latin-1 strings on Kotlin/Native; present — Latin-1 strings use about 50% less memory

### q06 · gemma4:12b

Status **answered** · retried → verified · checks 4/5 · run #13 at 15:22:27 · TTFT 26.2 s · 14.4 tok/s · latency 74.0 s · 4583 prompt / 587 output tokens

> In Kotlin 2.2.0, context parameters are enabled with the `-Xcontext-parameters` flag, and context-sensitive resolution is enabled with `-Xcontext-sensitive-resolution` [c2]. There is a Kotlin/Native switch, `kotlin.native.binary.latin1Strings=true`, which allows strings with Latin-1 characters to use 50% less memory [c5].

- **[c2]** "- Enable context parameters with -Xcontext-parameters - Try context-sensitive resolution with -Xcontext-sensitive-resolution" — Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium › 🚀 Getting Started Today
- **[c5]** "kotlin.native.binary.latin1Strings=true // Strings with Latin-1 characters now use 50% less memory" — Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium › 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements › Latin-1 String Optimization

First-attempt errors:

- Rule 4: citation c2's quote is not in chunk "kb/kotlin-2.2.0-game-changing-features-that-will-transform-your-development-workflow-by-praveen-sharma-medium.html:structural:18": "Enable context parameters with -Xcontext-parameters Try context-sensitive resolution with -Xcontext-sensitive-resolution". Copy the sentence exactly as it appears in that document.

Faithfulness 1.00 (2 supported, 0 partial, 0 unsupported)

Fact score 1.00: present — Context parameters are enabled with -Xcontext-parameters; present — Context-sensitive resolution is enabled with -Xcontext-sensitive-resolution; present — kotlin.native.binary.latin1Strings=true enables Latin-1 strings on Kotlin/Native; present — Latin-1 strings use about 50% less memory

### q06 · qwen3.5:9b

Status **answered** · retried, still invalid · 1 citation dropped · checks 3/5 · run #23 at 15:30:50 · TTFT 20.1 s · 18.7 tok/s · latency 50.7 s · 4367 prompt / 498 output tokens

> For Kotlin/Native, enabling Latin-1 string optimization via the kotlin.native.binary.latin1Strings switch reduces memory usage by approximately 30% for text-heavy operations in shared code [c5].

- **[c5]** "In a recent Kotlin Multiplatform project with iOS targets, enabling these optimizations reduced memory usage by approximately 30% for text-heavy operations in the shared Kotlin/Native code." — Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium › 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements › Latin-1 String Optimization

First-attempt errors:

- Rule 4: citation c2's quote is not in chunk "kb/kotlin-2.2.0-game-changing-features-that-will-transform-your-development-workflow-by-praveen-sharma-medium.html:structural:18": "Enable context parameters with -Xcontext-parameters\n\nTry context-sensitive resolution with -Xcontext-sensitive-resolution". Copy the sentence exactly as it appears in that document.

Dropped citations:

- [c2] fabricated quote: "Enable context parameters with -Xcontext-parameters Try context-sensitive resolution with -Xcontext-sensitive-resolution"

Faithfulness 0.00 (0 supported, 1 partial, 0 unsupported)

- partial: For Kotlin/Native, enabling Latin-1 string optimization via the kotlin.native.binary.latin1Strings switch reduces memory usage by approximately 30% for text-heavy operations in shared code. — Quote mentions 30% memory reduction for text-heavy operations in shared Kotlin/Native code, but does not specifically mention the 'kotlin.native.binary.latin1Strings switch' or attribute the optimization to Latin-1 string optimization.

Fact score 0.13: missing — Context parameters are enabled with -Xcontext-parameters; missing — Context-sensitive resolution is enabled with -Xcontext-sensitive-resolution; partial — kotlin.native.binary.latin1Strings=true enables Latin-1 strings on Kotlin/Native; contradicted — Latin-1 strings use about 50% less memory

## q10

**unanswerable** (should be "I don't know") — What were the headline features of Compose Multiplatform 1.9.0?

Shared retrieval: 0.09 s search · 2.14 s rerank · 5 chunk(s)

1. 0.726 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Everything you need to build apps for real-world use · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:1`
2. 0.500 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Apps that feel truly native · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:2`
3. 0.469 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Production-ready and easy to adopt · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:5`
4. 0.463 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Compose Multiplatform beyond mobile · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:6`
5. 0.307 · Compose Multiplatform 1.7.0 Released - The JetBrains Blog · `kb/compose-multiplatform-1.7.0-released-the-jetbrains-blog.html:structural:0`

### q10 · Claude Haiku 4.5

Status **dont_know** (model) · verified · checks 1/1 · run #4 at 15:20:08 · TTFT 0.64 s · 135.3 tok/s · latency 1.68 s · 3135 prompt / 141 output tokens

> I don't know. The documents cover Compose Multiplatform versions 1.7.0 and 1.8.0, but do not contain information about version 1.9.0. Do you have documents about Compose Multiplatform 1.9.0?

### q10 · gemma4:12b

Status **dont_know** (model) · verified · checks 1/1 · run #14 at 15:23:41 · TTFT 25.2 s · 9.9 tok/s · latency 32.6 s · 2008 prompt / 73 output tokens

> I don't know. The provided documents only contain information regarding versions 1.7.0 and 1.8.0 of Compose Multiplatform. Could you provide information regarding version 1.9.0?

### q10 · qwen3.5:9b

Status **dont_know** (model) · verified · checks 1/1 · run #24 at 15:31:41 · TTFT 15.3 s · 13.3 tok/s · latency 21.1 s · 1939 prompt / 76 output tokens

> I don't know. The provided documents only cover Compose Multiplatform versions 1.7.0 and 1.8.0, detailing their features such as stable APIs, improved navigation, and iOS performance enhancements. There is no information available about the headline features of version 1.9.0.

## q12

**near_miss** — Can I ship a Compose Multiplatform web app to production yet, or is the web target still experimental?

Shared retrieval: 0.06 s search · 2.59 s rerank · 5 chunk(s)

1. 0.962 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Compose Multiplatform beyond mobile · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:6`
2. 0.914 · What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog › Compose Multiplatform › Release Compose Multiplatform for Web in Beta · `kb/what-s-next-for-kotlin-multiplatform-and-compose-multiplatform-august-2025-update-the-jetbrains-blog.html:structural:2`
3. 0.904 · What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog › Key priorities · `kb/what-s-next-for-kotlin-multiplatform-and-compose-multiplatform-august-2025-update-the-jetbrains-blog.html:structural:1`
4. 0.888 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Everything you need to build apps for real-world use · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:1`
5. 0.443 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Production-ready and easy to adopt · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:5`

### q12 · Claude Haiku 4.5

Status **answered** · verified · checks 4/5 · run #5 at 15:20:09 · TTFT 0.98 s · 112.8 tok/s · latency 4.68 s · 3123 prompt / 417 output tokens

> Compose Multiplatform for Web is not yet fully production-ready, but it is moving in that direction. [c1] Most essential APIs will be available in the Beta version, enabling early adopters to confidently move to production with the existing feature set. [c2] However, after the Beta release, JetBrains will continue working on remaining Compose APIs and further performance improvements. [c2]
> 
> So while you can experiment with web apps and some teams may be able to ship small- to medium-sized apps, the web target is currently in Beta rather than stable like the iOS target.

- **[c1]** "These updates bring Compose Multiplatform for the web one step closer to providing a polished, production-ready experience." — Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Compose Multiplatform beyond mobile
- **[c2]** "Most essential APIs will be available, enabling early adopters to confidently move to production with the existing feature set. After this Beta release, we will keep working on the remaining Compose APIs and further performance improvements." — What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog › Compose Multiplatform › Release Compose Multiplatform for Web in Beta

Faithfulness 0.67 (2 supported, 1 partial, 0 unsupported) · uncited: So while you can experiment with web apps and some teams may be able to ship small- to medium-sized apps, the web target is currently in Beta rather than stable like the iOS target.

- partial: Compose Multiplatform for Web is not yet fully production-ready, but it is moving in that direction. — Quote says 'one step closer' to production-ready, not that it's 'not yet fully production-ready' (which is an interpretation).

Fact score 1.00: present — Compose Multiplatform for Web is being released as a Beta (not Stable); present — With the Beta, most essential APIs are available so early adopters can move to production with the existing feature set; present — After the Beta, JetBrains keeps working on the remaining Compose APIs and performance

### q12 · gemma4:12b

Status **answered** · verified · checks 4/5 · run #15 at 15:24:14 · TTFT 24.7 s · 12.6 tok/s · latency 45.0 s · 2020 prompt / 254 output tokens

> You can currently ship small- to medium-sized apps to production using Compose for Web and Kotlin/Wasm, as they are being promoted to Beta [c3]. The Beta version of Compose Multiplatform for Web includes most essential APIs, allowing early adopters to move to production with the existing feature set [c2].

- **[c2]** "Most essential APIs will be available, enabling early adopters to confidently move to production with the existing feature set." — What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog › Compose Multiplatform › Release Compose Multiplatform for Web in Beta
- **[c3]** "By promoting Compose for Web and Kotlin/Wasm to Beta, we expect to see pioneers starting to ship small- to medium-sized apps to production." — What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog › Key priorities

Faithfulness 0.50 (1 supported, 1 partial, 0 unsupported)

- partial: You can currently ship small- to medium-sized apps to production using Compose for Web and Kotlin/Wasm, as they are being promoted to Beta. — Quote says 'we expect to see pioneers starting to ship' (future expectation), not that they 'can currently ship' (present capability).

Fact score 0.67: present — Compose Multiplatform for Web is being released as a Beta (not Stable); present — With the Beta, most essential APIs are available so early adopters can move to production with the existing feature set; missing — After the Beta, JetBrains keeps working on the remaining Compose APIs and performance

### q12 · qwen3.5:9b

Status **dont_know** (model) · verified · checks 0/3 · run #25 at 15:32:02 · TTFT 15.2 s · 14.2 tok/s · latency 22.9 s · 1940 prompt / 109 output tokens

> I don't know. The documents state that Compose Multiplatform for Web has a Beta version available with essential APIs, but they do not explicitly confirm whether shipping to production is currently allowed or if the target remains experimental. The documents mention that after the Beta release, work will continue on remaining APIs and performance improvements, which suggests it may still be in an evolving phase rather than fully stable for production.

Fact score 1.00: present — Compose Multiplatform for Web is being released as a Beta (not Stable); present — With the Beta, most essential APIs are available so early adopters can move to production with the existing feature set; present — After the Beta, JetBrains keeps working on the remaining Compose APIs and performance

## q13

**off_topic** (should be "I don't know") — How long should I proof sourdough bread in the fridge overnight, and at what temperature?

Shared retrieval: 0.06 s search · 5.35 s rerank · 0 chunk(s) — **none above the cutoff: no answer call, one clarifying call**

### q13 · Claude Haiku 4.5

Status **dont_know** (low_relevance) · low relevance (no answer call) · checks 1/1 · run #6 at 15:20:14 · TTFT 0.65 s · 153.2 tok/s · latency 1.13 s · 1130 prompt / 72 output tokens

> I don't know. These documents cover Kotlin, Kotlin Multiplatform, and Compose Multiplatform topics. Did you mean to ask about something related to Kotlin or Compose?

### q13 · gemma4:12b

Status **dont_know** (low_relevance) · low relevance (no answer call) · checks 1/1 · run #16 at 15:24:59 · TTFT 7.25 s · 8.4 tok/s · latency 11.2 s · 455 prompt / 33 output tokens

> I don't know. The documents cover Kotlin, Kotlin Multiplatform, and Compose Multiplatform. What Kotlin topic would you like to know about?

### q13 · qwen3.5:9b

Status **dont_know** (low_relevance) · low relevance (no answer call) · checks 1/1 · run #26 at 15:32:25 · TTFT 4.49 s · 14.7 tok/s · latency 8.05 s · 447 prompt / 52 output tokens

> I don't know. The documents cover Kotlin, Kotlin Multiplatform, and Compose Multiplatform topics. Did you mean to ask about sourdough bread proofing, or are you looking for information on a specific Kotlin topic?

## q14

**paraphrased** — In JetBrains' cross-platform UI toolkit, can people using my app on a Windows or Mac computer grab an element with the mouse, carry it across and let go of it over another element? Which version brought that, and what do I attach to the two elements?

Shared retrieval: 1.74 s search · 4.33 s rerank · 2 chunk(s)

1. 0.055 · Compose Multiplatform 1.7.0 Released - The JetBrains Blog · `kb/compose-multiplatform-1.7.0-released-the-jetbrains-blog.html:structural:0`
2. 0.030 · Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog › The Ship Kotlin Everywhere Award · `kb/know-kotlin-ship-it-everywhere-and-win-at-shipaton-2026-the-jetbrains-blog.html:structural:1`

### q14 · Claude Haiku 4.5

Status **dont_know** (model) · verified · checks 0/3 · run #7 at 15:20:15 · TTFT 0.58 s · 134.5 tok/s · latency 1.42 s · 1923 prompt / 112 output tokens

> I don't know. Do the documents discuss drag-and-drop functionality in Compose Multiplatform, or what specific features were added in different versions?

Fact score 0.00: missing — Compose Multiplatform 1.7.0 added drag and drop on desktop; missing — The dragAndDropSource modifier marks the composable where a drag starts; missing — The dragAndDropTarget modifier marks the composable that accepts the dropped data

### q14 · gemma4:12b

Status **dont_know** (model) · verified · checks 0/3 · run #17 at 15:25:10 · TTFT 8.37 s · 10.7 tok/s · latency 15.6 s · 956 prompt / 76 output tokens

> I don't know. The provided documents discuss the release of Compose Multiplatform 1.7.0 and the Ship Kotlin Everywhere Award, but they do not contain information regarding drag-and-drop functionality, specific UI element interactions, or the technical requirements for attaching items to elements.

Fact score 0.00: missing — Compose Multiplatform 1.7.0 added drag and drop on desktop; missing — The dragAndDropSource modifier marks the composable where a drag starts; missing — The dragAndDropTarget modifier marks the composable that accepts the dropped data

### q14 · qwen3.5:9b

Status **dont_know** (model) · verified · checks 0/3 · run #27 at 15:32:33 · TTFT 5.13 s · 14.7 tok/s · latency 11.7 s · 931 prompt / 97 output tokens

> I don't know. The provided documents describe Compose Multiplatform 1.7.0, which includes Material3 adaptive support, type-safe navigation, and iOS performance improvements, but they do not contain information about drag-and-drop functionality on Windows or Mac, the specific version that introduced it, or how to attach elements for this feature.

Fact score 0.00: missing — Compose Multiplatform 1.7.0 added drag and drop on desktop; missing — The dragAndDropSource modifier marks the composable where a drag starts; missing — The dragAndDropTarget modifier marks the composable that accepts the dropped data

## q15

**messy** — hi! ok so long story — we're rewriting our notes app and my coworker insists we keep our hand-rolled ID generator in the shared module because "kotlin doesn't have UUIDs in common code", which sounds wrong to me?? we're on kotlin 2.4 btw, just upgraded last sprint. anyway: is there a stable UUID type in common code now or do we still need a library, and can we generate v4/v7 ones without opting into anything? thanks, sorry for the wall of text lol

Shared retrieval: 0.13 s search · 4.24 s rerank · 5 chunk(s)

1. 0.955 · Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium › 4. Stable UUID API · `kb/kotlin-2.4-10-new-features-android-developers-should-know-medium.html:structural:4`
2. 0.157 · Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium › 🔐 Stable Base64: Finally, Built-in Encoding That Works Everywhere · `kb/kotlin-2.2.0-game-changing-features-that-will-transform-your-development-workflow-by-praveen-sharma-medium.html:structural:8`
3. 0.152 · Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium › What Kotlin 2.4 Actually Delivers › Platform support: · `kb/kotlin-2.4-vs-kotlin-2.3-what-actually-changed-medium.html:structural:4`
4. 0.140 · Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium · `kb/kotlin-2.4-vs-kotlin-2.3-what-actually-changed-medium.html:structural:0`
5. 0.083 · Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium › Should You Upgrade Right Now? · `kb/kotlin-2.4-vs-kotlin-2.3-what-actually-changed-medium.html:structural:7`

### q15 · Claude Haiku 4.5

Status **answered** · verified · checks 5/5 · run #8 at 15:20:17 · TTFT 0.67 s · 107.0 tok/s · latency 4.44 s · 2976 prompt / 403 output tokens

> Good news — your coworker is wrong! [c1] Kotlin 2.4 has a stable UUID type available in common code. You can definitely replace that hand-rolled generator.
> 
> However, there's a caveat on V4/V7 generation: [c2] V4/V7 generation functions remain experimental, so you would need to opt into experimental APIs if you want to use those specific generation methods. The stable `Uuid` type itself is ready to use without any experimental flags, but generating V4 or V7 UUIDs specifically requires opting in.
> 
> So for your notes app: you can use the stable `kotlin.uuid.Uuid` type in your shared module right away, but if you specifically need V4 or V7 generation, you'll need to handle that with experimental annotations.

- **[c1]** "kotlin.uuid.Uuid Common code has a stable Uuid, used for offline-first Room entities and multiplatform IDs." — Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium › 4. Stable UUID API
- **[c2]** "V4/V7 generation functions remain experimental." — Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium › 4. Stable UUID API

Faithfulness 1.00 (2 supported, 0 partial, 0 unsupported) · uncited: Kotlin 2.4 has a stable UUID type available in common code.; You can definitely replace that hand-rolled generator.; The stable `Uuid` type itself is ready to use without any experimental flags, but generating V4 or V7 UUIDs specifically requires opting in.; So for your notes app: you can use the stable `kotlin.uuid.Uuid` type in your shared module right away, but if you specifically need V4 or V7 generation, you'll need to handle that with experimental annotations.

Fact score 1.00: present — Kotlin 2.4 has a stable kotlin.uuid.Uuid usable in common code; present — The V4/V7 generation functions are still experimental (need an opt-in)

### q15 · gemma4:12b

Status **answered** · retried → verified · checks 5/5 · run #18 at 15:25:25 · TTFT 30.7 s · 13.6 tok/s · latency 78.2 s · 4320 prompt / 549 output tokens

> In Kotlin 2.4, there is a stable `Uuid` type available in common code [c1]. This type can be used for multiplatform IDs and offline-first Room entities [c1]. However, while the type is stable, the generation functions for V4 and V7 remain experimental [c1]. Additionally, Kotlin 2.4 provides support for the previously unsupported UUID API [c2].

- **[c1]** "Common code has a stable Uuid, used for offline-first Room entities and multiplatform IDs. V4/V7 generation functions remain experimental." — Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium › 4. Stable UUID API
- **[c2]** "Support for the unsupported UUID API, and implement support for checking order" — Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium › What Kotlin 2.4 Actually Delivers › Platform support:

First-attempt errors:

- Citation kb/kotlin-2.4-10-new-features-android-developers-should-know-medium.html:structural:4: id must look like c1, c2, ….
- Citation kb/kotlin-2.4-vs-kotlin-2.3-what-actually-changed-medium.html:structural:4: id must look like c1, c2, ….
- Rule 2: the answer has no citation markers; put [cN] after every factual claim.

Faithfulness 0.75 (3 supported, 1 partial, 0 unsupported)

- partial: Additionally, Kotlin 2.4 provides support for the previously unsupported UUID API. — Quote says 'unsupported UUID API' not 'previously unsupported'; the word 'previously' adds a temporal claim not in the quote.

Fact score 1.00: present — Kotlin 2.4 has a stable kotlin.uuid.Uuid usable in common code; present — The V4/V7 generation functions are still experimental (need an opt-in)

### q15 · qwen3.5:9b

Status **answered** · verified · checks 5/5 · run #28 at 15:32:44 · TTFT 14.4 s · 17.3 tok/s · latency 24.8 s · 1851 prompt / 178 output tokens

> In Kotlin 2.4, there is now a stable UUID type available in common code via `kotlin.uuid.Uuid`, which can be used for offline-first Room entities and multiplatform IDs [c1]. However, V4/V7 generation functions remain experimental and are not yet stable [c1].

- **[c1]** "kotlin.uuid.Uuid Common code has a stable Uuid, used for offline-first Room entities and multiplatform IDs. V4/V7 generation functions remain experimental." — Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium › 4. Stable UUID API

Faithfulness 1.00 (2 supported, 0 partial, 0 unsupported)

Fact score 1.00: present — Kotlin 2.4 has a stable kotlin.uuid.Uuid usable in common code; present — The V4/V7 generation functions are still experimental (need an opt-in)

## q16

**multi_part** — Which Compose Multiplatform release added type-safe navigation, and which one brought Navigation 3? What does each give me?

Shared retrieval: 0.07 s search · 2.43 s rerank · 5 chunk(s)

1. 0.992 · Compose Multiplatform 1.7.0 Released - The JetBrains Blog · `kb/compose-multiplatform-1.7.0-released-the-jetbrains-blog.html:structural:0`
2. 0.959 · Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog · `kb/compose-multiplatform-1.10.0-unified-preview-navigation-3-and-stable-compose-hot-reload-the-jetbrains-blog.html:structural:0`
3. 0.926 · Compose Multiplatform 1.7.0 Released - The JetBrains Blog › Type-safe navigation · `kb/compose-multiplatform-1.7.0-released-the-jetbrains-blog.html:structural:2`
4. 0.825 · Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Everything you need to build apps for real-world use · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:1`
5. 0.748 · Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog › Navigation 3 · `kb/compose-multiplatform-1.10.0-unified-preview-navigation-3-and-stable-compose-hot-reload-the-jetbrains-blog.html:structural:2`

### q16 · Claude Haiku 4.5

Status **answered** · verified · checks 4/5 · run #9 at 15:20:21 · TTFT 0.69 s · 139.6 tok/s · latency 5.40 s · 2810 prompt / 658 output tokens

> **Type-safe navigation** was added in Compose Multiplatform 1.7.0 [c1]. It provides compile-time safety for your navigation graph [c2], allowing you to rely on type safety when passing objects along a navigation route [c3].
> 
> **Navigation 3** was introduced in Compose Multiplatform 1.10.0 [c4]. It is a new library for managing navigation that lets you manipulate your navigation stack directly, making tasks like adding or removing destinations more straightforward [c5].
> 
> In summary: version 1.7.0 gave you compile-time type safety for navigation, while version 1.10.0 brought Navigation 3 with more direct control over your navigation stack.

- **[c1]** "Compose Multiplatform now provides compile-time safety for your navigation graph." — Compose Multiplatform 1.7.0 Released - The JetBrains Blog
- **[c2]** "You can now rely on Compose Multiplatform for compile-time safety in navigation graphs." — Compose Multiplatform 1.7.0 Released - The JetBrains Blog › Type-safe navigation
- **[c3]** "To ensure type safety, we adopted Jetpack Compose's type-safe approach to passing objects along a navigation route." — Compose Multiplatform 1.7.0 Released - The JetBrains Blog › Type-safe navigation
- **[c4]** "We've introduced support for Navigation 3, a new library for managing navigation." — Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog › Navigation 3
- **[c5]** "With Navigation 3, you can manipulate your navigation stack directly, making tasks like adding or removing destinations more straightforward." — Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog › Navigation 3

Faithfulness 0.50 (2 supported, 2 partial, 0 unsupported) · uncited: version 1.7.0 gave you compile-time type safety for navigation; version 1.10.0 brought Navigation 3 with more direct control over your navigation stack

- partial: Type-safe navigation was added in Compose Multiplatform 1.7.0. — Quote says type-safe navigation was added but doesn't specify version 1.7.0
- partial: Navigation 3 was introduced in Compose Multiplatform 1.10.0. — Quote mentions Navigation 3 was introduced but doesn't specify version 1.10.0

Fact score 1.00: present — Compose Multiplatform 1.7.0 added type-safe navigation, with compile-time safety in navigation graphs; present — It follows Jetpack Compose's type-safe approach to passing objects along a navigation route; present — Compose Multiplatform 1.10.0 added support for Navigation 3; present — Navigation 3 lets you manipulate the navigation stack directly

### q16 · gemma4:12b

Status **answered** · retried → verified · checks 4/5 · run #19 at 15:26:44 · TTFT 16.6 s · 14.4 tok/s · latency 98.1 s · 4283 prompt / 976 output tokens

> Compose Multiplatform 1.7.0 introduced type-safe navigation [c1]. This provides compile-time safety for navigation graphs by adopting Jetpack Compose's type-safe approach to passing objects along a navigation route [c2]. Navigation 3 was introduced in Compose Multiplatform 1.10.0 [c3]. Navigation 3 is a new library for managing navigation that allows you to manipulate your navigation stack directly, making tasks like adding or removing destinations more straightforward [c4].

- **[c1]** "The 1.7.0 release brings more components to common code, support for type-safe navigation, significant performance improvements on iOS, and changes from the latest Jetpack Compose update." — Compose Multiplatform 1.7.0 Released - The JetBrains Blog
- **[c2]** "You can now rely on Compose Multiplatform for compile-time safety in navigation graphs. To ensure type safety, we adopted Jetpack Compose’s type-safe approach to passing objects along a navigation route." — Compose Multiplatform 1.7.0 Released - The JetBrains Blog › Type-safe navigation
- **[c3]** "Navigation 3 is available on non-Android targets" — Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog
- **[c4]** "With Navigation 3, you can manipulate your navigation stack directly, making tasks like adding or removing destinations more straightforward." — Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog › Navigation 3

First-attempt errors:

- Citation kb/compose-multiplatform-1.7.0-released-the-jetbrains-blog.html:structural:0: id must look like c1, c2, ….
- Citation kb/compose-multiplatform-1.7.0-released-the-jetbrains-blog.html:structural:2: id must look like c1, c2, ….
- Citation kb/compose-multiplatform-1.10.0-unified-preview-navigation-3-and-stable-compose-hot-reload-the-jetbrains-blog.html:structural:0: id must look like c1, c2, ….
- Citation kb/compose-multiplatform-1.10.0-unified-preview-navigation-3-and-stable-compose-hot-reload-the-jetbrains-blog.html:structural:2: id must look like c1, c2, ….
- Rule 2: the answer has no citation markers; put [cN] after every factual claim.

Faithfulness 0.50 (2 supported, 1 partial, 1 unsupported)

- unsupported: Navigation 3 was introduced in Compose Multiplatform 1.10.0. — Quote does not mention version 1.10.0 or when Navigation 3 was introduced
- partial: Navigation 3 is a new library for managing navigation that allows you to manipulate your navigation stack directly, making tasks like adding or removing destinations more straightforward. — Quote supports the navigation stack manipulation part but does not describe it as 'a new library for managing navigation'

Fact score 1.00: present — Compose Multiplatform 1.7.0 added type-safe navigation, with compile-time safety in navigation graphs; present — It follows Jetpack Compose's type-safe approach to passing objects along a navigation route; present — Compose Multiplatform 1.10.0 added support for Navigation 3; present — Navigation 3 lets you manipulate the navigation stack directly

### q16 · qwen3.5:9b

Status **answered** · verified · checks 4/5 · run #29 at 15:33:09 · TTFT 12.7 s · 17.3 tok/s · latency 36.4 s · 1679 prompt / 408 output tokens

> Compose Multiplatform 1.7.0 added type-safe navigation, which provides compile-time safety for your navigation graph by adopting Jetpack Compose's approach to passing objects along a navigation route [c1][c2]. Compose Multiplatform 1.10.0 brought Navigation 3, a new library that allows you to manipulate your navigation stack directly, making tasks like adding or removing destinations more straightforward [c3][c4].

- **[c1]** "Compose Multiplatform now provides compile-time safety for your navigation graph." — Compose Multiplatform 1.7.0 Released - The JetBrains Blog
- **[c2]** "You can now rely on Compose Multiplatform for compile-time safety in navigation graphs. To ensure type safety, we adopted Jetpack Compose's type-safe approach to passing objects along a navigation route." — Compose Multiplatform 1.7.0 Released - The JetBrains Blog › Type-safe navigation
- **[c3]** "Navigation 3 is available on non-Android targets" — Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog
- **[c4]** "We've introduced support for Navigation 3, a new library for managing navigation. With Navigation 3, you can manipulate your navigation stack directly, making tasks like adding or removing destinations more straightforward." — Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog › Navigation 3

Faithfulness 0.00 (0 supported, 2 partial, 0 unsupported)

- partial: Compose Multiplatform 1.7.0 added type-safe navigation, which provides compile-time safety for your navigation graph by adopting Jetpack Compose's approach to passing objects along a navigation route. — Quotes support type-safe navigation and compile-time safety, but don't specify version 1.7.0 or mention 'adopting Jetpack Compose's approach' as a distinct feature.
- partial: Compose Multiplatform 1.10.0 brought Navigation 3, a new library that allows you to manipulate your navigation stack directly, making tasks like adding or removing destinations more straightforward. — Quote c4 supports Navigation 3 and direct stack manipulation, but c3 only mentions availability on non-Android targets, not that 1.10.0 'brought' it. Version 1.10.0 is not stated in quotes.

Fact score 1.00: present — Compose Multiplatform 1.7.0 added type-safe navigation, with compile-time safety in navigation graphs; present — It follows Jetpack Compose's type-safe approach to passing objects along a navigation route; present — Compose Multiplatform 1.10.0 added support for Navigation 3; present — Navigation 3 lets you manipulate the navigation stack directly

## q17

**ambiguous** (should be "I don't know") — How does it work?

Shared retrieval: 0.05 s search · 7.20 s rerank · 5 chunk(s)

1. 0.223 · first-agent/src/context/comparison.js › (module) · `projects/first-agent/src/context/comparison.js:structural:1`
2. 0.187 · first-agent/src/pipeline/runner.js › (module) · `projects/first-agent/src/pipeline/runner.js:structural:1`
3. 0.179 · first-agent/src/context/taskState.js › transition · `projects/first-agent/src/context/taskstate.js:structural:15`
4. 0.117 · first-agent/src/context/memory.js › MemoryStrategy · `projects/first-agent/src/context/memory.js:structural:100`
5. 0.117 · first-agent/src/context/memory.js › workingBlock · `projects/first-agent/src/context/memory.js:structural:9`

### q17 · Claude Haiku 4.5

Status **dont_know** (model) · verified · checks 1/1 · run #10 at 15:20:26 · TTFT 0.71 s · 105.6 tok/s · latency 1.86 s · 4079 prompt / 121 output tokens

> I don't know. What specific system or component would you like to understand? The documents cover comparison profiles, pipeline runs, task state transitions, memory management, and working memory blocks. Which one interests you?

### q17 · gemma4:12b

Status **dont_know** (model) · verified · checks 1/1 · run #20 at 15:28:22 · TTFT 52.8 s · 7.1 tok/s · latency 64.2 s · 2995 prompt / 81 output tokens

> I don't know. The provided documents describe several different systems (a comparison arm for profile testing, a pipeline runner for executing steps, a task state transition function, and a working memory block). Could you please specify which system or component you are asking about?

### q17 · qwen3.5:9b

Status **dont_know** (model) · verified · checks 1/1 · run #30 at 15:33:46 · TTFT 29.1 s · 15.0 tok/s · latency 36.3 s · 2881 prompt / 108 output tokens

> I don't know. The documents describe the architecture of a multi-profile comparison system, a pipeline runner with ordered steps, and a task state transition mechanism, but they do not explain how the overall system works in a general sense. To answer 'How does it work?', please specify which component or process you are asking about (e.g., the profile comparison logic, the pipeline execution flow, or the task state transitions).

## Run order

| # | started (UTC) | generator | question | answer latency | tok/s | TTFT |
| ---: | --- | --- | --- | ---: | ---: | ---: |
| 1 | 15:19:50 | Claude Haiku 4.5 | q02 | 3.44 s | 128.5 | 0.74 s |
| 2 | 15:19:53 | Claude Haiku 4.5 | q04 | 7.95 s | 135.6 | 0.65 s |
| 3 | 15:20:01 | Claude Haiku 4.5 | q06 | 6.82 s | 141.4 | 0.77 s |
| 4 | 15:20:08 | Claude Haiku 4.5 | q10 | 1.68 s | 135.3 | 0.64 s |
| 5 | 15:20:09 | Claude Haiku 4.5 | q12 | 4.68 s | 112.8 | 0.98 s |
| 6 | 15:20:14 | Claude Haiku 4.5 | q13 | 1.13 s | 153.2 | 0.65 s |
| 7 | 15:20:15 | Claude Haiku 4.5 | q14 | 1.42 s | 134.5 | 0.58 s |
| 8 | 15:20:17 | Claude Haiku 4.5 | q15 | 4.44 s | 107.0 | 0.67 s |
| 9 | 15:20:21 | Claude Haiku 4.5 | q16 | 5.40 s | 139.6 | 0.69 s |
| 10 | 15:20:26 | Claude Haiku 4.5 | q17 | 1.86 s | 105.6 | 0.71 s |
| 11 | 15:20:37 | gemma4:12b | q02 | 66.1 s | 14.0 | 32.4 s |
| 12 | 15:21:43 | gemma4:12b | q04 | 44.4 s | 12.4 | 26.4 s |
| 13 | 15:22:27 | gemma4:12b | q06 | 74.0 s | 14.4 | 26.2 s |
| 14 | 15:23:41 | gemma4:12b | q10 | 32.6 s | 9.9 | 25.2 s |
| 15 | 15:24:14 | gemma4:12b | q12 | 45.0 s | 12.6 | 24.7 s |
| 16 | 15:24:59 | gemma4:12b | q13 | 11.2 s | 8.4 | 7.25 s |
| 17 | 15:25:10 | gemma4:12b | q14 | 15.6 s | 10.7 | 8.37 s |
| 18 | 15:25:25 | gemma4:12b | q15 | 78.2 s | 13.6 | 30.7 s |
| 19 | 15:26:44 | gemma4:12b | q16 | 98.1 s | 14.4 | 16.6 s |
| 20 | 15:28:22 | gemma4:12b | q17 | 64.2 s | 7.1 | 52.8 s |
| 21 | 15:29:33 | qwen3.5:9b | q02 | 36.4 s | 16.5 | 19.8 s |
| 22 | 15:30:09 | qwen3.5:9b | q04 | 41.1 s | 18.9 | 16.6 s |
| 23 | 15:30:50 | qwen3.5:9b | q06 | 50.7 s | 18.7 | 20.1 s |
| 24 | 15:31:41 | qwen3.5:9b | q10 | 21.1 s | 13.3 | 15.3 s |
| 25 | 15:32:02 | qwen3.5:9b | q12 | 22.9 s | 14.2 | 15.2 s |
| 26 | 15:32:25 | qwen3.5:9b | q13 | 8.05 s | 14.7 | 4.49 s |
| 27 | 15:32:33 | qwen3.5:9b | q14 | 11.7 s | 14.7 | 5.13 s |
| 28 | 15:32:44 | qwen3.5:9b | q15 | 24.8 s | 17.3 | 14.4 s |
| 29 | 15:33:09 | qwen3.5:9b | q16 | 36.4 s | 17.3 | 12.7 s |
| 30 | 15:33:46 | qwen3.5:9b | q17 | 36.3 s | 15.0 | 29.1 s |
