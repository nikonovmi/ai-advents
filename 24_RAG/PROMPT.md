# Day 24 — Citations, sources and "I don't know"

Make every RAG answer in `first-agent` follow a strict, verified contract: **an answer +
sources + citations** (verbatim excerpts from the retrieved chunks). Add an **"I don't
know" mode** that asks a clarifying question when the context isn't relevant enough.
Then test this with 10 questions. Read both READMEs and the Day 22–23 code (`src/rag/`,
`eval/rag/`, `/rag-report`) first. Reuse the retrieval pipeline, judge, and report page,
and build only what this spec asks for. Plain (no-RAG) mode is unchanged.

## Answer contract

In every RAG mode the answering LLM call uses a forced tool `submit_answer`, which
replaces the free text with `[n]` markers:

```js
{
  status: "answered" | "dont_know",
  answer: "Text with citation markers like [c1] after each claim.",   // empty for dont_know
  citations: [{ id: "c1", chunk_id: "…", quote: "verbatim excerpt from that chunk" }],
  clarifying_question: "…"                                           // required for dont_know
}
```

The system prompt rules:

- Every factual claim gets at least one `[cN]` marker.
- A quote is copied verbatim from the chunk it cites, one or two sentences long, and is
  the part that actually supports the claim.
- Use only the provided documents.
- If the documents don't contain the answer, return `dont_know` with a clarifying
  question. Don't stretch loosely related text to fit.

**Sources are not written by the model.** Code derives them from the chunk_ids that
were cited: `source › section · chunk_id`, deduplicated, in citation order. This rules
out invented sources.

## Verification (in code, after the call)

Check each answer for the following:

1. `answered` has at least 1 citation, and `dont_know` has a non-empty
   `clarifying_question`.
2. Every `[cN]` in the answer refers to an existing citation, and every citation is
   used in the answer.
3. Every `chunk_id` belongs to the chunks that were sent to the model.
4. Every `quote` occurs in its chunk's text, compared case-insensitively after
   normalising whitespace, quote marks, dashes, and line-break hyphenation. A quote that
   isn't found is a **fabricated quote**.
5. A quote is at least 4 words and at most about 60 words.

If any check fails, retry **once**, sending the list of errors back to the model (the
same pattern as the planner's validation retry). If it still fails, drop the invalid
citations and the claims that relied only on them. If no valid citation is left, turn
the result into a `dont_know`. Record what happened in the result as
`verification: { firstAttemptValid, retried, droppedCitations, downgraded }`.

## "I don't know" mode

The rule triggers in two ways, and both produce the same output: **"I don't know"**
followed by a clarifying question.

1. **Low relevance (before the LLM).** If the best rerank score is below
   `RAG_RERANK_THRESHOLD` (the Day 23 cutoff, unchanged), make one small LLM call (forced
   tool, temperature 0). It receives the question plus the title, section, and first
   150 characters of the top 3 rejected chunks, and returns a clarifying question. That
   question may point to what the documents *do* cover nearby, e.g. "Did you mean X or
   Y?", and must not answer anything itself.
2. **Relevant-looking chunks without the answer.** The model returns `dont_know` through
   the contract above.

This rule needs rerank. With rerank off, only case 2 applies, and the UI says so next to
the toggle. Add `dontKnow: { reason: "low_relevance" | "model" | "verification_failed" }`
to the result.

## UI (Knowledge agent)

- **Answer:** `[cN]` markers render as small clickable chips. Clicking one shows the
  quote highlighted inside its full chunk text.
- Under the answer, show **Sources** (the derived list) and **Citations** (each quote with
  its source › section).
- A small badge shows the verification result, for example "verified", "retried",
  "1 citation dropped", or "downgraded".
- **I don't know:** a distinct style showing "I don't know.", the clarifying question,
  and the reason. For low relevance, also show the best rejected chunks, as on Day 23.

## Test: 10 questions

Choose the 10 from the existing `eval/rag/questions.json` and tag them with
`"sets": ["citations"]`. Pick 7 that should be answered: corpus, near_miss,
multi_part, paraphrased, and messy, spread across documents. Add 3 that should produce
"I don't know": the existing `unanswerable` and `off_topic` questions, plus **one new
`ambiguous` question**. That one should be vague enough that a clarifying question is
the right reply, e.g. "how does it work?". Set `expect_decline: true` on it and update
the validation test.

`npm run eval:citations` runs the set in one mode, `rag+rerank` by default (override with
`--mode`), and checks each answer:

| check | how |
| --- | --- |
| has sources | `answered` ⇒ at least 1 derived source |
| has citations | `answered` ⇒ at least 1 valid citation |
| quotes are real | the code verification above; count fabricated quotes on the **first** attempt, before the retry fixes them |
| meaning matches citations | judge call (below) |
| correct "I don't know" | expected-decline questions ⇒ `dont_know` with a clarifying question; answerable ones ⇒ not `dont_know`, otherwise list it as a false IDK |

The **faithfulness judge** is one call with a forced tool and temperature 0. It
receives the answer split into claims (sentences with their markers) and the quotes each
claim cites, but not the full chunks and not the expected facts. Per claim, it returns
`supported | partial | unsupported`. It also returns `uncited_claims`: factual
statements in the answer that carry no marker. Faithfulness = supported / claims.
For answerable questions, also compute the existing Day 22 fact score, to show that
correctness didn't drop.

Write `reports/citations_results.json` and `reports/citations_report.md`, and add a
**Citations** tab to `/rag-report` that shows:

- **Summary:** % with sources, % with citations, fabricated quotes on the first attempt,
  retries, downgrades, mean faithfulness, uncited claims, correct and false IDKs, and the
  mean fact score.
- **Per question:** status, checks passed, faithfulness, and the verification outcome.
- **For each question:** the answer with its citations, and every claim with its judge
  verdict next to the quote it cites.
- **Findings** in `reports/citations_notes.md`, written from the actual numbers: how
  often the model fabricated or loosely paraphrased quotes, whether the retry fixed
  them, which claims were unsupported and why, and whether the IDK rule fired at the
  right times.

## Tests (offline, `npm test`)

Use a fake provider and fake judge. Never load real models in tests.

- **Quote matcher:** exact and normalised matches pass; a paraphrase or a quote from a
  different chunk fails.
- **Contract validation:** catches each of rules 1–5.
- **Retry:** a fabricated quote triggers one retry with the errors. A second failure
  drops the citation, and when none is left the answer is downgraded to `dont_know`.
- **Derived sources:** deduplicated, in citation order, and never containing a chunk
  that wasn't cited.
- **Low relevance:** the answering LLM is not called, and a clarifying question is
  returned.
- **Question file:** validates with the new set and the `ambiguous` type.

## Docs

Update `first-agent/README.md` with the answer contract, the verification steps, the
IDK rule, and `eval:citations`. Add the Day 24 line to the root README.

## Done when

1. In the UI, a corpus question shows an answer with clickable citations, sources, and a
   "verified" badge. The ambiguous and off-topic questions show "I don't know" with a
   clarifying question.
2. `npm run eval:citations` runs the 10 questions and writes the report with real numbers
   and findings.
3. `npm test` passes offline in `first-agent` and `doc_index`.
4. The Citations tab on `http://localhost:3000/rag-report` shows the results.

Run all four yourself and fix what fails. Leave the `first-agent` server running on port
3000 (if the port is taken, say so instead of switching ports), and check that `/` and
`/rag-report` respond. In the final message, include the summary table, any fabricated
quotes or false IDKs, and the two URLs.
