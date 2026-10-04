# Day 25 — Mini-chat with RAG and task memory


https://github.com/user-attachments/assets/c5828131-5444-4031-a349-bc6b777e6ca0


**Day 25:** the Knowledge agent is now a multi-turn chat. Each message goes first to a **router**
(one forced `route` call, Haiku 4.5, temperature 0). The router labels it `search`, `memory_only`
or `chat`, resolves references into a standalone question with 1–3 search queries, and proposes
a patch to a per-chat **task memory** (goal, clarified details, constraints and terms, open
questions). A search turn runs Day 23's retrieval with the router's queries, reranks against the
standalone question, and answers through Day 24's verified citation contract, with the memory
and recent messages in the prompt. An "I don't know" puts its clarifying question into the
memory, so the next message can answer it. In the page, user messages carry intent badges, and
a side panel shows the task memory with what changed on the latest turn and a reset button.
`npm run eval:chat` replays two scripted 13-message conversations through `POST /chat`
([report](first-agent/reports/chat_report.md), [findings](first-agent/reports/chat_notes.md),
and the **Chat** tab on `/rag-report`):

| | scenario 1: deep dive (CMP for iOS) | scenario 2: comparison → change of direction |
| --- | ---: | ---: |
| turns passing every check | 12/13 | 5/13 |
| router intent accuracy | 13/13 | 13/13 |
| search turns with ≥ 1 source and ≥ 1 verified citation | 9/9 | 9/10 |
| correct · false "I don't know" | 2/2 · 0 | — · 1 (a retrieval miss) |
| constraint compliance (sentence limit) | 8/8 | 2/2 |
| memory checkpoints | 5/5 | 6/6 |
| on track (judge, and no unsupported claim) | 10/11 | 7/13 |
| facts (Day 22 judge) | 9/9 | 5/9 |
| latency: router · search turn | 1.8 s · 7.8 s | 1.8 s · 6.8 s |

The conversation machinery held. Both clarification loops closed. A question that only makes
sense from message 1, asked at message 12, resolved through the memory alone. A correction
replaced its item, and a change of direction dropped the old focus. Getting there took three
router-prompt fixes found by the first run: off-topic questions are search, never `chat`; every
open question closes on the next non-chat message; queries describe content, not article
titles. What still fails is answer quality: closing sentences that go beyond their quote, and a
section of an article that can't be found by the article's name.

## Day 24 — Citations, sources and "I don't know"

https://github.com/user-attachments/assets/ab7ba1e0-9e79-47db-97e5-8fe86314c8de

**Day 24:** every RAG answer in the Knowledge agent follows a strict, verified contract. One
forced `submit_answer` call returns the answer with a `[cN]` marker after each claim, and each
citation is a verbatim quote from a chunk that was sent. Code checks five rules: citations are
present, every marker is matched, every chunk_id was sent, every quote is found in its chunk,
and every quote is 4–60 words. A failure gets one retry with the errors; after that, bad
citations and the claims that rely only on them are dropped, or the answer is downgraded. The
**Sources** list is derived from the cited chunk_ids, never written by the model. **"I don't
know"** plus a clarifying question comes either from a low rerank score (a small clarifying
call; the answering model is not called) or from the model's own `dont_know`. In the chat,
markers are clickable chips that show the quote highlighted in its chunk, next to a
verification badge. `npm run eval:citations` runs 10 questions (7 to answer, 3 to decline,
including a new `ambiguous` one) in `rag+rerank`
([report](first-agent/reports/citations_report.md),
[findings](first-agent/reports/citations_notes.md), and the **Citations** tab on `/rag-report`):

| | rag+rerank |
| --- | ---: |
| answered with ≥ 1 source / valid citation | 6/6 · 6/6 |
| fabricated quotes on the first attempt | 2 of 15 (both reformatted bullets / code, both fixed by the retry) |
| retries · dropped citations · downgrades | 2 · 0 · 0 |
| mean faithfulness (14 supported, 3 partial, 0 unsupported) | 0.86 |
| uncited factual claims | 8 |
| correct "I don't know" | 3/3 (1 low relevance, 2 model) |
| false "I don't know" | 1: q14, a retrieval miss (the reranker drops the paraphrased answer chunk, as on Day 23) |
| mean fact score (7 answerable; Day 23 rag+rerank: 0.79) | 0.76 |

The model copies quotes faithfully. Its misses were punctuation and line structure, not
invented text. The weak spot is **where it puts markers**: at a sentence start or after a
colon, they pair with the wrong claim. One prompt rule lifted faithfulness from 0.69 to 0.86,
but most of the 8 uncited claims still come from this. The contract costs about 2.6× the input
tokens of Day 23 (3.5k vs 1.3k per question).

## Day 23 — Reranking, filtering and query rewriting

**Day 23:** the Knowledge agent's RAG gets two optional stages, switched per chat next to the
RAG toggle: **Rewrite** (one model call → 1–3 search queries, results merged) and **Rerank**
(a local cross-encoder, bge-reranker-v2-m3, scores 20 candidates against the question, drops
those under **0.02**, keeps the top 5, and declines without calling the model if none pass).
The Sources panel shows vector → rerank scores, the dropped candidates and the queries.
`npm run eval:rag` then ran 16 questions × 4 modes
([report](first-agent/reports/rag_comparison.md), [findings](first-agent/reports/rag_notes.md)):

| | plain | rag | rag+rerank | rag+rewrite+rerank |
| --- | ---: | ---: | ---: | ---: |
| mean fact score (14 answerable) | 0.19 | **0.93** | 0.79 | 0.80 |
| passed (of 16) | 2 | **15** | 11 | 11 |
| hallucinations | 8 | 0 | 1 | 1 |
| correct / wrong declines | 1/2 · 4 | 2/2 · 1 | 2/2 · 2 | 2/2 · 2 |
| mean latency | 3.9 s | 2.6 s | 5.7 s | 8.0 s |

Reranking did not pay off on this corpus. The baseline already had the right document in its
top 5 on every question. The cross-encoder fixed a near-miss ranking (4th → 1st) but scored a
paraphrased answer chunk at 0.0004, which led to a wrong decline. The cutoff declined the
off-topic question without a model call. Rewriting produced good queries but changed no
answer, for +950 tokens and +2.3 s. The threshold was chosen beforehand on doc_index's 20
retrieval questions: it keeps 19 of 20 relevant chunks and drops 63% of the rest.

## Day 22 — First RAG query

The **Knowledge** agent in `first-agent` answers questions about the Kotlin / Kotlin
Multiplatform / Compose Multiplatform articles in `knowledge_database/` in one of two modes:

- **With RAG**: question → doc_index `search()` (structural chunks, k = 5) → the chunks go
  into the latest user message → Haiku 4.5 answers only from them, citing `[n]`, or says
  plainly that they don't cover the question. A **Sources** list under the reply shows
  each chunk's score, source and section, and opens to its text.
- **Without RAG**: the same model, temperature 0 and max tokens, no documents.

The switch is in the chat header and stored per chat. Every reply carries a badge with
the mode that produced it, and **Compare** asks one question both ways side by side.

### Day 22 results

`npm run eval:rag` asks 10 questions in both modes (7 from the articles, 2 general, 1 not
covered) and has a blind judge grade each answer against expected facts:
**[`first-agent/reports/rag_comparison.md`](first-agent/reports/rag_comparison.md)**, also at
http://localhost:3000/rag-report.

| | plain | rag |
| --- | ---: | ---: |
| mean fact score (9 answerable) | 0.21 | 0.89 |
| passed | 2/10 | 9/10 |
| answers with a hallucination | 4 | 0 |
| unanswerable declined | 1/1 | 1/1 |
| mean latency | 4.0 s | 2.6 s |
| mean input tokens | 72 | 1,486 |
| hit@5 / citations valid | | 8/8 (always rank 1) / 10/10 |

RAG fixed every article question, mostly by replacing *confidently wrong* answers rather
than "I don't know"s. It hurt on the one general question the articles don't explain
(coroutines vs threads), where its "documents only" rule made it decline. The analysis is
in [`first-agent/reports/rag_notes.md`](first-agent/reports/rag_notes.md), and the questions
in [`first-agent/eval/rag/questions.md`](first-agent/eval/rag/questions.md).

## Projects

| project | port | role |
| --- | --- | --- |
| [`first-agent`](first-agent) | 3000 | chat app: the **Knowledge** agent (RAG / no RAG), the eval page at `/rag-report`, and the earlier agents (memory chat, Movie buff, Pipeline) |
| [`doc_index`](doc_index) | — | local vector index (EmbeddingGemma-300M + SQLite) that the Knowledge agent searches; Day 21's fixed vs structural [comparison](doc_index/reports/comparison.md) |
| [`imdb_mcp_server`](imdb_mcp_server) | 3001 | OMDb tools (Movie buff, Pipeline) |
| [`scheduler_mcp_server`](scheduler_mcp_server) | 3002 | pipelines, runs and records in SQLite (Pipeline) |

The Knowledge agent needs only `first-agent` and a built `doc_index`. The MCP servers are
for the older agents, which show their usual "server down" state without them.

## Run it

```bash
cd doc_index && npm install && npm run index      # first run downloads the model (~300 MB)
cd first-agent && npm install && npm start        # ANTHROPIC_API_KEY in first-agent/.env
```

Open http://localhost:3000, pick **Knowledge**, ask something like "How much does Compose
Multiplatform add to an iOS app's size?", then switch to **Without RAG** and ask again.
The embedding model loads on the first RAG question (about 1–3 s) and stays loaded.

```bash
cd first-agent
npm run eval:chat                # Day 25: two scripted conversations through the chat → reports/chat_*
npm run eval:rag                 # 17 questions × 4 modes, each judged → reports/rag_*.{md,json}
npm run eval:citations           # 10 questions, rag+rerank: citations, faithfulness, I don't know → reports/citations_*
npm run eval:rag -- q03          # one question
npm run eval:rag -- --modes rag,rag+rerank   # some modes
npm run eval:rag -- --check      # validate questions.json against the index, no API calls
```

Chat settings: `RAG_ROUTER_MODEL` (`claude-haiku-4-5-20251001`), `RAG_HISTORY_TURNS` (6).
Retrieval settings (all optional, in `first-agent/.env`): `RAG_K_FINAL` (5), `RAG_K_RETRIEVE`
(20, rerank only), `RAG_RERANK_THRESHOLD` (0.02), `RAG_STRATEGY` (`structural`),
`RAG_COLLECTIONS` (all; e.g. `knowledge`), `RAG_MIN_SCORE` (off). The reranker (~570 MB)
downloads on the first reranked question.

Tests (offline, no key, no model): `npm test` in `first-agent` and `doc_index`.
Spec: [`PROMPT.md`](PROMPT.md).

## Earlier days

- **Day 21:** [`doc_index`](doc_index), document indexing with two chunking strategies.
- **Day 20:** MCP orchestration ([demo video](https://github.com/user-attachments/assets/be711d68-1255-40fb-ac61-d11645b58893)).
  A Pipeline chat turns a goal into a plan across the OMDb, scheduler and Notion MCP servers;
  you accept it, and it runs once or on an interval. To use it, start `imdb_mcp_server`
  (`cp .env.example .env`, `OMDB_API_KEY`) and `scheduler_mcp_server` with `npm start`, connect
  Notion in the app, pick **Pipeline**, then **Generate plan**, **Accept**, **Run**. Planner
  eval: `npm run eval:planner` in `first-agent`.
