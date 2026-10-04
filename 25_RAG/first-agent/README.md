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
| `npm run eval:rag [-- q03] [-- --modes rag,rag+rerank]` | 17 questions × 4 modes (`plain`, `rag`, `rag+rerank`, `rag+rewrite+rerank`), judged blind → [`reports/rag_comparison.md`](reports/rag_comparison.md), `reports/rag_results.json`; needs the key and a built `../doc_index` |
| `npm run eval:citations [-- --mode rag] [-- q17]` | the 10 `citations` questions in one mode (default `rag+rerank`): sources, citations, fabricated quotes, faithfulness judge, "I don't know" → [`reports/citations_report.md`](reports/citations_report.md), `reports/citations_results.json`; `--report` re-renders with `reports/citations_notes.md` |
| `npm run eval:chat [-- scenario-1] [-- --check] [-- --report]` | Day 25: replays the two scripted conversations in [`eval/chat/`](eval/chat) through `POST /chat` with the real router, model, index and reranker; per-turn checks and judges → [`reports/chat_report.md`](reports/chat_report.md), `reports/chat_results.json`, with the hand-written [`reports/chat_notes.md`](reports/chat_notes.md); `--check` validates the scenario files only |
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
- **Knowledge**: a multi-turn chat over the [`../doc_index`](../doc_index) vector index
  (Day 25, [below](#chat-with-task-memory-day-25)), with a **With RAG / Without RAG** switch in
  the header and, while RAG is on, a **Rerank** switch (on by default; stored per chat, sent
  with each message). With RAG, every message goes through a router and the chat keeps a small
  **task memory** (goal, clarified details, constraints, open questions) shown in the side
  panel; Without RAG it is Day 22's plain answer with the last 6 messages. No digest,
  profile, invariants or lifecycle.
  Each reply has a mode badge (`rag`, `rag+rerank`, `rag+rewrite+rerank`, …); a RAG reply
  lists its **Sources** (`[n]` vector score → rerank score · source · section, click for
  the chunk text), the queries searched when rewritten, and the dropped candidates
  (greyed, collapsed). A reply declined by the cutoff shows the best rejected chunks. **Compare** asks one question both ways side by
  side. **Eval results** opens http://localhost:3000/rag-report. Works without any MCP
  server running.

## Chat with task memory (Day 25)

With RAG on, the Knowledge chat is routed turn by turn (`src/rag/chatTurn.js`, used by `POST /chat`
and by `eval:chat`):

```
message → router (LLM call 1) → apply memory patch → branch on intent
  chat / memory_only → the router's reply                              (1 call)
  search → retrieve → rerank → cutoff → answer + verify                (2 calls)
           └ nothing relevant → "I don't know" + clarifying question   (2 calls)
```

**Router** (`router.js`): one forced `route` call per message, `RAG_ROUTER_MODEL` (Haiku 4.5 by
default), temperature 0. It sees the new message, the last `RAG_HISTORY_TURNS` messages (earlier
assistant messages cut to ~300 characters with citations stripped; never the chunks) and the task
memory, and returns `{ intent, standalone_question, queries, reply, memory_patch }`:

- `search`: anything that asks about content, including "why?" and "and the other one?"; any
  question, even off-topic; a message that mixes kinds; a reply to an open clarifying question
  (its `standalone_question` is the original question with the clarification applied); and
  whenever the router is unsure.
- `memory_only`: only a constraint, correction, preference or term definition. `chat`: greetings,
  thanks, acknowledgements. Both show the router's short `reply`; nothing is searched.
- `queries`: 1–3 short search queries (Day 23's rules) with the resolved subject and clarified
  terms, never the goal or the constraints.
- **Code overrides:** a missing or invalid intent becomes `search`; while an open question
  exists, anything but `chat` becomes `search`. The override is recorded and shown.

**Search turns** run Day 23's pipeline with the router's `queries` (the Rewrite stage is not used:
the router writes the queries) and **rerank against `standalone_question`**, not the raw message,
with the same cutoff and `K_RETRIEVE` / `K_FINAL`. The answering call is Day 24's `submit_answer`
contract and verification, plus the task memory (before the documents), the last
`RAG_HISTORY_TURNS` messages, and the user's message next to the resolved question. Extra rules:
follow the memory's constraints (length, terms, focus); document facts need `[cN]`; something
from the user's own earlier messages is written "(as you said)" without a citation; the task
memory is never a source. An "I don't know" works as on Day 24, and **code** then adds its
clarifying question to `open_questions`, so the next message can answer it.

**Task memory** (`taskMemory.js`), per chat, on the conversation record:

```js
{ goal: string | null,
  clarified: [{ id, text, turn }],        // details the user clarified        (ids d<turn>)
  constraints: [{ id, text, turn }],      // rules and terms the user set      (ids k<turn>)
  open_questions: [{ id, text, turn, question }] }  // clarifying questions asked (ids q<turn>)
```

The router's `memory_patch` is a list of operations — `set_goal`, `add_clarified`,
`add_constraint`, `remove` (by id), `resolve_question` (by id) — never a rewrite. Code applies
them one by one; an unknown op or id (or an empty or duplicate item) is logged and skipped,
never fatal, and nothing leaves the memory except by `remove` or `resolve_question`. The router
is told: a change of direction sets the new goal and removes the details that no longer apply; a
correction replaces the item it corrects; never store what the documents said; resolve every
open question the user answers or drops. Each user message stores its `route`: intent (and any
override), standalone question, queries, the patch as proposed, what was applied and skipped,
the open question added, the memory after the turn and its diff, and the router and answer
latency.

**In the page**, each user message has an intent badge (`search`, `memory`, `chat`; `*` marks a
code override); a search badge opens to the standalone question and the queries. The side
panel shows the task memory — goal, clarified, constraints & terms, open questions — with the
latest turn's additions tinted and removals struck through, and a **Reset** button
(`DELETE /conversations/:id/task-memory`). Everything from Day 24 is unchanged: citation chips,
sources, the verification badge, "I don't know" with its clarifying question.

| env | default | |
| --- | --- | --- |
| `RAG_ROUTER_MODEL` | `claude-haiku-4-5-20251001` | the router's model |
| `RAG_HISTORY_TURNS` | `6` | recent messages the router and the answering call see |

### Chat eval (`npm run eval:chat`)

Two scripted conversations, written from the corpus, in [`eval/chat/`](eval/chat):
`scenario-1.json` (deep dive: Compose Multiplatform for an iOS app, 13 messages) and
`scenario-2.json` (comparison: two Kotlin 2.4 articles, then a change of direction to a
navigation choice, 13 messages). Each message has `expected_intent`, `expect: { decline,
sources, facts }`, optional `memory_checkpoint` and `constraint_check`, and `tags` naming the
required elements it carries (goal, constraint, term, reference, vague → clarification,
correction, chat, off-topic → return, change of direction, late reference outside the history
window), which `npm test` checks are all present.

The runner mounts `ragRoutes` on an in-process server with an in-memory store and replays each
scenario through `POST /chat` on a fresh chat — the page's own code path — with real calls.
Per turn:

| check | how |
| --- | --- |
| intent | router intent (after overrides) vs `expected_intent` |
| sources + citations | search turns: ≥ 1 source and ≥ 1 verified citation, or a correct "I don't know" when `decline` is true; fabricated quotes on the first attempt are counted |
| expected source | when `expect.sources` is given: in the kept chunks and cited |
| constraint | `constraint_check`: sentences (Day 24's claim splitter) / words, mechanically |
| memory checkpoint | judge (`submit_memory_check`): does the memory reflect each statement; stale items (corrected, left behind by a change of direction, or not the user's) fail it |
| on track | judge (`submit_on_track`): does the reply address the resolved question, consistent with the goal and constraints; plus Day 24's faithfulness judge — an unsupported claim fails it |
| facts | when `expect.facts` is given: Day 22's fact judge, score ≥ 0.75 and no hallucination |

Output: `reports/chat_results.json`, [`reports/chat_report.md`](reports/chat_report.md) (summary
per scenario, every turn with its route, answer, memory diff and checks), the hand-written
[`reports/chat_notes.md`](reports/chat_notes.md), and the **Chat** tab at
http://localhost:3000/rag-report#chat (summary per scenario and both turn-by-turn timelines,
failing turns outlined).

## RAG (`src/rag/`)

```
question → [rewrite] → vector search (K_RETRIEVE) → [rerank + cutoff] → top K_FINAL → LLM
```

`answerQuestion(question, { mode, rerank, rewrite, history, provider, … })` in `answer.js` is
used by the chat and the eval. It returns `{ answer, mode, label, queries, candidates, chunks,
declined, rejected, usage, usageByStage, timings: { rewriteMs, retrieveMs, rerankMs, clarifyMs, llmMs } }`,
and in RAG modes also `{ status, citations, sources, clarifyingQuestion, dontKnow, verification }`
(the answer contract below).

- **plain**: a short neutral system prompt (`BASE_SYSTEM`) and the question.
- **rag** (both stages off, the Day 22 baseline): doc_index `search()` with the question alone
  (never the history), top `K_FINAL` by vector score, no cutoff. Chunks below `RAG_MIN_SCORE`
  are dropped and the scores are logged. The rest go into the **latest user message** as
  `<documents><doc n chunk_id source section title>…</doc></documents>`, built by
  `buildRagPrompt(question, chunks)` (`prompt.js`), with document rules in the system prompt.
  The answer comes back through the **answer contract** (below): `[cN]` markers, verbatim
  quotes, verified in code, or `dont_know`.
- **Rewrite** (`rewrite.js`): one call to the chat model, temperature 0, forced
  `submit_queries`, turns the question into 1–3 standalone search queries (filler stripped,
  the documents' terms, one query per part). Each is searched and the results are merged by
  `chunk_id`, keeping each chunk's best score. The model still answers the **original** question.
- **Rerank** (`reranker.js` → `../doc_index/src/rerank.js`): `K_RETRIEVE` candidates per query
  are scored by a local cross-encoder, `onnx-community/bge-reranker-v2-m3-ONNX` (int8, ~570 MB,
  downloaded on first use), against the **original** question. Logit → sigmoid (0–1), sorted,
  below `RAG_RERANK_THRESHOLD` dropped, top `K_FINAL` kept. **If nothing passes**, the answering
  model is not called: the reply is "I don't know" plus a clarifying question from one small
  call, and the 3 best rejected chunks are shown. Pairs are scored one at a time: the int8 model quantizes per batch, so
  padding a batch shifted every score depending on its neighbours (and was slower on CPU).
  About 7 s per 20 candidates on a laptop CPU.
- Every mode uses the provider's default chat model and `temperature: 0`; plain answers get max
  1024 tokens, `submit_answer` 2048.
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

Routes: `PUT /conversations/:id/rag` `{ mode?, rerank?, rewrite? }`, `DELETE /conversations/:id/task-memory` (Day 25), `POST /rag/compare`
`{ question, rerank?, rewrite? }`, `GET /rag/status`, `GET /rag-report` (page) and
`GET /rag-report/data` (reads `reports/rag_results.json`, `rag_notes.md`, `citations_results.json`,
`citations_notes.md`, `chat_results.json` and `chat_notes.md` on every request; the page has a
**Modes**, a **Citations** and a **Chat** tab).

### Answer contract (Day 24, `contract.js`)

Every RAG answer is one forced `submit_answer` call (temperature 0, max 2048 tokens because the
quotes and chunk_ids count too) instead of free text. Each document in the prompt carries its
`chunk_id`.

```js
{
  status: "answered" | "dont_know",
  answer: "Text with a marker after each claim [c1].",      // empty for dont_know
  citations: [{ id: "c1", chunk_id: "…", quote: "verbatim excerpt from that chunk" }],
  clarifying_question: "…"                                  // required for dont_know
}
```

The rules in the system prompt: every factual claim ends with at least one `[cN]` marker, just
before its final punctuation; a quote is one or two sentences copied verbatim from the chunk it
cites (4–60 words), the part that supports the claim; only the documents are used; if they don't
contain the answer, return `dont_know` with a clarifying question rather than stretching loosely
related text.

**Sources are never written by the model.** `deriveSources` builds them from the cited chunk_ids:
`source › section · chunk_id`, one per chunk, in the order the answer first cites them.

**Verification**, in code after the call (`verifySubmission`):

1. `answered` has ≥ 1 citation; `dont_know` has a non-empty `clarifying_question`.
2. Every `[cN]` is a citation, and every citation is used.
3. Every `chunk_id` is one of the chunks that were sent.
4. Every quote is in its chunk (`quotes.js`: compared case-insensitively after normalising
   whitespace, quote marks and backticks, dashes, `…`, and line-break hyphenation). A quote that
   isn't found is a **fabricated quote**.
5. A quote is 4–60 words.

Any failure gets **one** retry, with the list of errors sent back as the tool result (the
planner's pattern). If the retry fails too, the invalid citations are dropped, along with every
sentence whose markers were all invalid. With no valid citation left, the answer becomes
`dont_know`. The result records `verification: { firstAttemptValid, retried, droppedCitations,
droppedClaims, downgraded, firstAttemptErrors, fabricatedFirstAttempt, … }`.

**"I don't know"** has two triggers, and both reply "I don't know." plus a clarifying question:

1. **Low relevance** (rerank on): if the best rerank score is under `RAG_RERANK_THRESHOLD`, the
   answering model is not called. One small forced call (`clarify.js`, `submit_clarification`,
   temperature 0) sees the question and the title, section and first 150 characters of the top 3
   rejected chunks. It writes a clarifying question, which may offer what the documents cover
   nearby ("Did you mean X or Y?") but never answers.
2. **The model's own `dont_know`**, through the contract.

With rerank off there is no relevance score, so only trigger 2 applies; the UI says so next to
the switch. `dontKnow: { reason: "low_relevance" | "model" | "verification_failed" }`.

**In the chat**, `[cN]` markers render as chips. Clicking one shows its quote highlighted in the
full chunk text. Under the answer are a verification badge (`verified`, `retried → verified`,
`1 citation dropped`, `downgraded`; hover for the errors), **Sources** (derived) and
**Citations** (each quote with its source › section), then the retrieved chunks as before. An
"I don't know" reply has its own style, with the clarifying question and the reason. A
low-relevance one also shows the best rejected chunks.

### Citations eval (`npm run eval:citations`)

The 10 questions tagged `"sets": ["citations"]` in `questions.json`: 7 to answer (q02, q04, q06
corpus, q12 near_miss, q14 paraphrased, q15 messy, q16 multi_part, across 7 documents) and 3 to
decline (q10 unanswerable, q13 off_topic, and Day 24's q17 `ambiguous`, "How does it work?").
They run in one mode, `rag+rerank` by default (`--mode` to change it). Per question:

| check | how |
| --- | --- |
| has sources | answerable ⇒ answered with ≥ 1 derived source |
| has citations | answerable ⇒ answered with ≥ 1 valid citation |
| quotes are real | no fabricated quote on the **first** attempt, before the retry fixes it |
| meaning matches citations | faithfulness judge ≥ 0.75 and no `unsupported` claim |
| correct "I don't know" | to-decline ⇒ `dont_know` with a clarifying question; answerable ⇒ not `dont_know` (else a **false IDK**) |

The **faithfulness judge** (`faithfulness.js`) is one forced `submit_faithfulness` call at
temperature 0. It sees the answer cut into claims (sentences with their markers) and the quotes
each cited claim uses, but not the chunks or the expected facts. It rates each cited claim
`supported | partial | unsupported` and lists `uncited_claims`, the factual sentences with no
marker. Faithfulness = supported / cited claims. Answerable questions also get Day 22's fact
judge, to check that correctness didn't drop. Output: `reports/citations_results.json`,
[`reports/citations_report.md`](reports/citations_report.md) with the hand-written
[`reports/citations_notes.md`](reports/citations_notes.md), and the **Citations** tab at
http://localhost:3000/rag-report#citations.

### Eval (`npm run eval:rag`)

[`eval/rag/questions.json`](eval/rag/questions.json) holds 17 questions ([table](eval/rag/questions.md)):
Day 22's 10 unchanged as the regression set (7 corpus, 2 general, 1 unanswerable) plus 6 for
Day 23: 2 `near_miss` (baseline vector search ranks the answer chunk 4th and 2nd), 1
`off_topic`, 1 `paraphrased`, 1 `messy`, 1 `multi_part` (two documents), and Day 24's 1 `ambiguous`.
The unanswerable, off-topic and ambiguous ones carry `expect_decline: true`. 10 are tagged
`"sets": ["citations"]`, and `validateQuestions` checks that set's mix too. Each expected fact has an `evidence` quote, and
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
