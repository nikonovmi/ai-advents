/**
 * **The pure half of `eval:citations`**: the per-question checks, the summary,
 * and the Markdown report. `scripts/eval-citations.js` does the calls and I/O.
 *
 * A row is one question from the `citations` set with `run` (what
 * `answerQuestion` returned), `faithfulness` (the claim judge, for answered
 * runs) and `grade` (Day 22's fact judge, for answerable questions).
 */

export const CITATION_SET = "citations";
export const DEFAULT_CITATION_MODE = "rag+rerank";
/** "meaning matches citations" passes at this faithfulness, with no claim unsupported. */
export const FAITHFUL_SCORE = 0.75;

export const CHECKS = [
  ["sources", "has sources"],
  ["citations", "has citations"],
  ["quotes", "quotes are real"],
  ["faithful", "meaning matches citations"],
  ["idk", "correct \"I don't know\""],
];

const answered = (run) => run.status === "answered";

/**
 * Each check is true, false, or null when it does not apply.
 *
 * - sources / citations: an answerable question must end `answered` with ≥ 1
 *   derived source / valid citation; for one to be declined, they apply only if it was answered.
 * - quotes: no fabricated quote on the **first** attempt (before the retry fixed anything).
 * - faithful: faithfulness ≥ 0.75 and no `unsupported` claim.
 * - idk: to-decline → `dont_know` with a clarifying question; answerable → not `dont_know`.
 */
export function checksOf(row) {
  const { run } = row;
  const isAnswered = answered(run);
  const applies = !row.expect_decline || isAnswered;
  const v = run.verification;
  return {
    sources: applies ? isAnswered && run.sources.length > 0 : null,
    citations: applies ? isAnswered && run.citations.length > 0 : null,
    quotes: v && v.firstAttemptCitations > 0 ? v.fabricatedFirstAttempt.length === 0 : null,
    faithful: row.faithfulness?.faithfulness == null ? null : row.faithfulness.faithfulness >= FAITHFUL_SCORE && row.faithfulness.unsupported === 0,
    idk: row.expect_decline ? run.status === "dont_know" && Boolean(run.clarifyingQuestion) : run.status !== "dont_know",
  };
}

export function checksPassed(checks) {
  const applied = Object.values(checks).filter((x) => x !== null);
  return { passed: applied.filter(Boolean).length, applied: applied.length };
}

/** "verified", "retried", "1 citation dropped", "downgraded", "low relevance". */
export function verificationLabel(run) {
  const v = run.verification;
  if (!v) return run.dontKnow?.reason === "low_relevance" ? "low relevance (no answer call)" : "—";
  const parts = [];
  if (v.firstAttemptValid) parts.push("verified");
  else if (v.retried) parts.push(v.finalErrors.length ? "retried, still invalid" : "retried → verified");
  if (v.droppedCitations.length) parts.push(`${v.droppedCitations.length} citation${v.droppedCitations.length === 1 ? "" : "s"} dropped`);
  if (v.downgraded) parts.push("downgraded");
  return parts.join(" · ");
}

const mean = (xs) => {
  const vals = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);

export function summarizeCitations(rows) {
  const runs = rows.map((r) => r.run);
  const answerable = rows.filter((r) => !r.expect_decline);
  const toDecline = rows.filter((r) => r.expect_decline);
  const answeredRows = rows.filter((r) => answered(r.run));
  const verified = runs.filter((r) => r.verification);
  const fabricated = rows.flatMap((r) => (r.run.verification?.fabricatedFirstAttempt ?? []).map((f) => ({ question: r.id, ...f })));
  const judged = rows.filter((r) => r.faithfulness?.faithfulness != null);
  return {
    count: rows.length,
    answerable: answerable.length,
    toDecline: toDecline.length,
    answered: answeredRows.length,
    answeredWithSources: answeredRows.filter((r) => r.run.sources.length).length,
    answeredWithCitations: answeredRows.filter((r) => r.run.citations.length).length,
    answerableWithSources: answerable.filter((r) => answered(r.run) && r.run.sources.length).length,
    firstAttemptCitations: sum(verified.map((r) => r.verification.firstAttemptCitations)),
    fabricatedFirstAttempt: fabricated.length,
    fabricated,
    firstAttemptValid: verified.filter((r) => r.verification.firstAttemptValid).length,
    contractCalls: verified.length,
    retries: verified.filter((r) => r.verification.retried).length,
    retriesFixed: verified.filter((r) => r.verification.retried && !r.verification.finalErrors.length).length,
    droppedCitations: sum(verified.map((r) => r.verification.droppedCitations.length)),
    downgrades: verified.filter((r) => r.verification.downgraded).length,
    meanFaithfulness: mean(judged.map((r) => r.faithfulness.faithfulness)),
    claims: sum(judged.map((r) => r.faithfulness.claims.length)),
    claimVerdicts: {
      supported: sum(judged.map((r) => r.faithfulness.supported)),
      partial: sum(judged.map((r) => r.faithfulness.partial)),
      unsupported: sum(judged.map((r) => r.faithfulness.unsupported)),
    },
    uncitedClaims: sum(rows.map((r) => r.faithfulness?.uncitedClaims.length ?? 0)),
    correctIdk: toDecline.filter((r) => r.checks.idk).length,
    missedIdk: toDecline.filter((r) => !r.checks.idk).map((r) => ({ id: r.id, type: r.type, status: r.run.status })),
    falseIdk: answerable.filter((r) => r.run.status === "dont_know").map((r) => ({ id: r.id, type: r.type, reason: r.run.dontKnow?.reason })),
    dontKnowReasons: runs.filter((r) => r.dontKnow).reduce((acc, r) => ((acc[r.dontKnow.reason] = (acc[r.dontKnow.reason] ?? 0) + 1), acc), {}),
    meanFactScore: mean(answerable.map((r) => r.grade?.score)),
    checks: Object.fromEntries(
      CHECKS.map(([key]) => {
        const applied = rows.map((r) => r.checks[key]).filter((x) => x !== null);
        return [key, { passed: applied.filter(Boolean).length, applied: applied.length }];
      }),
    ),
    meanLatencyMs: mean(runs.map((r) => sum(Object.values(r.timings ?? {})))),
    meanInputTokens: mean(runs.map((r) => r.usage?.inputTokens ?? 0)),
    meanOutputTokens: mean(runs.map((r) => r.usage?.outputTokens ?? 0)),
  };
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}% (${a}/${b})` : "—");
const num = (x, d = 2) => (x == null ? "—" : x.toFixed(d));
const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const shortSource = (source) => String(source ?? "").replace(/^knowledge_database\//, "").replace(/\.html?$/, "");
const blockquote = (text) => String(text ?? "").split("\n").map((line) => `> ${line}`).join("\n");

/** The summary table's rows: [label, value]. Shared by the Markdown report and the page. */
export function citationSummaryRows(s) {
  const idList = (xs, fmt) => (xs.length ? `${xs.length}: ${xs.map(fmt).join(", ")}` : "0");
  return [
    ["answered with ≥ 1 source", pct(s.answeredWithSources, s.answered)],
    ["answered with ≥ 1 valid citation", pct(s.answeredWithCitations, s.answered)],
    ["answerable questions answered with sources", pct(s.answerableWithSources, s.answerable)],
    ["fabricated quotes on the first attempt", `${s.fabricatedFirstAttempt} of ${s.firstAttemptCitations} quotes`],
    ["first attempt valid", `${s.firstAttemptValid}/${s.contractCalls} answer calls`],
    ["retries (fixed by the retry)", `${s.retries} (${s.retriesFixed})`],
    ["citations dropped after the retry", String(s.droppedCitations)],
    ["downgraded to \"I don't know\"", String(s.downgrades)],
    ["mean faithfulness (supported / cited claims)", `${num(s.meanFaithfulness)} · ${s.claimVerdicts.supported} supported, ${s.claimVerdicts.partial} partial, ${s.claimVerdicts.unsupported} unsupported of ${s.claims}`],
    ["uncited factual claims", String(s.uncitedClaims)],
    ["correct \"I don't know\"", `${s.correctIdk}/${s.toDecline}`],
    ["false \"I don't know\" (answerable)", idList(s.falseIdk, (x) => `${x.id} (${x.reason})`)],
    ["missed \"I don't know\" (answered instead)", idList(s.missedIdk, (x) => x.id)],
    [`mean fact score (${s.answerable} answerable, Day 22 judge)`, num(s.meanFactScore)],
    ["checks passed", CHECKS.map(([key, label]) => `${label} ${s.checks[key].passed}/${s.checks[key].applied}`).join(" · ")],
    ["mean latency · input / output tokens", `${s.meanLatencyMs == null ? "—" : (s.meanLatencyMs / 1000).toFixed(1) + " s"} · ${num(s.meanInputTokens, 0)} / ${num(s.meanOutputTokens, 0)}`],
  ];
}

const mark = (x) => (x === null ? "—" : x ? "✓" : "✗");

/** `citations_report.md`. */
export function renderCitationsReport({ generatedAt, settings, summary, rows, notes }) {
  const out = [
    `# Citations eval: ${summary.count} questions, \`${settings.mode}\``,
    "",
    `Generated ${generatedAt} by \`npm run eval:citations\`. Answer model \`${settings.model}\` through the forced \`submit_answer\` contract (temperature 0),`,
    `verified in code, one retry with the errors. Judges \`${settings.judgeModel}\`: the faithfulness judge (claims + the quotes they cite, nothing else) and Day 22's fact judge.`,
    `Rerank cutoff ${settings.rerankThreshold}; k_final ${settings.kFinal}, k_retrieve ${settings.kRetrieve}. Raw results: [\`citations_results.json\`](citations_results.json).`,
    "",
    "## Summary",
    "",
    "| | |",
    "| --- | --- |",
    ...citationSummaryRows(summary).map(([label, value]) => `| ${cell(label)} | ${cell(value)} |`),
    "",
    "## Per question",
    "",
    `| id | type | status | ${CHECKS.map(([, label]) => label).join(" | ")} | faithfulness | fact score | verification |`,
    `| --- | --- | --- |${CHECKS.map(() => " :---: |").join("")} ---: | ---: | --- |`,
    ...rows.map((r) => {
      const status = r.run.status === "dont_know" ? `dont_know (${r.run.dontKnow?.reason})` : r.run.status;
      return `| [${r.id}](#${r.id}) | ${r.type} | ${status} | ${CHECKS.map(([key]) => mark(r.checks[key])).join(" | ")} | ${num(r.faithfulness?.faithfulness)} | ${num(r.grade?.score)} | ${cell(verificationLabel(r.run))} |`;
    }),
    "",
  ];
  if (notes?.trim()) out.push("## Findings", "", notes.trim(), "");
  for (const r of rows) {
    const { run } = r;
    out.push(`## ${r.id}`, "", `**${r.type}**${r.expect_decline ? " (should be \"I don't know\")" : ""} — ${r.question}`, "");
    out.push(`Status: **${run.status}**${run.dontKnow ? ` (${run.dontKnow.reason})` : ""} · verification: ${verificationLabel(run)} · checks ${checksPassed(r.checks).passed}/${checksPassed(r.checks).applied}`, "");
    out.push(blockquote(run.answer), "");
    if (run.sources.length) out.push("Sources:", "", ...run.sources.map((s, i) => `${i + 1}. ${cell(shortSource(s.source))}${s.section ? ` › ${cell(s.section)}` : ""} · \`${s.chunk_id}\``), "");
    if (run.citations.length) out.push("Citations:", "", ...run.citations.map((c) => `- **[${c.id}]** "${cell(c.quote)}" — ${cell(shortSource(c.source))}${c.section ? ` › ${cell(c.section)}` : ""}`), "");
    const v = run.verification;
    if (v?.firstAttemptErrors.length) out.push("First-attempt errors:", "", ...v.firstAttemptErrors.map((e) => `- ${cell(e)}`), "");
    if (v?.droppedCitations.length) out.push("Dropped citations:", "", ...v.droppedCitations.map((c) => `- [${c.id}] ${c.reason}: "${cell(c.quote)}"`), "");
    if (v?.droppedClaims.length) out.push("Dropped claims:", "", ...v.droppedClaims.map((c) => `- ${cell(c)}`), "");
    if (run.dontKnow?.reason === "low_relevance" && run.rejected?.length) {
      out.push("Best rejected chunks:", "", ...run.rejected.map((c, i) => `${i + 1}. ${num(c.rerankScore, 3)} · ${cell(shortSource(c.source))}${c.section ? ` › ${cell(c.section)}` : ""}`), "");
    }
    const f = r.faithfulness;
    if (f) {
      out.push(`Faithfulness ${num(f.faithfulness)}:`, "", "| claim | verdict | quotes cited | note |", "| --- | --- | --- | --- |");
      out.push(...f.claims.map((c) => `| ${cell(c.claim)} | ${c.verdict} | ${c.quotes.map((q) => `[${q.id}] "${cell(q.quote ?? "?")}"`).join("<br>")} | ${cell(c.note)} |`), "");
      if (f.uncitedClaims.length) out.push("Uncited claims:", "", ...f.uncitedClaims.map((c) => `- ${cell(c)}`), "");
    }
    if (r.grade) out.push(`Fact score ${num(r.grade.score)}: ${r.grade.facts.map((x) => `${x.grade} — ${cell(x.fact)}`).join("; ")}`, "");
  }
  return out.join("\n");
}
