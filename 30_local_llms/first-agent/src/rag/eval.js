/**
 * **The pure half of `eval:rag`**: the question file's rules, retrieval and
 * citation checks, the outcomes, the summary, and the Markdown report. No model,
 * no index, no files — `scripts/eval-rag.js` does the I/O.
 *
 * A row is one question; `row.runs[label]` is its run in one mode, where the
 * label is `plain`, `rag`, `rag+rerank`, `rag+rewrite+rerank`, … (see
 * `modeLabel` in `answer.js`).
 */

/** Day 22's 10 (the regression set), Day 23's 6 and Day 24's one ambiguous question. */
export const QUESTION_TYPES = { corpus: 7, general: 2, unanswerable: 1, near_miss: 2, off_topic: 1, paraphrased: 1, messy: 1, multi_part: 1, ambiguous: 1 };
export const QUESTION_COUNT = Object.values(QUESTION_TYPES).reduce((a, b) => a + b, 0);
/** The types whose right answer is "the documents don't cover it": they carry `expect_decline: true`. */
export const DECLINE_TYPES = ["unanswerable", "off_topic", "ambiguous"];
/**
 * Named subsets a question can be tagged with (`"sets": ["citations"]`), and
 * how many of which kind each must hold. `citations` is Day 24's 10: 7 to be
 * answered (corpus, near_miss, multi_part, paraphrased and messy among them)
 * and 3 to be declined.
 */
export const QUESTION_SETS = { citations: { size: 10, answerable: 7, decline: 3, mustInclude: ["corpus", "near_miss", "multi_part", "paraphrased", "messy", "unanswerable", "off_topic", "ambiguous"] } };
/** The types that must name at least one expected source (multi_part: two). */
const SOURCED_TYPES = ["corpus", "near_miss", "paraphrased", "messy", "multi_part"];
export const DEFAULT_MODES = ["plain", "rag", "rag+rerank", "rag+rewrite+rerank"];
const PASS_SCORE = 0.75;

// ---- the question file -------------------------------------------------------

/** Shape and counts. @returns {string[]} errors, empty when valid */
export function validateQuestions(questions) {
  const errors = [];
  if (!Array.isArray(questions)) return ["questions.json must be an array"];
  if (questions.length !== QUESTION_COUNT) errors.push(`expected exactly ${QUESTION_COUNT} questions, got ${questions.length}`);
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
    const sources = q?.expected_sources;
    if (!Array.isArray(sources) || !sources.every((s) => typeof s === "string" && s)) {
      errors.push(`${at}: expected_sources must be an array of strings`);
    } else if (SOURCED_TYPES.includes(q.type) && !sources.length) {
      errors.push(`${at}: a ${q.type} question needs at least one expected source`);
    } else if (q.type === "multi_part" && new Set(sources).size < 2) {
      errors.push(`${at}: a multi_part question needs expected sources from two different documents`);
    } else if (DECLINE_TYPES.includes(q.type) && sources.length) {
      errors.push(`${at}: an ${q.type} question has no expected sources`);
    }
    if (q?.expected_sources?.length && (!Array.isArray(q.evidence) || q.evidence.length !== facts?.length)) {
      errors.push(`${at}: evidence must hold one quote from the sources per expected fact`);
    }
    if (DECLINE_TYPES.includes(q?.type) && q.expect_decline !== true) errors.push(`${at}: an ${q.type} question needs expect_decline: true`);
    if (!DECLINE_TYPES.includes(q?.type) && q?.expect_decline !== undefined) errors.push(`${at}: only ${DECLINE_TYPES.join(" / ")} questions carry expect_decline`);
    if (q?.sets !== undefined && (!Array.isArray(q.sets) || !q.sets.every((name) => name in QUESTION_SETS))) {
      errors.push(`${at}: sets must be an array of ${Object.keys(QUESTION_SETS).join(", ")}`);
    }
  }
  for (const [name, rule] of Object.entries(QUESTION_SETS)) {
    const members = questions.filter((q) => Array.isArray(q?.sets) && q.sets.includes(name));
    if (members.length !== rule.size) errors.push(`set "${name}": expected ${rule.size} questions, got ${members.length}`);
    const decline = members.filter((q) => q.expect_decline).length;
    if (decline !== rule.decline || members.length - decline !== rule.answerable) {
      errors.push(`set "${name}": expected ${rule.answerable} to answer and ${rule.decline} to decline, got ${members.length - decline} and ${decline}`);
    }
    for (const type of rule.mustInclude) if (!members.some((q) => q.type === type)) errors.push(`set "${name}": needs a ${type} question`);
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

/**
 * Retrieval for one RAG run: hit and rank in the final chunks (after the
 * rerank), the rank of the first expected source in vector order (before it),
 * how many of the expected documents made it into the final chunks, and the
 * noise — final chunks from no expected source.
 */
export function retrievalStats(run, expectedSources) {
  const { hit, rank } = retrievalHit(run.chunks, expectedSources);
  if (!expectedSources?.length) return { hit, rank, rankBefore: null, sourcesFound: null, sourcesExpected: 0, noise: null };
  const before = (run.candidates ?? []).filter((c) => expectedSources.includes(c.source)).map((c) => c.vectorRank);
  const found = new Set(run.chunks.filter((c) => expectedSources.includes(c.source)).map((c) => c.source));
  return {
    hit,
    rank,
    rankBefore: before.length ? Math.min(...before) : null,
    sourcesFound: found.size,
    sourcesExpected: new Set(expectedSources).size,
    noise: run.chunks.filter((c) => !expectedSources.includes(c.source)).length,
  };
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
 * from an expected source (null when the question expects none). With the
 * Day 24 contract's `citations`, `[cN]` markers are resolved through them to
 * the chunk numbers they quote.
 */
export function citationCheck(answer, chunks, expectedSources, citations) {
  let cited = citedNumbers(answer);
  if (Array.isArray(citations)) {
    const nOf = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk.n]));
    const byId = new Map(citations.map((c) => [c.id, c]));
    cited = [];
    for (const [, id] of String(answer ?? "").matchAll(/\[(c\d+)\]/gi)) {
      const n = nOf.get(byId.get(id.toLowerCase())?.chunk_id) ?? -1;
      if (!cited.includes(n)) cited.push(n);
    }
  }
  const byN = new Map(chunks.map((chunk) => [chunk.n, chunk]));
  const invalid = cited.filter((n) => !byN.has(n));
  const citesExpected = expectedSources?.length ? cited.some((n) => expectedSources.includes(byN.get(n)?.source)) : null;
  return { cited, invalid, valid: invalid.length === 0, citesExpected };
}

/** The pipeline declined (nothing passed the cutoff), the contract said dont_know, or the judge read the answer as a decline. */
export const isDeclined = (run) => Boolean(run.declined || run.status === "dont_know" || run.grade?.declined);

/** Whether a run counts as a pass for its question. */
export function passed(question, run) {
  if (question.expect_decline) return isDeclined(run) && !run.grade.hallucination;
  return run.grade.score >= PASS_SCORE && !run.grade.hallucination;
}

/**
 * What happened to a run: `pass`, or why not.
 *
 * - `wrong decline (cutoff)`: an answerable question, and the rerank cutoff dropped everything.
 * - `wrong decline (model)`: an answerable question, and the model said the documents don't cover it.
 * - `retrieval miss`: no expected source among the final chunks.
 * - `generation miss`: an expected source was there, but facts are missing or wrong.
 * - `not declined`: a question that should be declined was answered.
 * - `not in corpus`: failed, and the question expects no source (nothing to retrieve).
 * - `fail`: plain mode, any other failure.
 */
export function outcome(question, run) {
  if (passed(question, run)) return "pass";
  if (question.expect_decline) return "not declined";
  if (run.declined) return "wrong decline (cutoff)";
  if (run.mode !== "rag") return "fail";
  if (isDeclined(run)) return "wrong decline (model)";
  if (!question.expected_sources?.length) return "not in corpus";
  return run.retrieval?.hit ? "generation miss" : "retrieval miss";
}

// ---- summary -------------------------------------------------------------------

const mean = (xs) => {
  const vals = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};

/**
 * @param {object[]} rows - one per question, as `scripts/eval-rag.js` builds them
 * @param {string[]} modes - the labels that were run
 */
export function summarize(rows, modes) {
  const answerable = rows.filter((row) => !row.expect_decline);
  const toDecline = rows.filter((row) => row.expect_decline);
  const withSources = rows.filter((row) => row.expected_sources.length);
  const byMode = {};
  for (const mode of modes) {
    const runs = rows.map((row) => row.runs[mode]).filter(Boolean);
    const isRag = runs.some((run) => run.mode === "rag");
    const t = (key) => mean(runs.map((run) => run.timings?.[key] ?? 0));
    const tokens = (stage) => mean(runs.map((run) => run.usageByStage?.[stage]?.inputTokens ?? 0));
    byMode[mode] = {
      isRag,
      meanScore: mean(answerable.map((row) => row.runs[mode]?.grade.score)),
      passed: rows.filter((row) => row.runs[mode] && passed(row, row.runs[mode])).length,
      hallucinations: runs.filter((run) => run.grade.hallucination).length,
      correctDeclines: toDecline.filter((row) => row.runs[mode] && isDeclined(row.runs[mode])).length,
      toDecline: toDecline.length,
      wrongDeclines: answerable
        .filter((row) => row.runs[mode] && isDeclined(row.runs[mode]))
        .map((row) => ({ id: row.id, type: row.type, by: row.runs[mode].declined ? "cutoff" : "model" })),
      cutoffDeclines: runs.filter((run) => run.declined).length,
      meanInputTokens: mean(runs.map((run) => run.usage?.inputTokens ?? 0)),
      meanOutputTokens: mean(runs.map((run) => run.usage?.outputTokens ?? 0)),
      inputTokens: { rewrite: tokens("rewrite"), answer: tokens("llm") },
      latencyMs: { rewrite: t("rewriteMs"), retrieve: t("retrieveMs"), rerank: t("rerankMs"), llm: t("llmMs") },
      meanLatencyMs: mean(runs.map((run) => Object.values(run.timings ?? {}).reduce((a, b) => a + (b ?? 0), 0))),
      ...(isRag
        ? {
            hits: withSources.filter((row) => row.runs[mode]?.retrieval.hit).length,
            withSources: withSources.length,
            meanRank: mean(withSources.map((row) => row.runs[mode]?.retrieval.rank)),
            meanRankBefore: mean(withSources.map((row) => row.runs[mode]?.retrieval.rankBefore)),
            meanNoise: mean(withSources.map((row) => row.runs[mode]?.retrieval.noise)),
            meanChunks: mean(runs.map((run) => run.chunks.length)),
            citationsValid: runs.filter((run) => citationsOf(run).valid).length,
            citesExpected: withSources.filter((row) => row.runs[mode] && citationsOf(row.runs[mode]).citesExpected).length,
          }
        : {}),
      outcomes: countBy(runs.map((run) => run.outcome)),
    };
  }
  return { count: rows.length, answerable: answerable.length, modes, byMode };
}

/** The `[n]` / `[cN]` check of a run: `citationCheck` since Day 24, `citations` before (old results files). */
export const citationsOf = (run) => run.citationCheck ?? run.citations;

const countBy = (xs) => xs.reduce((acc, x) => ((acc[x] = (acc[x] ?? 0) + 1), acc), {});

// ---- report --------------------------------------------------------------------

const num = (x, digits = 2) => (x == null ? "—" : x.toFixed(digits));
const ms = (x) => (x == null ? "—" : `${(x / 1000).toFixed(1)} s`);
const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const shortSource = (source) => String(source).replace(/^knowledge_database\//, "").replace(/\.html?$/, "");
const quote = (text) => String(text ?? "").split("\n").map((line) => `> ${line}`).join("\n");

/** "3 → 1", "12 → —" (dropped), "—" (no expected source). */
export function rankMove(retrieval) {
  if (!retrieval || retrieval.sourcesExpected === 0) return "—";
  const before = retrieval.rankBefore ?? "miss";
  const after = retrieval.rank ?? "miss";
  return before === after ? String(after) : `${before} → ${after}`;
}

/** `questions.md`: the question file as a table. */
export function renderQuestionsMd(questions) {
  const expect = (q) => (q.expect_decline ? (q.type === "ambiguous" ? "I don't know + a clarifying question; nothing invented." : "Says the documents don't cover it; nothing invented.") : q.expected_facts.join("; "));
  return [
    "# RAG eval questions",
    "",
    "Generated from [`questions.json`](questions.json) by `npm run eval:rag -- --check`. Every",
    "expected source exists in the doc_index index, and every expected fact has an `evidence` quote",
    "found verbatim in that source. q01–q10 are Day 22's regression set, unchanged; q11–q16 were",
    "added on Day 23 for reranking and query rewriting; q17 (ambiguous) on Day 24. The 10 tagged",
    "`citations` are the `npm run eval:citations` set.",
    "",
    "| id | type | question | expected outcome | sources |",
    "| --- | --- | --- | --- | --- |",
    ...questions.map(
      (q) => `| ${q.id}${q.sets?.includes("citations") ? " ᶜ" : ""} | ${q.type}${q.expect_decline ? " (decline)" : ""} | ${cell(q.question)} | ${cell(expect(q))} | ${cell(q.expected_sources.map(shortSource).join("; ") || "—")} |`,
    ),
    "",
    "## Notes",
    "",
    ...questions.map((q) => `- **${q.id}**: ${q.notes}`),
    "",
  ].join("\n");
}

/** The summary table's rows: [label, one value per mode]. Shared by the Markdown report and the page. */
export function summaryRows(summary) {
  const { modes, byMode } = summary;
  const each = (fn) => modes.map((mode) => fn(byMode[mode], mode));
  const rag = (fn) => each((s) => (s.isRag ? fn(s) : ""));
  return [
    [`mean fact score (${summary.answerable} answerable)`, each((s) => num(s.meanScore))],
    [`passed (of ${summary.count})`, each((s) => String(s.passed))],
    ["answers with a hallucination", each((s) => String(s.hallucinations))],
    ["correct declines (expected)", each((s) => `${s.correctDeclines}/${s.toDecline}`)],
    ["wrong declines (answerable question declined)", each((s) => (s.wrongDeclines.length ? `${s.wrongDeclines.length}: ${s.wrongDeclines.map((d) => `${d.id} (${d.by})`).join(", ")}` : "0"))],
    ["expected source in the final chunks", rag((s) => `${s.hits}/${s.withSources}`)],
    ["mean rank of expected source: before rerank → final", rag((s) => (num(s.meanRankBefore, 1) === num(s.meanRank, 1) ? num(s.meanRank, 1) : `${num(s.meanRankBefore, 1)} → ${num(s.meanRank, 1)}`))],
    ["noise: final chunks from no expected source (mean)", rag((s) => `${num(s.meanNoise, 1)} of ${num(s.meanChunks, 1)}`)],
    ["citations all valid", rag((s) => `${s.citationsValid}/${summary.count}`)],
    ["mean input tokens: rewrite + answer", each((s) => (s.inputTokens.rewrite ? `${num(s.inputTokens.rewrite, 0)} + ${num(s.inputTokens.answer, 0)}` : num(s.inputTokens.answer, 0)))],
    ["mean output tokens", each((s) => num(s.meanOutputTokens, 0))],
    ["mean latency (total)", each((s) => ms(s.meanLatencyMs))],
    ["… rewrite / retrieve / rerank / answer", each((s) => [s.latencyMs.rewrite, s.latencyMs.retrieve, s.latencyMs.rerank, s.latencyMs.llm].map((x) => (x ? (x / 1000).toFixed(2) : "0")).join(" / ") + " s")],
  ];
}

/**
 * `rag_comparison.md`.
 * @param {{ generatedAt: string, settings: object, summary: object, rows: object[], notes?: string | null, examplePrompt?: string }} o
 */
export function renderReport({ generatedAt, settings, summary, rows, notes, examplePrompt }) {
  const { modes } = summary;
  const ragModes = modes.filter((mode) => summary.byMode[mode].isRag);
  const out = [];
  out.push(
    `# RAG eval: ${summary.count} questions × ${modes.length} modes`,
    "",
    `Generated ${generatedAt} by \`npm run eval:rag\`. Answer model \`${settings.model}\` (every mode, temperature 0, max ${settings.maxTokens} tokens);`,
    `judge \`${settings.judgeModel}\` (forced \`submit_grade\`, temperature 0, blind to the mode, \`[n]\` markers stripped).`,
    `Retrieval: doc_index \`search()\`, strategy \`${settings.strategy}\`, collections ${settings.collections.length ? settings.collections.join(", ") : "all"}, minScore ${settings.minScore ?? "off"}; ` +
      `k_final = ${settings.kFinal} chunks to the model, k_retrieve = ${settings.kRetrieve} candidates per query when reranking.`,
    `Rerank: \`${settings.rerankModel ?? "bge-reranker-v2-m3"}\`, cutoff ${settings.rerankThreshold} on the sigmoid score. Rewrite: one forced \`submit_queries\` call with the answer model.`,
    "Raw results: [`rag_results.json`](rag_results.json). Questions: [`../eval/rag/questions.md`](../eval/rag/questions.md).",
    "",
    "## Summary",
    "",
    `| | ${modes.join(" | ")} |`,
    `| --- |${modes.map(() => " ---: |").join("")}`,
    ...summaryRows(summary).map(([label, values]) => `| ${label} | ${values.map(cell).join(" | ")} |`),
    "",
    "## Per question",
    "",
    "Score per mode (⚠ hallucination, ✗ declined). Rank: first expected source before the rerank → in the final chunks.",
    "",
    `| id | type | question | ${modes.join(" | ")} | ${ragModes.map((m) => `rank ${m}`).join(" | ")} |`,
    `| --- | --- | --- |${modes.map(() => " ---: |").join("")}${ragModes.map(() => " ---: |").join("")}`,
    ...rows.map((row) => {
      const score = (run) => (run ? `${num(run.grade.score)}${run.grade.hallucination ? " ⚠" : ""}${isDeclined(run) ? " ✗" : ""}` : "");
      return `| [${row.id}](#${row.id}) | ${row.type} | ${cell(row.question)} | ${modes.map((m) => score(row.runs[m])).join(" | ")} | ${ragModes.map((m) => rankMove(row.runs[m]?.retrieval)).join(" | ")} |`;
    }),
    "",
  );
  if (notes?.trim()) out.push("## Findings", "", notes.trim(), "");
  for (const row of rows) {
    out.push(`## ${row.id}`, "", `**${row.type}**${row.expect_decline ? " (should be declined)" : ""} — ${row.question}`, "", `*Why:* ${row.notes}`, "");
    out.push(`Expected sources: ${row.expected_sources.map((s) => `\`${shortSource(s)}\``).join(", ") || "none"}`, "");
    for (const mode of modes) {
      const run = row.runs[mode];
      if (!run) continue;
      const g = run.grade;
      const line = [`${run.usage?.inputTokens ?? "?"} in · ${run.usage?.outputTokens ?? "?"} out · ${ms(Object.values(run.timings).reduce((a, b) => a + (b ?? 0), 0))}`];
      if (run.mode === "rag") {
        line.push(`rank ${rankMove(run.retrieval)}`);
        const cc = citationsOf(run);
        line.push(`cited ${cc.cited.map((n) => `[${n}]`).join("") || "nothing"}${cc.valid ? "" : ` · invalid ${cc.invalid.join(", ")}`}`);
      }
      line.push(run.outcome);
      out.push(
        `### ${mode} — score ${num(g.score)}${g.hallucination ? ", hallucination" : ""}${isDeclined(run) ? `, declined${run.declined ? " by the cutoff" : ""}` : ""}`,
        "",
        line.join(" · "),
        "",
      );
      if (run.rewrite) out.push(`Queries searched: ${run.queries.map((q) => `\`${cell(q)}\``).join(" · ")}`, "");
      out.push(
        quote(run.answer),
        "",
        "| expected fact | grade | note |",
        "| --- | --- | --- |",
        ...g.facts.map((f) => `| ${cell(f.fact)} | ${f.grade} | ${cell(f.note)} |`),
        "",
      );
      if (g.hallucination && g.hallucinationNote) out.push(`Hallucination: ${g.hallucinationNote}`, "");
      if (run.mode === "rag") out.push(...candidateTable(run, row.expected_sources));
    }
  }
  if (examplePrompt) {
    out.push("## Appendix: the RAG user message for q01", "", "Built by `buildRagPrompt(question, chunks)` in `src/rag/prompt.js`.", "", "````text", examplePrompt, "````", "");
  }
  return out.join("\n");
}

/** Kept chunks with their text, then the dropped candidates (scores only). */
function candidateTable(run, expected) {
  const mark = (source) => (expected.includes(source) ? " ✓" : "");
  const lines = [
    "Kept chunks:",
    "",
    "| n | vector | rerank | source | section | text |",
    "| ---: | ---: | ---: | --- | --- | --- |",
    ...run.chunks.map(
      (c) =>
        `| ${c.n}${mark(c.source)} | ${num(c.score, 3)} | ${c.rerankScore == null ? "—" : num(c.rerankScore, 3)} | ${cell(shortSource(c.source))} | ${cell(c.section)} | ${cell(c.text.slice(0, 160))}${c.text.length > 160 ? "…" : ""} |`,
    ),
    "",
  ];
  if (!run.chunks.length) lines.splice(0, lines.length, "Kept chunks: none (declined).", "");
  const dropped = run.candidates.filter((c) => !c.kept);
  if (dropped.length) {
    lines.push(
      `<details><summary>Dropped candidates (${dropped.length})</summary>`,
      "",
      "| vector rank | vector | rerank | source | section |",
      "| ---: | ---: | ---: | --- | --- |",
      ...dropped.map((c) => `| ${c.vectorRank}${mark(c.source)} | ${num(c.vectorScore, 3)} | ${c.rerankScore == null ? "—" : num(c.rerankScore, 3)} | ${cell(shortSource(c.source))} | ${cell(c.section)} |`),
      "",
      "</details>",
      "",
    );
  }
  return lines;
}
