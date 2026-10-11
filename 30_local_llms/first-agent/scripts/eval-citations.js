#!/usr/bin/env node
/**
 * **Citations, sources and "I don't know", on the 10 questions tagged `citations`.**
 * Real model, real index, real reranker.
 *
 * Each question is answered once in one mode (default `rag+rerank`) with
 * `answerQuestion`, the function the Knowledge chat uses. Then:
 *
 * - the contract's own verification (sources, citations, fabricated quotes on
 *   the first attempt, retries, drops, downgrades) is read off the result;
 * - an answered run goes to the faithfulness judge (claims + the quotes they
 *   cite, nothing else);
 * - an answerable question also goes to Day 22's fact judge, to show
 *   correctness did not drop;
 * - expected-decline questions must end `dont_know` with a clarifying
 *   question, and answerable ones must not.
 *
 * Writes `reports/citations_results.json` and `reports/citations_report.md`
 * (with `reports/citations_notes.md` as the findings, if it exists).
 *
 *   npm run eval:citations                    # the 10, rag+rerank
 *   npm run eval:citations -- --mode rag      # another mode
 *   npm run eval:citations -- q17             # some questions
 *   npm run eval:citations -- --report        # re-render the report from the JSON + notes (no API calls)
 *
 * Needs ANTHROPIC_API_KEY and a built index. Not part of `npm test`.
 */

import fs from "node:fs";
import path from "node:path";

import "dotenv/config";

import { AnthropicProvider } from "../src/llm/anthropic.js";
import { answerQuestion, parseModeLabel } from "../src/rag/answer.js";
import { CITATION_SET, DEFAULT_CITATION_MODE, checksOf, checksPassed, renderCitationsReport, summarizeCitations, verificationLabel } from "../src/rag/citationsEval.js";
import { PROJECT_DIR, RAG_QUESTIONS_PATH, REPORTS_DIR, ragSettings } from "../src/rag/config.js";
import { validateQuestions } from "../src/rag/eval.js";
import { judgeFaithfulness } from "../src/rag/faithfulness.js";
import { judgeAnswer } from "../src/rag/judge.js";

const args = process.argv.slice(2);
const resultsPath = path.join(REPORTS_DIR, "citations_results.json");
const reportPath = path.join(REPORTS_DIR, "citations_report.md");
const notesPath = path.join(REPORTS_DIR, "citations_notes.md");
const readNotes = () => (fs.existsSync(notesPath) ? fs.readFileSync(notesPath, "utf8") : null);

function fail(lines) {
  console.error(["✗ " + lines[0], ...lines.slice(1).map((l) => "  " + l)].join("\n"));
  process.exit(1);
}

if (args.includes("--report")) {
  const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  fs.writeFileSync(reportPath, renderCitationsReport({ ...results, notes: readNotes() }));
  console.log("→ reports/citations_report.md re-rendered from citations_results.json");
  process.exit(0);
}

const modeAt = args.indexOf("--mode");
const mode = modeAt >= 0 ? args[modeAt + 1] : (args.find((a) => a.startsWith("--mode="))?.slice("--mode=".length) ?? DEFAULT_CITATION_MODE);
const options = parseModeLabel(mode);
if (!options || options.mode !== "rag") fail([`--mode must be a RAG mode (rag, rag+rerank, rag+rewrite, rag+rewrite+rerank), got "${mode}"`]);
const only = args.filter((a, i) => !a.startsWith("--") && !(modeAt >= 0 && i === modeAt + 1));

const questions = JSON.parse(fs.readFileSync(RAG_QUESTIONS_PATH, "utf8"));
const shapeErrors = validateQuestions(questions);
if (shapeErrors.length) fail(["questions.json is invalid:", ...shapeErrors]);
let selected = questions.filter((q) => q.sets?.includes(CITATION_SET));
if (only.length) selected = selected.filter((q) => only.includes(q.id));
if (!selected.length) fail([`no question in the "${CITATION_SET}" set with id ${only.join(", ")}`]);

if (!process.env.ANTHROPIC_API_KEY) fail(["ANTHROPIC_API_KEY is not set (first-agent/.env)"]);
const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
const settings = ragSettings();
const judgeModel = process.env.RAG_JUDGE_MODEL || provider.model;
if (!options.rerank) console.log("note: rerank is off, so only the model's own dont_know can produce \"I don't know\" (no low-relevance cutoff)");

const rows = [];
for (const q of selected) {
  const run = await answerQuestion(q.question, { ...settings, ...options, provider, log: () => {} });
  const row = { ...q, run, faithfulness: null, grade: null };
  if (run.status === "answered") row.faithfulness = await judgeFaithfulness({ provider, model: judgeModel, answer: run.answer, citations: run.citations });
  if (!q.expect_decline) row.grade = await judgeAnswer({ provider, model: judgeModel, question: q.question, type: q.type, expectedFacts: q.expected_facts, answer: run.answer });
  row.checks = checksOf(row);
  rows.push(row);
  const { passed, applied } = checksPassed(row.checks);
  console.log(
    `${q.id} ${q.type.padEnd(12)} ${run.status.padEnd(9)}${run.dontKnow ? ` (${run.dontKnow.reason})` : ""} · checks ${passed}/${applied}` +
      ` · ${run.citations.length} citation(s) · ${verificationLabel(run)}` +
      (row.faithfulness ? ` · faithfulness ${row.faithfulness.faithfulness?.toFixed(2) ?? "—"}` : "") +
      (row.grade ? ` · facts ${row.grade.score.toFixed(2)}` : ""),
  );
}

const summary = summarizeCitations(rows);
const results = {
  generatedAt: new Date().toISOString(),
  settings: { ...settings, mode, model: provider.model, judgeModel },
  summary,
  rows,
};
fs.mkdirSync(REPORTS_DIR, { recursive: true });
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2) + "\n");
fs.writeFileSync(reportPath, renderCitationsReport({ ...results, notes: readNotes() }));

console.log(
  `\n${mode}: answered ${summary.answered}/${summary.count} · fabricated quotes on attempt 1: ${summary.fabricatedFirstAttempt}/${summary.firstAttemptCitations}` +
    ` · retries ${summary.retries} (fixed ${summary.retriesFixed}) · dropped ${summary.droppedCitations} · downgrades ${summary.downgrades}` +
    ` · faithfulness ${summary.meanFaithfulness?.toFixed(2) ?? "—"} · uncited ${summary.uncitedClaims}` +
    ` · IDK ${summary.correctIdk}/${summary.toDecline} correct, ${summary.falseIdk.length} false${summary.falseIdk.length ? ` (${summary.falseIdk.map((x) => `${x.id} ${x.reason}`).join(", ")})` : ""}` +
    ` · fact score ${summary.meanFactScore?.toFixed(2) ?? "—"}`,
);
console.log(`→ ${path.relative(PROJECT_DIR, reportPath)}, ${path.relative(PROJECT_DIR, resultsPath)}`);
