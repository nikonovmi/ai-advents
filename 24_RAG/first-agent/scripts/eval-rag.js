#!/usr/bin/env node
/**
 * **RAG modes compared, on 17 questions.** Real model, real index, real reranker.
 *
 * Checks `eval/rag/questions.json` against the doc_index index (every expected
 * source exists, every fact's evidence quote is in its source) and rewrites
 * `eval/rag/questions.md`. Then answers each question in each mode with
 * `answerQuestion` — the same function the Knowledge chat uses — has the judge
 * grade each answer blind, and writes `reports/rag_results.json` and
 * `reports/rag_comparison.md` (with `reports/rag_notes.md` included as the
 * findings, if it exists).
 *
 * Modes (default: all four): `plain` (no documents), `rag` (Day 22 baseline),
 * `rag+rerank` (cross-encoder + cutoff), `rag+rewrite+rerank` (everything).
 *
 *   npm run eval:rag                              # 17 questions × 4 modes, plus one judge call each
 *   npm run eval:rag -- q03 q12                   # some questions (the report then holds only them)
 *   npm run eval:rag -- --modes rag,rag+rerank    # some modes
 *   npm run eval:rag -- --check                   # only validate the questions and write questions.md
 *   npm run eval:rag -- --report                  # re-render rag_comparison.md from rag_results.json + rag_notes.md (no API calls)
 *
 * Needs ANTHROPIC_API_KEY and a built index (cd ../doc_index && npm run index).
 * Not part of `npm test`.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import "dotenv/config";

import { AnthropicProvider } from "../src/llm/anthropic.js";
import { answerQuestion, parseModeLabel } from "../src/rag/answer.js";
import { PROJECT_DIR, RAG_MAX_TOKENS, RAG_QUESTIONS_PATH, REPORTS_DIR, docIndexDir, ragSettings } from "../src/rag/config.js";
import { DEFAULT_MODES, citationCheck, isDeclined, outcome, rankMove, renderQuestionsMd, renderReport, retrievalStats, summarize, validateQuestions, verifyAgainstIndex } from "../src/rag/eval.js";
import { judgeAnswer } from "../src/rag/judge.js";
import { DEFAULT_RERANK_MODEL } from "../src/rag/reranker.js";
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
const modesAt = args.indexOf("--modes");
const modeArg = modesAt >= 0 ? args[modesAt + 1] : args.find((a) => a.startsWith("--modes="))?.slice("--modes=".length);
const only = args.filter((a, i) => !a.startsWith("--") && !(modesAt >= 0 && i === modesAt + 1));

function fail(lines) {
  console.error(["✗ " + lines[0], ...lines.slice(1).map((l) => "  " + l)].join("\n"));
  process.exit(1);
}

const modes = modeArg ? modeArg.split(",").map((m) => m.trim()).filter(Boolean) : DEFAULT_MODES;
const badModes = modes.filter((m) => !parseModeLabel(m));
if (modesAt >= 0 && !modeArg) fail(["--modes needs a list, e.g. --modes rag,rag+rerank"]);
if (badModes.length) fail([`unknown mode(s): ${badModes.join(", ")}`, "modes are plain, rag, rag+rerank, rag+rewrite, rag+rewrite+rerank"]);

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
  const row = { ...q, runs: {} };
  for (const mode of modes) {
    const result = await answerQuestion(q.question, { ...settings, ...parseModeLabel(mode), provider, log: () => {} });
    const grade = await judgeAnswer({ provider, model: judgeModel, question: q.question, type: q.type, expectedFacts: q.expected_facts, answer: result.answer });
    const run = { ...result, grade };
    if (run.mode === "rag") {
      run.retrieval = retrievalStats(run, q.expected_sources);
      run.citationCheck = citationCheck(run.answer, run.chunks, q.expected_sources, run.citations);
    }
    run.outcome = outcome(q, run);
    row.runs[mode] = run;
  }
  rows.push(row);
  console.log(
    `${q.id} ${q.type.padEnd(12)} ` +
      modes
        .map((m) => {
          const run = row.runs[m];
          return `${m} ${run.grade.score.toFixed(2)}${run.grade.hallucination ? "⚠" : ""}${isDeclined(run) ? "✗" : ""}${run.mode === "rag" ? ` [${rankMove(run.retrieval)}]` : ""}`;
        })
        .join("  "),
  );
}

// ---- 3. write ------------------------------------------------------------------

const summary = summarize(rows, modes);
const notes = readNotes();
const first = rows.find((row) => row.id === "q01") ?? rows[0];
const firstRag = first.runs.rag ?? Object.values(first.runs).find((run) => run.mode === "rag");
const results = {
  generatedAt: new Date().toISOString(),
  settings: { ...settings, model: provider.model, judgeModel, maxTokens: RAG_MAX_TOKENS, rerankModel: DEFAULT_RERANK_MODEL, modes },
  summary,
  examplePrompt: firstRag ? buildRagPrompt(first.question, firstRag.chunks) : undefined,
  rows,
};
fs.mkdirSync(REPORTS_DIR, { recursive: true });
fs.writeFileSync(path.join(REPORTS_DIR, "rag_results.json"), JSON.stringify(results, null, 2) + "\n");
fs.writeFileSync(path.join(REPORTS_DIR, "rag_comparison.md"), renderReport({ ...results, notes }));

for (const mode of modes) {
  const s = summary.byMode[mode];
  console.log(
    `${mode.padEnd(20)} mean score ${s.meanScore?.toFixed(2)} · passed ${s.passed}/${summary.count} · hallucinations ${s.hallucinations} · ` +
      `declines ${s.correctDeclines}/${s.toDecline} correct, ${s.wrongDeclines.length} wrong${s.wrongDeclines.length ? ` (${s.wrongDeclines.map((d) => `${d.id} ${d.by}`).join(", ")})` : ""}` +
      (s.isRag ? ` · source in final chunks ${s.hits}/${s.withSources}` : ""),
  );
}
console.log(`→ ${path.relative(PROJECT_DIR, path.join(REPORTS_DIR, "rag_comparison.md"))}, reports/rag_results.json`);
