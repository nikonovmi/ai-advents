# Day 22 — First RAG query

Build on `doc_index/` (Day 21) and `first-agent/`. Add an agent that answers either
**with RAG** (question → retrieve chunks → put them in the prompt → LLM) or **without
RAG** (the same LLM, no documents). Add a 10-question eval that runs both modes and
writes a quality comparison. Read `doc_index/README.md` and `first-agent/README.md`
before starting, and follow the existing code style, providers, and test setup.

## Retrieval

- Use `search()` from `doc_index/src/search.js` with **`strategy: "structural"`**,
  `k = 5`. Don't reimplement or copy it.
- If `search()` can't filter by collection yet, add an optional
  `collections: string[]` filter in `doc_index`, using the `collection` column that
  already exists in `documents`. Add a test for it. The RAG default is all collections,
  configurable via `RAG_COLLECTIONS`.
- Add an optional `minScore` (default off). Log scores so a sensible threshold can be
  picked later.
- The embedding model takes a few seconds to load. Load it lazily on the first RAG query,
  reuse it afterwards, and log one line when it's ready. If the index is missing or was
  built with another model, return a clear error to the UI, not a stack trace.

## The RAG function

`src/rag/answer.js` exports one function used by both the chat and the eval:

```js
answerQuestion(question, { mode: "rag" | "plain", history = [], k, strategy, provider })
  → { answer, mode, chunks: [{ n, score, source, section, title, chunk_id, text }],
      usage, timings: { retrieveMs, llmMs } }
```

- **plain**: system prompt = a short neutral assistant prompt. The user message is the
  question.
- **rag**: same base system prompt plus document rules (below). The chunks go in the
  **latest user message**, not the system prompt:

```
<documents>
<doc n="1" source="…" section="…" title="…">
…chunk text…
</doc>
…
</documents>

Question: …
```

- Document rules in the RAG system prompt: answer only from the documents; cite with
  `[n]` after each claim; if the documents don't contain the answer, say so plainly
  and don't fill in from general knowledge; if they only partly cover it, answer that
  part and name what's missing.
- Both modes use the same model, max tokens, and `temperature: 0`, so the documents
  are the only difference. Use the model the project already uses for chat agents. Don't
  invent model ids.
- Build the prompt in one pure function (`buildRagPrompt(question, chunks)`) so it
  can be tested and shown in the eval report.

## Agent in first-agent

- Add a **Knowledge** agent in `src/agents.js` with its own chat list.
- Show a **With RAG / Without RAG** toggle in the chat header. The choice is stored per
  chat and sent with each message. Each assistant message records which mode produced
  it, shown as a small badge.
- Keep it a plain Q&A agent: short-term history only, no digest, profile, invariants, or
  task lifecycle. Otherwise memory would leak context into the comparison. Retrieval
  uses only the current question, not the history.
- Under a RAG answer, show a collapsible **Sources** list: `[n]` score · source ·
  section. Clicking one expands the chunk text. A plain answer shows no sources.
- Optional, if it's cheap: a **Compare** button that asks the same question in both
  modes and shows the answers side by side.
- It must work offline with the FakeProvider, which echoes something deterministic that
  shows whether documents were included. Tests must not load the embedding model.

## Test questions

Create `first-agent/eval/rag/questions.json` with exactly 10 questions. Write them only
after reading the actual corpus (the `documents` table, or the files in
`knowledge_database/`):

- **7 corpus questions** from `knowledge_database/`. Each needs details specific to
  those documents (numbers, names, specific claims, steps), so a model without RAG is
  unlikely to know them exactly. Spread them across different files.
- **2 general questions** on the corpus's topic that a strong model answers well without
  documents. Here, RAG should at least not hurt.
- **1 unanswerable question** that sounds like it belongs to the corpus but isn't
  covered by it. RAG should say the documents don't cover it. Plain mode will probably
  answer anyway; record that.
- Phrase the questions the way a user would ask them. Don't copy sentences from the
  documents, because that makes retrieval look better than it is.

Each entry:

```json
{
  "id": "q01",
  "type": "corpus" | "general" | "unanswerable",
  "question": "…",
  "expected_facts": ["2–4 short, checkable facts the answer must contain"],
  "expected_sources": ["source values exactly as stored in the index"],
  "notes": "why this question, what a wrong answer would look like"
}
```

`expected_sources` is empty for general (unless a document covers it) and for
unanswerable questions. Verify every `expected_sources` entry exists in the index and
that each `expected_fact` really appears in that source, and fail loudly otherwise.
Also write the same content as a readable table in `eval/rag/questions.md`
(question · expected outcome · sources).

## Eval

`npm run eval:rag [-- q03]` runs every question (or one) in both modes, judges the
answers, and writes `reports/rag_comparison.md` plus the raw results
`reports/rag_results.json`. It needs the real API key and a built index.

Per question, per mode:

1. **Retrieval** (rag only): `hit@k` = whether any expected source is among the
   retrieved chunks, plus the rank of the first hit. A failed rag answer is labelled a
   *retrieval miss* (no expected source retrieved) or a *generation miss* (sources were
   retrieved but facts are missing or wrong). This is the most useful diagnostic, so put
   it in the report.
2. **Judge**: one LLM call with a forced tool `submit_grade` and temperature 0. The
   judge sees the question, the expected facts, the question type, and the answer. It
   does **not** see the mode, so it grades blind. It returns per fact
   `present | partial | missing | contradicted`, plus `hallucination: boolean` (claims
   that are specific but unsupported or wrong), plus for unanswerable questions
   `declined: boolean`. Score = (present + 0.5 × partial) / facts.
3. **Citations** (rag only): every `[n]` refers to a retrieved chunk, and at least one
   cited chunk comes from an expected source.

`rag_comparison.md` contains:

- A summary table, plain vs rag: mean fact score, hallucinations, unanswerable
  declined, mean latency, mean input tokens. Also rag-only rows: hit@5, citation
  validity, and the retrieval vs generation miss counts.
- A per-question table: question · type · plain score · rag score · retrieval rank ·
  verdict.
- For each question: both answers in full, the retrieved chunks (source, section,
  score, first 200 chars), and the judge's per-fact grades.
- **Findings**: a short, honest analysis written from the numbers. Where RAG helped,
  where it didn't and why (retrieval or generation), what the unanswerable question
  showed, and 1–2 concrete changes for next time (k, chunking, prompt). Write it to
  `reports/rag_notes.md`, which gets included in the report, the same way `notes.md`
  works in `doc_index`.

## Tests (offline, `npm test`)

- `buildRagPrompt` numbers the docs, escapes nothing it shouldn't, and puts the
  documents in the user message.
- `answerQuestion` with a fake searcher and the FakeProvider: plain mode never calls
  search, and rag mode passes the chunks and returns them.
- Retrieval errors (missing index, wrong model) become a readable error.
- The question file validates: 10 entries, type counts 7/2/1, required fields present.
- The judge's tool call is parsed into a score correctly (with a fake judge response).

## Docs

- `first-agent/README.md`: add the Knowledge agent to Agents, add `eval:rag` to the
  scripts table, and add the env vars (`RAG_K`, `RAG_STRATEGY`, `RAG_COLLECTIONS`,
  `RAG_MIN_SCORE`).
- Root README: update it for Day 22, with a link to `reports/rag_comparison.md`.

## Results in the browser

Everything runs from the existing `first-agent` server at **http://localhost:3000**.
Don't create a second server or port.

- **Knowledge agent** on the main page, as described above.
- **Eval results page** at `http://localhost:3000/rag-report`, linked from the
  Knowledge agent's header. It reads `reports/rag_results.json` on each request and
  renders it with plain HTML/CSS/JS in the style of the existing front end:
  - the summary table (plain vs rag);
  - the per-question table, where each row expands to show both answers side by side,
    the retrieved chunks with source, section, and score, and the judge's per-fact
    grades;
  - the findings from `rag_notes.md`.

  If no results exist yet, show a short message: run `npm run eval:rag`.
- The Knowledge agent must work even when the OMDb, scheduler, or Notion MCP servers
  aren't running. Those agents can show their usual "server down" state.

## Done when

1. In the UI, the Knowledge agent answers a corpus question with citations and sources
   in RAG mode, and without them in plain mode.
2. `npm run eval:rag` completes all 20 runs and writes the report with real numbers and
   findings.
3. `npm test` passes offline in `first-agent` and `doc_index`.
4. `http://localhost:3000/rag-report` shows the results of step 2.

Run all four yourself and fix what fails. Then **leave the `first-agent` server running
on port 3000** (`npm start`; if the port is taken, say so instead of switching ports).
Before finishing, check with a request to `http://localhost:3000/` and
`http://localhost:3000/rag-report` that both respond.

In the final message, include the summary table, the three most interesting
per-question results, and the two URLs to open.
