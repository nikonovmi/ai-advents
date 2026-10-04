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
| `npm run eval:rag [-- q03]` | 10 questions × With RAG / Without RAG, judged blind → [`reports/rag_comparison.md`](reports/rag_comparison.md), `reports/rag_results.json`; needs the key and a built `../doc_index` |
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
  **With RAG / Without RAG** switch in the header (stored per chat, sent with each
  message). It keeps short-term history only (last 6 messages): no digest, profile,
  invariants or lifecycle, so the documents are the only difference between the modes.
  Each reply has a mode badge; a RAG reply lists its **Sources** (`[n]` score · source ·
  section, click for the chunk text). **Compare** asks one question both ways side by
  side. **Eval results** opens http://localhost:3000/rag-report. Works without any MCP
  server running.

## RAG (`src/rag/`)

`answerQuestion(question, { mode, history, k, strategy, provider })` in `answer.js` is used
by the chat and the eval, and returns `{ answer, mode, chunks, usage, timings }`.

- **plain**: a short neutral system prompt (`BASE_SYSTEM`) and the question.
- **rag**: doc_index `search()` with the question alone (never the history). Chunks below
  `RAG_MIN_SCORE` are dropped and the scores are logged. The rest go into the **latest
  user message** as `<documents><doc n source section title>…</doc></documents>`, built by
  `buildRagPrompt(question, chunks)` (`prompt.js`), with document rules in the system
  prompt: answer only from the documents, cite `[n]`, say plainly when they don't cover it.
- Both modes use the provider's default chat model, `temperature: 0`, max 1024 tokens.
- The embedding model loads on the first RAG question (one log line when ready) and is
  reused. A missing index or one built with another model is a readable 503, not a stack.

| env | default | |
| --- | --- | --- |
| `RAG_K` | `5` | chunks per question |
| `RAG_STRATEGY` | `structural` | `structural` or `fixed` |
| `RAG_COLLECTIONS` | all | comma list of `knowledge`, `projects`, `downloads` |
| `RAG_MIN_SCORE` | off | drop chunks scoring below it |
| `RAG_JUDGE_MODEL` | the chat model | judge for `eval:rag` |
| `DOC_INDEX_DIR` | `../doc_index` | |

Routes: `PUT /conversations/:id/rag` `{ mode }`, `POST /rag/compare` `{ question }`,
`GET /rag/status`, `GET /rag-report` (page) and `GET /rag-report/data` (reads
`reports/rag_results.json` and `rag_notes.md` on every request).

### Eval (`npm run eval:rag`)

[`eval/rag/questions.json`](eval/rag/questions.json) holds 10 questions: 7 corpus, 2 general
and 1 unanswerable ([table](eval/rag/questions.md)). Each expected fact has an `evidence`
quote, and every run first checks that each quote appears verbatim in its expected source
in the index, failing loudly if not. Then for each question and mode it records:

- **retrieval** (rag): hit@k and the rank of the first expected source. A failed RAG answer
  is labelled a *retrieval miss* or a *generation miss*.
- **judge**: one forced `submit_grade` call at temperature 0 that sees the question, type,
  expected facts and answer, but not the mode (`[n]` markers are stripped). It grades each
  fact `present | partial | missing | contradicted` and sets `hallucination` and `declined`.
  Score = (present + 0.5 × partial) / facts.
- **citations** (rag): every `[n]` is a retrieved chunk, and at least one comes from an
  expected source.

Output: [`reports/rag_comparison.md`](reports/rag_comparison.md) (summary, per-question
table, both answers, chunks and grades) and `reports/rag_results.json`.
[`reports/rag_notes.md`](reports/rag_notes.md) is the hand-written findings, included in
the report. Latest run: mean fact score 0.21 plain vs 0.89 RAG, hallucinations 4 vs 0, hit@5 8/8.

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
