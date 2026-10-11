#!/usr/bin/env node
/**
 * **Claude vs local models on the RAG task (Day 28).**
 *
 * The 10 `citations` questions in `rag+rerank` (7 to answer, 3 to decline),
 * answered by Claude Haiku 4.5 and then by each model in `LOCAL_MODELS`, one
 * after another, from the **same chunks**: each question is retrieved and
 * reranked once (locally) and cached in `reports/local_rag_retrieval.json`.
 * Every generator goes through `answerQuestion` with that retrieval — the
 * Knowledge chat's contract, unchanged. A local model is loaded on its own
 * (everything else unloaded first), timed, run, measured in `/api/ps`, and
 * unloaded before the next.
 *
 * Judging stays on Claude (`RAG_JUDGE_MODEL`): faithfulness and Day 22's fact
 * judge, after all generation, so the local runs are back to back.
 *
 *   npm run eval:local                         # Claude + every local model, 10 questions
 *   npm run eval:local -- --quick              # Claude + one local model, 3 questions (smoke run)
 *   npm run eval:local -- --models qwen3.5:9b  # only these local models (Claude too, unless --no-claude)
 *   npm run eval:local -- q14 q17              # some questions
 *   npm run eval:local -- --fresh              # re-retrieve instead of using the cache
 *   npm run eval:local -- --report             # re-render the report from the JSON + notes
 *   npm run eval:local -- --variant ctx8k      # Day 29: one optimization variant, local only (see below)
 *
 * Day 29, `--variant baseline | ctx8k | ctx8k+prompt` (`src/llm/variants.js`):
 * the variant's num_ctx and prompt variant override `.env`, Claude is not
 * re-run, only `LOCAL_MODELS` (qwen3.5:9b) or `--models` answer, from the
 * cached retrieval as always. Every local response's load time is recorded to
 * count reloads. Writes `reports/local_opt/eval_<variant>.json` only; the Day
 * 28 results are left alone. `npm run opt:local` runs the three in order.
 *
 * A partial run (`--models`, question ids) is merged into the existing
 * results. Writes `reports/local_rag_results.json` and
 * `reports/local_rag_report.md` (`--quick`: `local_rag_quick_*`). Needs
 * ANTHROPIC_API_KEY (Claude's generation and the judges), Ollama, and a built
 * index. Not part of `npm test`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import "dotenv/config";

import { AnthropicProvider } from "../src/llm/anthropic.js";
import { createLlms } from "../src/llm/choice.js";
import { countReloads, loadOllamaModule } from "../src/llm/ollama.js";
import { optVariant, variantEnv, variantSlug } from "../src/llm/variants.js";
import { CITATION_SET, checksOf, verificationLabel } from "../src/rag/citationsEval.js";
import { PROJECT_DIR, RAG_QUESTIONS_PATH, REPORTS_DIR, ragSettings } from "../src/rag/config.js";
import { validateQuestions } from "../src/rag/eval.js";
import { judgeFaithfulness } from "../src/rag/faithfulness.js";
import { judgeAnswer } from "../src/rag/judge.js";
import { answerLatencyMs, counter, loadRetrievals, quickQuestions, renderLocalReport, retrievalSummary, runGenerator, summarizeGenerator } from "../src/rag/localEval.js";

export const CLAUDE_GENERATOR = "claude-haiku-4-5-20251001";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : (args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? null);
};
const quick = flag("--quick");
// Day 29: an optimization variant overrides the local settings before anything reads them.
const variantId = option("--variant");
let variant = null;
if (variantId) {
  try {
    variant = optVariant(variantId);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
  Object.assign(process.env, variantEnv(variant.id, {}));
}
const runStartedAt = new Date().toISOString();
const prefix = quick ? "local_rag_quick" : "local_rag";
const variantPath = variant ? path.join(REPORTS_DIR, "local_opt", `eval_${variantSlug(variant.id)}.json`) : null;
const resultsPath = path.join(REPORTS_DIR, `${prefix}_results.json`);
const reportPath = path.join(REPORTS_DIR, `${prefix}_report.md`);
const notesPath = path.join(REPORTS_DIR, "local_rag_notes.md");
const cachePath = path.join(REPORTS_DIR, "local_rag_retrieval.json");
const readNotes = () => (!quick && fs.existsSync(notesPath) ? fs.readFileSync(notesPath, "utf8") : null);
const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);

function fail(lines) {
  console.error(["✗ " + lines[0], ...lines.slice(1).map((l) => "  " + l)].join("\n"));
  process.exit(1);
}

function render(results) {
  const retrievals = readJson(cachePath)?.questions ?? {};
  const shared = Object.fromEntries(results.questions.map((q) => [q.id, retrievals[q.id]?.retrieval]).filter(([, r]) => r));
  fs.writeFileSync(reportPath, renderLocalReport({ ...results, retrievals: shared, notes: readNotes(), quick }));
}

if (variant && (quick || flag("--report") || flag("--fresh"))) fail(["--variant runs the full set from the cached retrieval: drop --quick, --report and --fresh"]);
if (flag("--report")) {
  const results = readJson(resultsPath);
  if (!results) fail([`${path.relative(PROJECT_DIR, resultsPath)} does not exist: run the eval first`]);
  render(results);
  console.log(`→ ${path.relative(PROJECT_DIR, reportPath)} re-rendered from ${path.basename(resultsPath)}`);
  process.exit(0);
}

// ---- questions --------------------------------------------------------------------
const valued = new Set(["--models", "--variant"].map((name) => args.indexOf(name) + 1).filter((i) => i > 0));
const only = args.filter((a, i) => !a.startsWith("--") && !valued.has(i));
const questions = JSON.parse(fs.readFileSync(RAG_QUESTIONS_PATH, "utf8"));
const shapeErrors = validateQuestions(questions);
if (shapeErrors.length) fail(["questions.json is invalid:", ...shapeErrors]);
let selected = questions.filter((q) => q.sets?.includes(CITATION_SET));
if (quick) selected = quickQuestions(selected);
if (only.length) selected = selected.filter((q) => only.includes(q.id));
if (!selected.length) fail([`no question in the "${CITATION_SET}" set with id ${only.join(", ")}`]);

if (!process.env.ANTHROPIC_API_KEY) fail(["ANTHROPIC_API_KEY is not set (first-agent/.env): Claude generates the baseline and judges"]);
const judgeProvider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
const judgeModel = process.env.RAG_JUDGE_MODEL || judgeProvider.model;
const settings = ragSettings();

// ---- local models -------------------------------------------------------------------
// Day 29: every local response, in order, for counting reloads (the warm-up is the first).
const responses = [];
const llms = createLlms({ claude: judgeProvider, claudeAvailable: true, onLocalResponse: (r) => responses.push(r) });
const { createOllama } = await loadOllamaModule(llms.settings.dir);
const ollama = createOllama({ url: llms.settings.url, timeoutMs: llms.settings.timeoutMs });
let ollamaVersion;
let installed;
try {
  [ollamaVersion, installed] = await Promise.all([ollama.version(), ollama.list()]);
} catch (err) {
  fail([err.message]);
}
const installedNames = installed.map((m) => m.name ?? m.model);
const wanted = option("--models")?.split(",").map((s) => s.trim()).filter(Boolean) ?? (await llms.localModels({ installed }));
let localModels = wanted;
if (quick && !option("--models")) localModels = wanted.slice(0, 1);
const missing = localModels.filter((m) => !installedNames.includes(m));
if (missing.length) fail([`not installed: ${missing.join(", ")}`, `pull with: ollama pull ${missing[0]}`]);
const withClaude = !flag("--no-claude") && !variant;

// ---- 1. retrieve once -----------------------------------------------------------------
console.log(`Retrieval (local, shared): ${selected.length} question(s), rag+rerank, k_retrieve ${settings.kRetrieve}, cutoff ${settings.rerankThreshold}`);
const loaded = await loadRetrievals({ questions: selected, settings, cache: readJson(cachePath), fresh: flag("--fresh") });
fs.mkdirSync(REPORTS_DIR, { recursive: true });
fs.writeFileSync(cachePath, JSON.stringify(loaded.cache, null, 2) + "\n");
console.log(`  reused ${loaded.reused.length} from ${path.basename(cachePath)}, retrieved ${loaded.retrieved.length}`);

// ---- 2. generate, one generator after another ----------------------------------------
const settingsForRun = { ...settings };
const nextOrder = counter();
const generators = [];
const printRow = (label) => (row) =>
  console.log(
    `  #${String(row.order).padStart(2)} ${row.startedAt.slice(11, 19)} ${row.id.padEnd(4)} ${row.error ? `ERROR ${row.error}` : `${row.run.status.padEnd(9)}${row.run.dontKnow ? ` (${row.run.dontKnow.reason})` : ""}`}` +
      ` · ${verificationLabel(row.run)} · ${(answerLatencyMs(row.run) / 1000).toFixed(1)} s` +
      `${row.run.generation?.metrics?.genTps ? ` · ${row.run.generation.metrics.genTps} tok/s` : ""}` +
      `${row.run.generation?.invalidJson ? ` · ${row.run.generation.invalidJson} invalid JSON` : ""}${row.run.possible_truncation ? " · ⚠ POSSIBLE TRUNCATION" : ""}`,
  );

if (withClaude) {
  console.log(`\nClaude: ${CLAUDE_GENERATOR} (cloud, streamed for TTFT)`);
  const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID, model: CLAUDE_GENERATOR, stream: true });
  const rows = await runGenerator({ generator: { id: "claude", provider }, questions: selected, retrievals: loaded.retrievals, settings: settingsForRun, nextOrder, onRow: printRow("claude") });
  generators.push({ id: "claude", label: "Claude Haiku 4.5", where: "cloud", model: CLAUDE_GENERATOR, rows, extra: {} });
}

const unloadAll = async () => {
  for (const m of await ollama.running()) await ollama.unload(m.name ?? m.model);
};
for (const model of localModels) {
  await unloadAll();
  const numCtx = llms.settings.ragNumCtx;
  const firstResponse = responses.length;
  process.stdout.write(`\n${model}: loading (num_ctx ${numCtx}${variant ? `, prompts ${llms.settings.promptVariant}` : ""})… `);
  // Same num_ctx as the RAG calls, so the load is not repeated by the first question.
  const warm = await ollama.chat({ model, messages: [{ role: "user", content: "Say OK." }], num_predict: 1, num_ctx: numCtx, think: false });
  responses.push({ model, numCtx, loadMs: warm.metrics.load_ms, promptTokens: warm.metrics.prompt_tokens, at: new Date().toISOString(), warmUp: true });
  console.log(`load ${(warm.metrics.load_ms / 1000).toFixed(2)} s`);
  const provider = llms.localRag(model);
  const rows = await runGenerator({ generator: { id: model, provider }, questions: selected, retrievals: loaded.retrievals, settings: settingsForRun, nextOrder, onRow: printRow(model) });
  const ps = (await ollama.running()).find((m) => (m.name ?? m.model) === model);
  const memory = ps ? { size: ps.size ?? null, sizeVram: ps.size_vram ?? null, contextLength: ps.context_length ?? null } : null;
  await ollama.unload(model);
  const mine = responses.slice(firstResponse);
  const reloads = countReloads(mine);
  generators.push({
    id: model,
    label: model,
    where: "local",
    model,
    rows,
    extra: { loadMs: warm.metrics.load_ms, memory, responses: mine, reloads: reloads.count, numCtxSeen: [...new Set(mine.map((r) => r.numCtx))] },
  });
}

// ---- 3. judge (cloud) -------------------------------------------------------------------
console.log(`\nJudging with ${judgeModel} (cloud)…`);
for (const g of generators) {
  for (const row of g.rows) {
    if (row.error) continue;
    if (row.run.status === "answered") row.faithfulness = await judgeFaithfulness({ provider: judgeProvider, model: judgeModel, answer: row.run.answer, citations: row.run.citations });
    if (!row.expect_decline) row.grade = await judgeAnswer({ provider: judgeProvider, model: judgeModel, question: row.question, type: row.type, expectedFacts: row.expected_facts, answer: row.run.answer });
    row.checks = { ...checksOf(row), ...(row.error ? { sources: false, citations: false, idk: false } : {}) };
  }
}

// ---- 4. merge, summarise, write ------------------------------------------------------------
if (variant) {
  // Day 29: one variant's run, on its own file; Day 28's results and report are left as they are.
  const g = generators[0];
  g.summary = { ...summarizeGenerator(g.rows, g.extra), reloads: g.extra.reloads, numCtxSeen: g.extra.numCtxSeen };
  const out = {
    variant: variant.id,
    description: variant.description,
    startedAt: runStartedAt,
    finishedAt: new Date().toISOString(),
    settings: { ...settings, mode: "rag+rerank", judgeModel, numCtx: llms.settings.numCtx, ragNumCtx: llms.settings.ragNumCtx, ragNumPredict: llms.settings.ragNumPredict, promptVariant: llms.settings.promptVariant },
    environment: { machine: `${os.cpus()[0]?.model ?? os.arch()}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM`, ollamaVersion, node: process.version },
    questions: selected.map(({ id, type, question, expect_decline }) => ({ id, type, question, expect_decline })),
    generators,
  };
  fs.mkdirSync(path.dirname(variantPath), { recursive: true });
  fs.writeFileSync(variantPath, JSON.stringify(out, null, 2) + "\n");
  const s = g.summary;
  console.log(
    `\n${variant.id} · ${g.label}: answered ${s.answered}/${s.count} · fabricated ${s.fabricatedFirstAttempt}/${s.firstAttemptCitations} · retries ${s.retries} · dropped ${s.droppedCitations} · downgrades ${s.downgrades}` +
      ` · faithfulness ${s.meanFaithfulness?.toFixed(2) ?? "—"} · IDK ${s.correctIdk}/${s.toDecline}, false ${s.falseIdk.length} · facts ${s.meanFactScore?.toFixed(2) ?? "—"}` +
      ` · TTFT ${s.meanTtftMs == null ? "—" : (s.meanTtftMs / 1000).toFixed(2) + " s"} · ${s.meanGenTps?.toFixed(1) ?? "—"} tok/s · latency ${((s.meanAnswerLatencyMs ?? 0) / 1000).toFixed(1)} s (max ${((s.maxAnswerLatencyMs ?? 0) / 1000).toFixed(1)})` +
      ` · reloads ${s.reloads} · num_ctx ${s.numCtxSeen.join("/")} · truncations ${s.possibleTruncations.length}${s.errors.length ? ` · ERRORS ${s.errors.length}` : ""}`,
  );
  console.log(`→ ${path.relative(PROJECT_DIR, variantPath)}`);
  process.exit(0);
}
const previous = !quick && (only.length || option("--models") || !withClaude) ? readJson(resultsPath) : null;
const byId = new Map((previous?.generators ?? []).map((g) => [g.id, g]));
for (const g of generators) {
  const old = byId.get(g.id);
  const rows = [...(old?.rows ?? []).filter((r) => !g.rows.some((x) => x.id === r.id)), ...g.rows];
  byId.set(g.id, { ...g, rows, extra: { ...(old?.extra ?? {}), ...g.extra } });
}
const order = ["claude", ...wanted, ...byId.keys()];
const merged = [...new Set(order)].map((id) => byId.get(id)).filter(Boolean);
const questionIds = new Set(merged.flatMap((g) => g.rows.map((r) => r.id)));
const allQuestions = questions.filter((q) => questionIds.has(q.id));
const allRetrievals = readJson(cachePath)?.questions ?? {};
const retrievalOf = Object.fromEntries(allQuestions.map((q) => [q.id, allRetrievals[q.id]?.retrieval]).filter(([, r]) => r));
for (const g of merged) {
  g.rows.sort((a, b) => allQuestions.findIndex((q) => q.id === a.id) - allQuestions.findIndex((q) => q.id === b.id));
  g.summary = summarizeGenerator(g.rows, g.extra);
}

const results = {
  generatedAt: new Date().toISOString(),
  settings: { ...settings, mode: "rag+rerank", judgeModel, claudeModel: CLAUDE_GENERATOR, localRagNumCtx: llms.settings.ragNumCtx, localRagNumPredict: llms.settings.ragNumPredict },
  environment: { machine: `${os.cpus()[0]?.model ?? os.arch()}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM`, ollamaVersion, node: process.version },
  calls: {
    cloud: [withClaude ? `generation: ${CLAUDE_GENERATOR}` : null, `judging: ${judgeModel}`].filter(Boolean),
    local: ["retrieval: EmbeddingGemma (doc_index)", "rerank: bge-reranker-v2-m3", ...localModels.map((m) => `generation: ${m} (Ollama)`)],
  },
  retrieval: retrievalSummary(retrievalOf, allQuestions.map((q) => q.id)),
  questions: allQuestions.map(({ id, type, question, expect_decline }) => ({ id, type, question, expect_decline })),
  generators: merged.map(({ extra, ...g }) => ({ ...g, extra })),
};
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2) + "\n");
render(results);

console.log("");
for (const g of merged) {
  const s = g.summary;
  console.log(
    `${g.label.padEnd(18)} answered ${s.answered}/${s.count} · fabricated ${s.fabricatedFirstAttempt}/${s.firstAttemptCitations} · retries ${s.retries} · dropped ${s.droppedCitations} · downgrades ${s.downgrades}` +
      `${g.where === "local" ? ` · invalid JSON ${s.invalidJson}/${s.structuredCalls} (failures ${s.schemaFailures})` : ""}` +
      ` · faithfulness ${s.meanFaithfulness?.toFixed(2) ?? "—"} · IDK ${s.correctIdk}/${s.toDecline}, false ${s.falseIdk.length} · facts ${s.meanFactScore?.toFixed(2) ?? "—"}` +
      ` · TTFT ${s.meanTtftMs == null ? "—" : (s.meanTtftMs / 1000).toFixed(2) + " s"} · ${s.meanGenTps?.toFixed(1) ?? "—"} tok/s · latency ${((s.meanAnswerLatencyMs ?? 0) / 1000).toFixed(1)} s (max ${((s.maxAnswerLatencyMs ?? 0) / 1000).toFixed(1)})` +
      ` · truncations ${s.possibleTruncations.length}${s.errors.length ? ` · ERRORS ${s.errors.length}` : ""}`,
  );
}
console.log(`→ ${path.relative(PROJECT_DIR, reportPath)}, ${path.relative(PROJECT_DIR, resultsPath)}, ${path.relative(PROJECT_DIR, cachePath)}`);
