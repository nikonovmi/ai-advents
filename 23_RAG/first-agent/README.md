# first-agent

A chat app with layered memory, a task lifecycle, MCP tools, planned pipelines, and a
**Knowledge** agent that answers with or without RAG over [`../doc_index`](../doc_index).
Node + Express, vanilla front end, no build step.

```bash
npm install
echo 'ANTHROPIC_API_KEY=sk-ant-…' > .env    # omit for the offline FakeProvider
npm start                                   # http://localhost:3000
```

The Knowledge agent also needs a built index: `cd ../doc_index && npm install && npm run index`.

| script | does |
| --- | --- |
| `npm test` | offline tests: no key, no network |
| `npm run eval:planner [-- <goal id>]` | plans 8 goals with the real model; exit 1 on a wrong tool sequence |
| `npm run eval:rag [-- q03] [-- --modes rag,rag+rerank]` | 16 questions × 4 modes (`plain`, `rag`, `rag+rerank`, `rag+rewrite+rerank`), judged blind → [`reports/rag_comparison.md`](reports/rag_comparison.md), `reports/rag_results.json`; needs the key and a built `../doc_index` |
| `npm run eval:rag -- --check` / `--report` | only validate [`eval/rag/questions.json`](eval/rag/questions.json) against the index (and write `questions.md`) / only re-render the report with `reports/rag_notes.md` |
| `npm run mcp:tools [-- omdb]` | list one MCP server's tools |
| `npm run mcp:call -- omdb get_movie '{"title":"Inception"}'` | call one MCP tool directly |
| `npm run lifecycle` / `scenario` / `compare` | memory and task-lifecycle demos |

## Agents

Defined in `src/agents.js`; each has its own chat list.

- **first-agent**, **pirate support**: plain chat with memory (short-term, digest,
  working task, long-term profile, project invariants) and the
  `planning → execution → validation → done` lifecycle.
- **Movie buff**: chat that calls the OMDb tools.
- **Pipeline** (`claude-sonnet-5`): each chat is one pipeline. Read-only feed of runs.
- **Knowledge**: plain Q&A over the [`../doc_index`](../doc_index) vector index, with a
  **With RAG / Without RAG** switch in the header, and while RAG is on, **Rerank** and
  **Rewrite** switches (all stored per chat, sent with each message). It keeps short-term history only (last 6 messages): no digest, profile,
  invariants or lifecycle, so the documents are the only difference between the modes.
  Each reply has a mode badge (`rag`, `rag+rerank`, `rag+rewrite+rerank`, …); a RAG reply
  lists its **Sources** (`[n]` vector score → rerank score · source · section, click for
  the chunk text), the queries searched when rewritten, and the dropped candidates
  (greyed, collapsed). A reply declined by the cutoff shows the best rejected chunks. **Compare** asks one question both ways side by
  side. **Eval results** opens http://localhost:3000/rag-report. Works without any MCP
  server running.

## RAG (`src/rag/`)

```
question → [rewrite] → vector search (K_RETRIEVE) → [rerank + cutoff] → top K_FINAL → LLM
```

`answerQuestion(question, { mode, rerank, rewrite, history, provider, … })` in `answer.js` is
used by the chat and the eval. It returns `{ answer, mode, label, queries, candidates, chunks,
declined, rejected, usage, usageByStage, timings: { rewriteMs, retrieveMs, rerankMs, llmMs } }`.

- **plain**: a short neutral system prompt (`BASE_SYSTEM`) and the question.
- **rag** (both stages off, the Day 22 baseline): doc_index `search()` with the question alone
  (never the history), top `K_FINAL` by vector score, no cutoff. Chunks below `RAG_MIN_SCORE`
  are dropped and the scores are logged. The rest go into the **latest user message** as
  `<documents><doc n source section title>…</doc></documents>`, built by
  `buildRagPrompt(question, chunks)` (`prompt.js`), with document rules in the system prompt:
  answer only from the documents, cite `[n]`, say plainly when they don't cover it.
- **Rewrite** (`rewrite.js`): one call to the chat model, temperature 0, forced
  `submit_queries`, turns the question into 1–3 standalone search queries (filler stripped,
  the documents' terms, one query per part). Each is searched and the results are merged by
  `chunk_id`, keeping each chunk's best score. The model still answers the **original** question.
- **Rerank** (`reranker.js` → `../doc_index/src/rerank.js`): `K_RETRIEVE` candidates per query
  are scored by a local cross-encoder, `onnx-community/bge-reranker-v2-m3-ONNX` (int8, ~570 MB,
  downloaded on first use), against the **original** question. Logit → sigmoid (0–1), sorted,
  below `RAG_RERANK_THRESHOLD` dropped, top `K_FINAL` kept. **If nothing passes**, the model is
  not called: the answer is a fixed "the documents do not cover this" message plus the 3 best
  rejected chunks. Pairs are scored one at a time: the int8 model quantizes per batch, so
  padding a batch shifted every score depending on its neighbours (and was slower on CPU).
  About 7 s per 20 candidates on a laptop CPU.
- Every mode uses the provider's default chat model, `temperature: 0`, max 1024 tokens.
- The embedding model and the reranker each load on first use (one log line when ready) and
  are reused. A missing index or one built with another model is a readable 503, not a stack.

| env | default | |
| --- | --- | --- |
| `RAG_K_FINAL` | `5` | chunks sent to the model (`RAG_K`, Day 22's name, still works) |
| `RAG_K_RETRIEVE` | `20` | vector candidates when rerank is on, per query when rewriting; with rerank off, `K_FINAL` are retrieved |
| `RAG_RERANK_THRESHOLD` | `0.02` | cutoff on the 0–1 rerank score |
| `RAG_STRATEGY` | `structural` | `structural` or `fixed` |
| `RAG_COLLECTIONS` | all | comma list of `knowledge`, `projects`, `downloads` |
| `RAG_MIN_SCORE` | off | drop chunks whose vector score is below it |
| `RAG_JUDGE_MODEL` | the chat model | judge for `eval:rag` |
| `DOC_INDEX_DIR` | `../doc_index` | |

**Threshold 0.02**: on doc_index's 20 retrieval questions (not the answer eval), the chunks
holding the expected text scored a median 0.92 and a minimum 0.010. 0.02 keeps 19 of 20, losing
only a chunk that was already 10th by vector score, and drops 63% of the other candidates.
The numbers are in [`reports/rag_notes.md`](reports/rag_notes.md).

Routes: `PUT /conversations/:id/rag` `{ mode?, rerank?, rewrite? }`, `POST /rag/compare`
`{ question, rerank?, rewrite? }`, `GET /rag/status`, `GET /rag-report` (page) and
`GET /rag-report/data` (reads `reports/rag_results.json` and `rag_notes.md` on every request).

### Eval (`npm run eval:rag`)

[`eval/rag/questions.json`](eval/rag/questions.json) holds 16 questions ([table](eval/rag/questions.md)):
Day 22's 10 unchanged as the regression set (7 corpus, 2 general, 1 unanswerable) plus 6 for
Day 23: 2 `near_miss` (baseline vector search ranks the answer chunk 4th and 2nd), 1
`off_topic`, 1 `paraphrased`, 1 `messy`, 1 `multi_part` (two documents). The unanswerable and
off-topic ones carry `expect_decline: true`. Each expected fact has an `evidence` quote, and
every run first checks that each quote appears verbatim in its expected source in the index,
failing loudly if not.

Every question runs in each mode (`--modes` picks some: `plain`, `rag`, `rag+rerank`,
`rag+rewrite`, `rag+rewrite+rerank`) and records:

- **judge**: one forced `submit_grade` call at temperature 0 that sees the question, type,
  expected facts and answer, but not the mode (`[n]` markers are stripped). It grades each
  fact `present | partial | missing | contradicted` and sets `hallucination` and `declined`.
  Score = (present + 0.5 × partial) / facts.
- **retrieval** (RAG modes): whether an expected source is in the final chunks, its rank
  before the rerank (vector order) and after, and **noise**: final chunks from no expected
  source.
- **declines**: correct (on `expect_decline`) vs wrong (on an answerable question), each
  wrong one named and marked `cutoff` or `model`.
- **citations**: every `[n]` is a sent chunk, and at least one comes from an expected source.
- **cost**: input tokens (rewrite + answer) and latency per stage.

Output: [`reports/rag_comparison.md`](reports/rag_comparison.md) (summary with modes as
columns, per-question scores and ranks, every answer with its queries and kept / dropped
candidates) and `reports/rag_results.json`. [`reports/rag_notes.md`](reports/rag_notes.md) is
the hand-written findings, included in the report and on `/rag-report`.

## Pipelines

1. **Goal → proposal.** *Generate plan* calls the planner (`src/pipeline/planner.js`)
   once, with `submit_plan` forced. It sees a catalog of the agent's `plannerTools`, as
   `server.tool` with description, inputSchema and outputSchema, plus which servers are down.
2. **Validation** (`src/pipeline/validatePlan.js`): tools exist, args match the
   inputSchema, and every `{{steps.N.path}}` exists in step N's output shape. An invalid
   plan gets one retry with its errors; still invalid → nothing stored.
3. **Accept → plan.** Runs (Run button, or every N ≥ 15 s) always execute the accepted
   plan; the planner is not called.
4. **Repair.** After a failed run the planner proposes a fix once; it waits for Accept.

Steps:

- `tool { server, tool, args }`: one MCP call made by code.
- `prompt { text, format: "text" | "json", outputSchema? }`: one model call from a
  fresh context, up to 4096 output tokens. A json step returns an object checked
  against its `outputSchema`.

Templates: `{{prev}}`, `{{steps.N.path}}`, `{{now}}`. `scheduler.record` / `aggregate`
always get the chat's own `scheduleId`. The first failing step stops the run; click a
step in a run's strip to see its exact input and output.

## MCP servers

| id | url | auth |
| --- | --- | --- |
| `notion` | `https://mcp.notion.com/mcp` | OAuth: press Connect in the panel; tokens in `data/mcp/notion.json` (git-ignored) |
| `omdb` | `http://127.0.0.1:3001/mcp` | none, [`../imdb_mcp_server`](../imdb_mcp_server) |
| `scheduler` | `http://127.0.0.1:3002/mcp` | none, [`../scheduler_mcp_server`](../scheduler_mcp_server) |

URLs can be overridden with `NOTION_MCP_URL`, `OMDB_MCP_URL`, `SCHEDULER_MCP_URL`.

## Pipeline routes

| route | does |
| --- | --- |
| `GET`/`PUT /conversations/:id/pipeline` | `{ goal, mode, intervalSeconds, enabled }`; GET also returns `plan`, `proposal` |
| `POST /conversations/:id/pipeline/plan` | `{ goal? }` → run the planner, store the proposal (422 with `errors` if invalid) |
| `POST /conversations/:id/pipeline/proposal` | `{ action: "accept" \| "discard" }` |
| `POST /conversations/:id/pipeline/run` | run the accepted plan now |
| `GET /conversations/:id/runs[/:runId]` | recent runs; one run's steps with input and output |
