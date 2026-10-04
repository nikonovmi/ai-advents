# Day 23 — Reranking, filtering and query rewriting

https://github.com/user-attachments/assets/3b4be32d-f755-48ca-a137-755c28a3979a

**Day 23:** the Knowledge agent's RAG gets two optional stages, switched per chat next to the
RAG toggle: **Rewrite** (one model call → 1–3 search queries, results merged) and **Rerank**
(a local cross-encoder, bge-reranker-v2-m3, scores 20 candidates against the question, drops
those under **0.02**, keeps the top 5, and declines without calling the model if none pass).
The Sources panel shows vector → rerank scores, the dropped candidates and the queries.
`npm run eval:rag` now runs 16 questions × 4 modes
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
npm run eval:rag                 # 16 questions × 4 modes, each judged → reports/rag_*.{md,json}
npm run eval:rag -- q03          # one question
npm run eval:rag -- --modes rag,rag+rerank   # some modes
npm run eval:rag -- --check      # validate questions.json against the index, no API calls
```

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
