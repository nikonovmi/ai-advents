/**
 * **The pure half of `eval:rag`**: the question file's rules, retrieval and
 * citation checks, the verdicts, the summary, and the Markdown report. No model,
 * no index, no files — `scripts/eval-rag.js` does the I/O.
 */

export const QUESTION_TYPES = { corpus: 7, general: 2, unanswerable: 1 };
const PASS_SCORE = 0.75;

// ---- the question file -------------------------------------------------------

/** Shape and counts. @returns {string[]} errors, empty when valid */
export function validateQuestions(questions) {
  const errors = [];
  if (!Array.isArray(questions)) return ["questions.json must be an array"];
  if (questions.length !== 10) errors.push(`expected exactly 10 questions, got ${questions.length}`);
  const ids = new Set();
  for (const [i, q] of questions.entries()) {
    const at = q?.id ? `${q.id}` : `entry ${i}`;
    if (typeof q?.id !== "string" || !q.id) errors.push(`${at}: id is required`);
    else if (ids.has(q.id)) errors.push(`${at}: duplicate id`);
    ids.add(q?.id);
    if (!(q?.type in QUESTION_TYPES)) errors.push(`${at}: type must be one of ${Object.keys(QUESTION_TYPES).join(", ")}`);
    if (typeof q?.question !== "string" || !q.question.trim()) errors.push(`${at}: question is required`);
    if (typeof q?.notes !== "string" || !q.notes.trim()) errors.push(`${at}: notes are required`);
    const facts = q?.expected_facts;
    if (!Array.isArray(facts) || facts.length < 2 || facts.length > 4 || !facts.every((f) => typeof f === "string" && f.trim())) {
      errors.push(`${at}: expected_facts must be 2–4 non-empty strings`);
    }
    if (!Array.isArray(q?.expected_sources) || !q.expected_sources.every((s) => typeof s === "string" && s)) {
      errors.push(`${at}: expected_sources must be an array of strings`);
    } else if (q.type === "corpus" && !q.expected_sources.length) {
      errors.push(`${at}: a corpus question needs at least one expected source`);
    } else if (q.type === "unanswerable" && q.expected_sources.length) {
      errors.push(`${at}: an unanswerable question has no expected sources`);
    }
    if (q?.expected_sources?.length && (!Array.isArray(q.evidence) || q.evidence.length !== facts?.length)) {
      errors.push(`${at}: evidence must hold one quote from the sources per expected fact`);
    }
  }
  for (const [type, want] of Object.entries(QUESTION_TYPES)) {
    const got = questions.filter((q) => q?.type === type).length;
    if (got !== want) errors.push(`expected ${want} ${type} question(s), got ${got}`);
  }
  return errors;
}

const normalise = (text) => String(text).replace(/\s+/g, " ").toLowerCase().trim();

/**
 * Every expected source exists in the index, and each fact's evidence quote
 * appears verbatim (whitespace and case aside) in one of its sources.
 *
 * @param {object[]} questions
 * @param {Map<string, string>} documents - source → full text, from the index
 * @returns {string[]} errors
 */
export function verifyAgainstIndex(questions, documents) {
  const errors = [];
  for (const q of questions) {
    const texts = [];
    for (const source of q.expected_sources ?? []) {
      if (!documents.has(source)) errors.push(`${q.id}: expected source not in the index: ${source}`);
      else texts.push(normalise(documents.get(source)));
    }
    if (!texts.length) continue;
    (q.evidence ?? []).forEach((quote, i) => {
      if (!texts.some((text) => text.includes(normalise(quote)))) {
        errors.push(`${q.id}: fact ${i + 1} ("${q.expected_facts[i]}") — evidence "${quote}" is not in its sources`);
      }
    });
  }
  return errors;
}

// ---- per answer ----------------------------------------------------------------

/** Whether any expected source was retrieved, and the 1-based rank of the first one. */
export function retrievalHit(chunks, expectedSources) {
  if (!expectedSources?.length) return { hit: null, rank: null };
  const index = chunks.findIndex((chunk) => expectedSources.includes(chunk.source));
  return { hit: index >= 0, rank: index >= 0 ? index + 1 : null };
}

/** `[n]` numbers cited in an answer, `[1][3]` and `[1, 3]` included, in order of first use. */
export function citedNumbers(answer) {
  const out = [];
  for (const [, group] of String(answer ?? "").matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const n of group.split(",").map((x) => Number(x.trim()))) if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Every `[n]` refers to a retrieved chunk, and at least one cited chunk comes
 * from an expected source (null when the question expects none).
 */
export function citationCheck(answer, chunks, expectedSources) {
  const cited = citedNumbers(answer);
  const byN = new Map(chunks.map((chunk) => [chunk.n, chunk]));
  const invalid = cited.filter((n) => !byN.has(n));
  const citesExpected = expectedSources?.length ? cited.some((n) => expectedSources.includes(byN.get(n)?.source)) : null;
  return { cited, invalid, valid: invalid.length === 0, citesExpected };
}

/** Whether a graded answer counts as a pass for its question type. */
export function passed(type, grade) {
  if (type === "unanswerable") return grade.declined && !grade.hallucination;
  return grade.score >= PASS_SCORE && !grade.hallucination;
}

/**
 * What happened to the RAG answer: `pass`, or why not.
 *
 * - `retrieval miss`: no expected source among the retrieved chunks.
 * - `generation miss`: an expected source was retrieved, but facts are missing or wrong.
 * - `not declined`: an unanswerable question answered anyway.
 * - `not in corpus`: failed, and the question expects no source (nothing to retrieve).
 */
export function ragOutcome(question, grade, retrieval) {
  if (passed(question.type, grade)) return "pass";
  if (question.type === "unanswerable") return "not declined";
  if (!question.expected_sources?.length) return "not in corpus";
  return retrieval.hit ? "generation miss" : "retrieval miss";
}

/** One line comparing the two modes on a question. */
export function verdict(question, plain, rag) {
  if (question.type === "unanswerable") {
    if (rag.declined && !plain.declined) return "RAG better: declined, plain answered anyway";
    if (rag.declined && plain.declined) return "same: both declined";
    if (!rag.declined && plain.declined) return "RAG worse: answered, plain declined";
    return "same: both answered";
  }
  const delta = rag.score - plain.score;
  const tag = delta >= 0.25 ? "RAG better" : delta <= -0.25 ? "RAG worse" : "same";
  const hall = rag.hallucination !== plain.hallucination ? ` · hallucination: ${plain.hallucination ? "plain" : "rag"}` : "";
  return `${tag} (${delta >= 0 ? "+" : ""}${delta.toFixed(2)})${hall}`;
}

// ---- summary -------------------------------------------------------------------

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** @param {object[]} rows - one per question, as `scripts/eval-rag.js` builds them */
export function summarize(rows) {
  const side = (mode) => {
    const runs = rows.map((row) => row[mode]);
    const unanswerable = rows.filter((row) => row.type === "unanswerable");
    return {
      meanScore: mean(rows.filter((row) => row.type !== "unanswerable").map((row) => row[mode].grade.score)),
      meanScoreAll: mean(runs.map((run) => run.grade.score)),
      hallucinations: runs.filter((run) => run.grade.hallucination).length,
      unanswerableDeclined: unanswerable.filter((row) => row[mode].grade.declined).length,
      unanswerable: unanswerable.length,
      passed: rows.filter((row) => passed(row.type, row[mode].grade)).length,
      meanLatencyMs: mean(runs.map((run) => run.timings.retrieveMs + run.timings.llmMs)),
      meanInputTokens: mean(runs.map((run) => run.usage?.inputTokens ?? 0)),
      meanOutputTokens: mean(runs.map((run) => run.usage?.outputTokens ?? 0)),
    };
  };
  const withSources = rows.filter((row) => row.expected_sources.length);
  return {
    count: rows.length,
    plain: side("plain"),
    rag: {
      ...side("rag"),
      hits: withSources.filter((row) => row.rag.retrieval.hit).length,
      withSources: withSources.length,
      meanRank: mean(withSources.filter((row) => row.rag.retrieval.hit).map((row) => row.rag.retrieval.rank)),
      citationsValid: rows.filter((row) => row.rag.citations.valid).length,
      citesExpected: withSources.filter((row) => row.rag.citations.citesExpected).length,
      meanRetrieveMs: mean(rows.map((row) => row.rag.timings.retrieveMs)),
      outcomes: Object.fromEntries(
        ["pass", "retrieval miss", "generation miss", "not declined", "not in corpus"].map((o) => [o, rows.filter((row) => row.rag.outcome === o).length]),
      ),
    },
  };
}

// ---- report --------------------------------------------------------------------

const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const num = (x, digits = 2) => (x == null ? "—" : x.toFixed(digits));
const ms = (x) => (x == null ? "—" : `${(x / 1000).toFixed(1)} s`);
const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const shortSource = (source) => String(source).replace(/^knowledge_database\//, "").replace(/\.html?$/, "");
const quote = (text) => String(text ?? "").split("\n").map((line) => `> ${line}`).join("\n");

/** `questions.md`: the question file as a table. */
export function renderQuestionsMd(questions) {
  const expect = (q) =>
    q.type === "unanswerable"
      ? "Says the documents don't cover it; no invented features."
      : q.expected_facts.join("; ");
  return [
    "# RAG eval questions",
    "",
    "Generated from [`questions.json`](questions.json) by `npm run eval:rag -- --check`. Every",
    "expected source exists in the doc_index index, and every expected fact has an `evidence` quote",
    "found verbatim in that source.",
    "",
    "| id | type | question | expected outcome | sources |",
    "| --- | --- | --- | --- | --- |",
    ...questions.map(
      (q) => `| ${q.id} | ${q.type} | ${cell(q.question)} | ${cell(expect(q))} | ${cell(q.expected_sources.map(shortSource).join("; ") || "—")} |`,
    ),
    "",
    "## Notes",
    "",
    ...questions.map((q) => `- **${q.id}**: ${q.notes}`),
    "",
  ].join("\n");
}

/**
 * `rag_comparison.md`.
 * @param {{ generatedAt: string, settings: object, summary: object, rows: object[], notes?: string | null, examplePrompt?: string }} o
 */
export function renderReport({ generatedAt, settings, summary, rows, notes, examplePrompt }) {
  const { plain, rag } = summary;
  const out = [];
  out.push(
    "# RAG vs plain: 10 questions, both modes",
    "",
    `Generated ${generatedAt} by \`npm run eval:rag\`. Answer model \`${settings.model}\` (both modes, temperature 0, max ${settings.maxTokens} tokens);`,
    `judge \`${settings.judgeModel}\` (forced \`submit_grade\`, temperature 0, blind to the mode, \`[n]\` markers stripped).`,
    `Retrieval: doc_index \`search()\`, strategy \`${settings.strategy}\`, k = ${settings.k}, collections ${settings.collections.length ? settings.collections.join(", ") : "all"}, minScore ${settings.minScore ?? "off"}.`,
    "Raw results: [`rag_results.json`](rag_results.json). Questions: [`../eval/rag/questions.md`](../eval/rag/questions.md).",
    "",
    "## Summary",
    "",
    "| | plain | rag |",
    "| --- | ---: | ---: |",
    `| mean fact score (9 answerable) | ${num(plain.meanScore)} | ${num(rag.meanScore)} |`,
    `| passed (score ≥ 0.75, no hallucination; unanswerable: declined) | ${plain.passed}/${summary.count} | ${rag.passed}/${summary.count} |`,
    `| answers with a hallucination | ${plain.hallucinations} | ${rag.hallucinations} |`,
    `| unanswerable declined | ${plain.unanswerableDeclined}/${plain.unanswerable} | ${rag.unanswerableDeclined}/${rag.unanswerable} |`,
    `| mean latency | ${ms(plain.meanLatencyMs)} | ${ms(rag.meanLatencyMs)} (retrieval ${ms(rag.meanRetrieveMs)}) |`,
    `| mean input tokens | ${num(plain.meanInputTokens, 0)} | ${num(rag.meanInputTokens, 0)} |`,
    `| mean output tokens | ${num(plain.meanOutputTokens, 0)} | ${num(rag.meanOutputTokens, 0)} |`,
    `| hit@${settings.k} (questions with expected sources) | | ${rag.hits}/${rag.withSources} (mean rank ${num(rag.meanRank, 1)}) |`,
    `| citations all valid | | ${rag.citationsValid}/${summary.count} |`,
    `| cites an expected source | | ${rag.citesExpected}/${rag.withSources} |`,
    `| RAG failures: retrieval miss / generation miss | | ${rag.outcomes["retrieval miss"]} / ${rag.outcomes["generation miss"]} |`,
    `| RAG failures: unanswerable not declined / general not in corpus | | ${rag.outcomes["not declined"]} / ${rag.outcomes["not in corpus"]} |`,
    "",
    "## Per question",
    "",
    "| id | type | question | plain | rag | rank | rag outcome | verdict |",
    "| --- | --- | --- | ---: | ---: | ---: | --- | --- |",
    ...rows.map(
      (row) =>
        `| [${row.id}](#${row.id}) | ${row.type} | ${cell(row.question)} | ${num(row.plain.grade.score)}${row.plain.grade.hallucination ? " ⚠" : ""} | ` +
        `${num(row.rag.grade.score)}${row.rag.grade.hallucination ? " ⚠" : ""} | ${row.rag.retrieval.rank ?? (row.expected_sources.length ? "miss" : "—")} | ${row.rag.outcome} | ${cell(row.verdict)} |`,
    ),
    "",
    "⚠ = the judge flagged a hallucination.",
    "",
  );
  if (notes?.trim()) out.push("## Findings", "", notes.trim(), "");
  for (const row of rows) {
    out.push(`## ${row.id}`, "", `**${row.type}** — ${row.question}`, "", `*Why:* ${row.notes}`, "");
    out.push(`Expected sources: ${row.expected_sources.map((s) => `\`${shortSource(s)}\``).join(", ") || "none"}`, "");
    for (const mode of ["plain", "rag"]) {
      const run = row[mode];
      const g = run.grade;
      out.push(
        `### ${mode === "rag" ? "With RAG" : "Without RAG"} — score ${num(g.score)}${g.hallucination ? ", hallucination" : ""}${g.declined ? ", declined" : ""}`,
        "",
        `${run.usage?.inputTokens ?? "?"} in · ${run.usage?.outputTokens ?? "?"} out · ${ms(run.timings.retrieveMs + run.timings.llmMs)}` +
          (mode === "rag" ? ` · rank ${run.retrieval.rank ?? "—"} · cited ${run.citations.cited.map((n) => `[${n}]`).join("") || "nothing"}${run.citations.valid ? "" : ` · invalid ${run.citations.invalid.join(", ")}`} · ${run.outcome}` : ""),
        "",
        quote(run.answer),
        "",
        "| expected fact | grade | note |",
        "| --- | --- | --- |",
        ...g.facts.map((f) => `| ${cell(f.fact)} | ${f.grade} | ${cell(f.note)} |`),
        "",
      );
      if (g.hallucination && g.hallucinationNote) out.push(`Hallucination: ${g.hallucinationNote}`, "");
      if (mode === "rag") {
        out.push(
          "Retrieved chunks:",
          "",
          "| n | score | source | section | text |",
          "| ---: | ---: | --- | --- | --- |",
          ...run.chunks.map(
            (c) =>
              `| ${c.n}${row.expected_sources.includes(c.source) ? " ✓" : ""} | ${num(c.score, 3)} | ${cell(shortSource(c.source))} | ${cell(c.section)} | ${cell(c.text.slice(0, 200))}${c.text.length > 200 ? "…" : ""} |`,
          ),
          "",
        );
      }
    }
  }
  if (examplePrompt) {
    out.push("## Appendix: the RAG user message for q01", "", "Built by `buildRagPrompt(question, chunks)` in `src/rag/prompt.js`.", "", "````text", examplePrompt, "````", "");
  }
  return out.join("\n");
}
