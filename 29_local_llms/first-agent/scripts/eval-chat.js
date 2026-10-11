#!/usr/bin/env node
/**
 * **Two long scripted conversations through the Knowledge chat (Day 25).**
 * Real router, real answering model, real index, real reranker.
 *
 * Each scenario in `eval/chat/` is replayed on a fresh chat through
 * `POST /chat` — the same route, `ragRoutes`, that the page uses — mounted on
 * an in-process server with an in-memory store, so the eval runs what the UI
 * runs, turn by turn. Then per turn:
 *
 * - intent: the router's intent (after code overrides) vs `expected_intent`;
 * - sources + citations: an answer with ≥ 1 source and ≥ 1 verified citation,
 *   or a correct "I don't know" where `decline` is true; fabricated quotes on
 *   the first attempt are counted;
 * - expected source: when given, retrieved (in the kept chunks) and cited;
 * - constraint: sentence / word counts where `constraint_check` is set;
 * - memory: the memory-checkpoint judge, which also flags stale items;
 * - on track: the on-track judge, plus Day 24's faithfulness judge on the claims;
 * - facts: Day 22's fact judge, when `expect.facts` is given.
 *
 * Writes `reports/chat_results.json` and `reports/chat_report.md` (with
 * `reports/chat_notes.md` as the findings, if it exists). Running one scenario
 * keeps the other's results from the last run.
 *
 *   npm run eval:chat                  # both scenarios
 *   npm run eval:chat -- scenario-1    # one
 *   npm run eval:chat -- --check       # validate the scenario files against the schema and the index, no API calls
 *   npm run eval:chat -- --report      # re-render the report from the JSON + notes (no API calls)
 *
 * Needs ANTHROPIC_API_KEY and a built index. Not part of `npm test`.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import "dotenv/config";
import express from "express";

import { AnthropicProvider } from "../src/llm/anthropic.js";
import { estimateCost } from "../src/llm/pricing.js";
import { SCENARIO_IDS, failureReasons, sentenceCount, constraintCheck, loadScenarios, missingElements, renderChatReport, summarizeScenario, turnChecks, validateScenario } from "../src/rag/chatEval.js";
import { judgeMemory, judgeOnTrack } from "../src/rag/chatJudge.js";
import { PROJECT_DIR, REPORTS_DIR, chatSettings, docIndexDir, ragSettings } from "../src/rag/config.js";
import { judgeFaithfulness } from "../src/rag/faithfulness.js";
import { judgeAnswer } from "../src/rag/judge.js";
import { ragRoutes } from "../src/ragRoutes.js";
import { MemoryStore } from "../src/store/memoryStore.js";

const args = process.argv.slice(2);
const resultsPath = path.join(REPORTS_DIR, "chat_results.json");
const reportPath = path.join(REPORTS_DIR, "chat_report.md");
const notesPath = path.join(REPORTS_DIR, "chat_notes.md");
const readNotes = () => (fs.existsSync(notesPath) ? fs.readFileSync(notesPath, "utf8") : null);

function fail(lines) {
  console.error(["✗ " + lines[0], ...lines.slice(1).map((l) => "  " + l)].join("\n"));
  process.exit(1);
}

if (args.includes("--report")) {
  const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  fs.writeFileSync(reportPath, renderChatReport({ ...results, notes: readNotes() }));
  console.log("→ reports/chat_report.md re-rendered from chat_results.json");
  process.exit(0);
}

// ---- 1. the scenarios, checked ------------------------------------------------------

const chat = chatSettings();
const scenarios = loadScenarios();
const shapeErrors = scenarios.flatMap(validateScenario);
if (shapeErrors.length) fail(["scenario files are invalid:", ...shapeErrors]);
const missing = missingElements(scenarios, { historyTurns: chat.historyTurns });
if (missing.length) fail(["the scenarios lack required elements:", ...missing]);

const { openStore } = await import(pathToFileURL(path.join(docIndexDir(), "src", "store.js")).href);
const { DEFAULT_DB_PATH } = await import(pathToFileURL(path.join(docIndexDir(), "src", "config.js")).href);
let indexed;
try {
  const store = openStore(DEFAULT_DB_PATH, { readonly: true });
  indexed = new Set(store.documents().map((d) => d.source));
  store.close();
} catch (err) {
  fail([`cannot read the index: ${err.message}`]);
}
const notIndexed = scenarios.flatMap((s) => s.messages.flatMap((m) => (m.expect.sources ?? []).filter((src) => !indexed.has(src)).map((src) => `${s.id} turn ${m.turn}: ${src}`)));
if (notIndexed.length) fail(["expected sources not in the index:", ...notIndexed]);
console.log(`✓ ${scenarios.map((s) => `${s.id} (${s.messages.length} messages)`).join(", ")}: schema, required elements, sources in the index`);
if (args.includes("--check")) process.exit(0);

const only = args.filter((a) => !a.startsWith("--"));
const unknown = only.filter((id) => !SCENARIO_IDS.includes(id));
if (unknown.length) fail([`unknown scenario: ${unknown.join(", ")} (have ${SCENARIO_IDS.join(", ")})`]);
const selected = only.length ? scenarios.filter((s) => only.includes(s.id)) : scenarios;

// ---- 2. the chat, as the page reaches it ------------------------------------------

if (!process.env.ANTHROPIC_API_KEY) fail(["ANTHROPIC_API_KEY is not set (first-agent/.env)"]);
const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
const settings = ragSettings();
const judgeModel = process.env.RAG_JUDGE_MODEL || provider.model;
const store = new MemoryStore();
const app = express();
app.use(express.json());
app.use(ragRoutes({ store, provider, settings, chat, log: () => {} }));
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function post(body) {
  const res = await fetch(base + "/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

const judgeCost = { inputTokens: 0, outputTokens: 0 };
const countJudge = (r) => {
  judgeCost.inputTokens += r?.usage?.inputTokens ?? 0;
  judgeCost.outputTokens += r?.usage?.outputTokens ?? 0;
  return r;
};

async function runScenario(scenario) {
  const sessionId = crypto.randomUUID();
  const rows = [];
  console.log(`\n${scenario.id}: ${scenario.title}`);
  for (const message of scenario.messages) {
    const before = (await store.load(sessionId))?.messages ?? [];
    const startedAt = Date.now();
    const res = await post({ message: message.user, sessionId, agent: "knowledge", ragMode: "rag", rerank: true });
    const ms = Date.now() - startedAt;
    const row = { message, route: null, run: null, reply: "", ms, tokens: null, cost: 0, memoryCheck: null, onTrack: null, faithfulness: null, grade: null, constraint: null };
    if (res.status !== 200) {
      row.error = res.body?.error ?? `HTTP ${res.status}`;
      row.reply = `(error) ${row.error}`;
    } else {
      const meta = res.body.meta;
      row.route = meta.route;
      row.run = meta.rag ?? null;
      row.reply = res.body.reply;
      row.tokens = meta.tokens;
      row.cost = meta.cost?.total ?? 0;
    }
    const after = (await store.load(sessionId))?.messages ?? [];
    const userMessages = after.filter((m) => m.role === "user").map((m) => m.content);

    if (message.memory_checkpoint?.length && row.route) {
      row.memoryCheck = countJudge(await judgeMemory({ provider, model: judgeModel, userMessages, memory: row.route.memoryAfter, statements: message.memory_checkpoint }));
    }
    if (!message.expect.decline && row.route) {
      row.onTrack = countJudge(
        await judgeOnTrack({
          provider,
          model: judgeModel,
          memory: row.route.memoryAfter,
          recent: before.slice(-chat.historyTurns).map(({ role, content }) => ({ role, content })),
          message: message.user,
          standaloneQuestion: row.route.standaloneQuestion,
          reply: row.reply,
          sentences: sentenceCount(row.reply),
        }),
      );
    }
    if (row.run?.status === "answered") row.faithfulness = countJudge(await judgeFaithfulness({ provider, model: judgeModel, answer: row.reply, citations: row.run.citations }));
    if (message.expect.facts?.length) {
      row.grade = countJudge(await judgeAnswer({ provider, model: judgeModel, question: row.route?.standaloneQuestion || message.user, type: "corpus", expectedFacts: message.expect.facts, answer: row.reply }));
    }
    row.constraint = constraintCheck(message, row);
    row.checks = turnChecks(message, row);
    row.reasons = [...(row.error ? [`error: ${row.error}`] : []), ...failureReasons(message, row)];
    rows.push(row);

    const r = row.route;
    const marks = Object.entries(row.checks).filter(([, v]) => v !== null).map(([k, v]) => `${v ? "✓" : "✗"}${k}`).join(" ");
    console.log(
      `  t${String(message.turn).padStart(2)} ${message.expected_intent.padEnd(11)}→ ${(r?.intent ?? "error").padEnd(11)} ${(row.run?.status ?? "").padEnd(9)} ` +
        `${(ms / 1000).toFixed(1).padStart(5)} s (router ${((r?.routerMs ?? 0) / 1000).toFixed(1)} s) · ${marks}`,
    );
    if (r?.intent === "search") console.log(`       "${r.standaloneQuestion}" · ${r.queries.map((q) => JSON.stringify(q)).join(" · ")}`);
    if (r?.diff && (r.diff.added.length || r.diff.removed.length || r.diff.goalChanged)) {
      console.log(`       memory: ${r.diff.goalChanged ? "goal changed · " : ""}+${r.diff.added.join(",") || "∅"} −${r.diff.removed.map((x) => x.id).join(",") || "∅"}`);
    }
    for (const reason of row.reasons) console.log(`       ✗ ${reason}`);
  }
  return { id: scenario.id, title: scenario.title, kind: scenario.kind, description: scenario.description, sessionId, rows, summary: summarizeScenario(rows) };
}

const ran = [];
try {
  for (const scenario of selected) ran.push(await runScenario(scenario));
} finally {
  server.close();
}

// ---- 3. results and report -------------------------------------------------------

const previous = fs.existsSync(resultsPath) ? JSON.parse(fs.readFileSync(resultsPath, "utf8")) : null;
const merged = SCENARIO_IDS.map((id) => ran.find((s) => s.id === id) ?? previous?.scenarios?.find((s) => s.id === id)).filter(Boolean);
const judge = estimateCost({ model: judgeModel, inputTokens: judgeCost.inputTokens, outputTokens: judgeCost.outputTokens });
const results = {
  generatedAt: new Date().toISOString(),
  settings: { ...settings, ...chat, mode: "rag+rerank", model: provider.model, judgeModel, judgeTokens: judgeCost, judgeCostUsd: judge.totalCost },
  scenarios: merged,
};
fs.mkdirSync(REPORTS_DIR, { recursive: true });
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2) + "\n");
fs.writeFileSync(reportPath, renderChatReport({ ...results, notes: readNotes() }));

for (const s of ran) {
  const x = s.summary;
  console.log(
    `\n${s.id}: turns passed ${x.turnsPassed}/${x.turns} · intent ${x.intent.correct}/${x.intent.total} · sourced ${x.answeredWithSources}/${x.searchTurns}` +
      ` · fabricated ${x.fabricatedFirstAttempt} · IDK ${x.correctDeclines}/${x.toDecline} (false ${x.falseDeclines.length})` +
      ` · constraint ${x.constraint.passed}/${x.constraint.applied} · memory ${x.memory.passed}/${x.memory.applied} · on track ${x.onTrack.passed}/${x.onTrack.applied}` +
      ` · facts ${x.facts.passed}/${x.facts.applied} · router ${((x.meanRouterMs ?? 0) / 1000).toFixed(1)} s · answer ${((x.meanAnswerMs ?? 0) / 1000).toFixed(1)} s`,
  );
}
console.log(`→ ${path.relative(PROJECT_DIR, reportPath)}, ${path.relative(PROJECT_DIR, resultsPath)}`);
