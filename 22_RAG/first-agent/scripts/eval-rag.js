#!/usr/bin/env node
/**
 * **RAG vs plain, on 10 questions.** Real model, real index.
 *
 * Checks `eval/rag/questions.json` against the doc_index index (every expected
 * source exists, every fact's evidence quote is in its source) and rewrites
 * `eval/rag/questions.md`. Then answers each question in both modes with
 * `answerQuestion` — the same function the Knowledge chat uses — has the judge
 * grade each answer blind, and writes `reports/rag_results.json` and
 * `reports/rag_comparison.md` (with `reports/rag_notes.md` included as the
 * findings, if it exists).
 *
 *   npm run eval:rag               # all 10 questions, 20 answers, 20 judge calls
 *   npm run eval:rag -- q03        # one question (the report then holds only it)
 *   npm run eval:rag -- --check    # only validate the questions and write questions.md
 *   npm run eval:rag -- --report   # re-render rag_comparison.md from rag_results.json + rag_notes.md (no API calls)
 *
 * Needs ANTHROPIC_API_KEY and a built index (cd ../doc_index && npm run index).
 * Not part of `npm test`.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import "dotenv/config";

import { AnthropicProvider } from "../src/llm/anthropic.js";
import { answerQuestion } from "../src/rag/answer.js";
import { PROJECT_DIR, RAG_MAX_TOKENS, RAG_QUESTIONS_PATH, REPORTS_DIR, docIndexDir, ragSettings } from "../src/rag/config.js";
import { citationCheck, ragOutcome, renderQuestionsMd, renderReport, retrievalHit, summarize, validateQuestions, verdict, verifyAgainstIndex } from "../src/rag/eval.js";
import { judgeAnswer } from "../src/rag/judge.js";
import { buildRagPrompt } from "../src/rag/prompt.js";

const args = process.argv.slice(2);
const notesPath = path.join(REPORTS_DIR, "rag_notes.md");
const readNotes = () => (fs.existsSync(notesPath) ? fs.readFileSync(notesPath, "utf8") : null);

if (args.includes("--report")) {
  const results = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, "rag_results.json"), "utf8"));
  fs.writeFileSync(path.join(REPORTS_DIR, "rag_comparison.md"), renderReport({ ...results, notes: readNotes() }));
  console.log("→ reports/rag_comparison.md re-rendered from rag_results.json");
  process.exit(0);
}
const checkOnly = args.includes("--check");
const only = args.filter((a) => !a.startsWith("--"));

function fail(lines) {
  console.error(["✗ " + lines[0], ...lines.slice(1).map((l) => "  " + l)].join("\n"));
  process.exit(1);
}

// ---- 1. the questions, checked against the index ------------------------------

const questions = JSON.parse(fs.readFileSync(RAG_QUESTIONS_PATH, "utf8"));
const shapeErrors = validateQuestions(questions);
if (shapeErrors.length) fail(["questions.json is invalid:", ...shapeErrors]);

const { openStore } = await import(pathToFileURL(path.join(docIndexDir(), "src", "store.js")).href);
const { DEFAULT_DB_PATH } = await import(pathToFileURL(path.join(docIndexDir(), "src", "config.js")).href);
let documents;
try {
  const store = openStore(DEFAULT_DB_PATH, { readonly: true });
  const texts = store.documentTexts();
  documents = new Map(store.documents().map((d) => [d.source, texts.get(d.doc_id).text]));
  store.close();
} catch (err) {
  fail([`cannot read the index: ${err.message}`]);
}
const indexErrors = verifyAgainstIndex(questions, documents);
if (indexErrors.length) fail(["questions.json does not match the index:", ...indexErrors]);
fs.writeFileSync(path.join(path.dirname(RAG_QUESTIONS_PATH), "questions.md"), renderQuestionsMd(questions));
console.log(`✓ ${questions.length} questions valid; every expected source and fact checked against ${documents.size} indexed documents`);
if (checkOnly) process.exit(0);

// ---- 2. answer, judge ----------------------------------------------------------

if (!process.env.ANTHROPIC_API_KEY) fail(["ANTHROPIC_API_KEY is not set (first-agent/.env)"]);
const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
const settings = ragSettings();
const judgeModel = process.env.RAG_JUDGE_MODEL || provider.model;
const selected = only.length ? questions.filter((q) => only.includes(q.id)) : questions;
if (!selected.length) fail([`no question with id ${only.join(", ")}`]);

const rows = [];
for (const q of selected) {
  const row = { ...q };
  for (const mode of ["plain", "rag"]) {
    const result = await answerQuestion(q.question, { mode, provider, ...settings, log: () => {} });
    const grade = await judgeAnswer({ provider, model: judgeModel, question: q.question, type: q.type, expectedFacts: q.expected_facts, answer: result.answer });
    row[mode] = { ...result, grade };
  }
  row.rag.retrieval = retrievalHit(row.rag.chunks, q.expected_sources);
  row.rag.citations = citationCheck(row.rag.answer, row.rag.chunks, q.expected_sources);
  row.rag.outcome = ragOutcome(q, row.rag.grade, row.rag.retrieval);
  row.verdict = verdict(q, row.plain.grade, row.rag.grade);
  rows.push(row);
  console.log(
    `${q.id} ${q.type.padEnd(12)} plain ${row.plain.grade.score.toFixed(2)}  rag ${row.rag.grade.score.toFixed(2)}  ` +
      `rank ${row.rag.retrieval.rank ?? "—"}  ${row.rag.outcome.padEnd(15)} ${row.verdict}`,
  );
}

// ---- 3. write ------------------------------------------------------------------

const summary = summarize(rows);
const notes = readNotes();
const first = rows.find((row) => row.id === "q01") ?? rows[0];
const results = {
  generatedAt: new Date().toISOString(),
  settings: { ...settings, model: rows[0].rag.model, judgeModel, maxTokens: RAG_MAX_TOKENS },
  summary,
  examplePrompt: buildRagPrompt(first.question, first.rag.chunks),
  rows,
};
fs.mkdirSync(REPORTS_DIR, { recursive: true });
fs.writeFileSync(path.join(REPORTS_DIR, "rag_results.json"), JSON.stringify(results, null, 2) + "\n");
fs.writeFileSync(path.join(REPORTS_DIR, "rag_comparison.md"), renderReport({ ...results, notes }));

const { plain, rag } = summary;
console.log(
  `\nmean score plain ${plain.meanScore?.toFixed(2)} vs rag ${rag.meanScore?.toFixed(2)} · passed ${plain.passed} vs ${rag.passed} · ` +
    `hit@${settings.k} ${rag.hits}/${rag.withSources} · hallucinations ${plain.hallucinations} vs ${rag.hallucinations}`,
);
console.log(`→ ${path.relative(PROJECT_DIR, path.join(REPORTS_DIR, "rag_comparison.md"))}, reports/rag_results.json`);
