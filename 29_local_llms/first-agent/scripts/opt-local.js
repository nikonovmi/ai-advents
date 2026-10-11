#!/usr/bin/env node
/**
 * **`npm run opt:local` — Day 29: optimizing qwen3.5:9b for the RAG chat.**
 *
 * Runs the three variants of `src/llm/variants.js` in order — `baseline`,
 * `ctx8k`, `ctx8k+prompt` — each as `eval:local -- --variant <v>` (the 10
 * citations questions from Day 28's cached retrieval, judged by Claude) and
 * then `verify:local -- --variant <v>` (the Knowledge RAG conversation, fully
 * local), with `--cooldown` seconds between variants (the Air is fanless).
 * After the baseline it compares with Day 28's qwen column and stops if the
 * setup looks changed (fact score off by > 0.1, latency by > 30 %), unless
 * `--force`. Then it counts each prompt's tokens on qwen, applies the decision
 * rule, and writes `reports/local_opt_results.json` and
 * `reports/local_opt_report.md`.
 *
 *   npm run opt:local                        # all three, cooldown 180 s
 *   npm run opt:local -- --cooldown 60
 *   npm run opt:local -- --only ctx8k+prompt # re-run one variant, keep the others' files
 *   npm run opt:local -- --report            # re-render from reports/local_opt/*.json + notes
 *
 * Needs ANTHROPIC_API_KEY (judges), Ollama with qwen3.5:9b, and doc_index. Not part of `npm test`.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import "dotenv/config";

import { createLlms } from "../src/llm/choice.js";
import { loadOllamaModule } from "../src/llm/ollama.js";
import { OPT_VARIANTS, OPT_VARIANT_IDS, optVariant, variantSlug } from "../src/llm/variants.js";
import { CHAT_RULES } from "../src/rag/chatTurn.js";
import { PROJECT_DIR, REPORTS_DIR } from "../src/rag/config.js";
import { baselineDrift, decide, renderOptReport, variantRecord } from "../src/rag/optEval.js";
import { RAG_SYSTEM, RAG_SYSTEM_V2 } from "../src/rag/prompt.js";
import { ROUTER_SYSTEM, ROUTER_SYSTEM_V2 } from "../src/rag/router.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : (args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? null);
};
const OPT_DIR = path.join(REPORTS_DIR, "local_opt");
const resultsPath = path.join(REPORTS_DIR, "local_opt_results.json");
const reportPath = path.join(REPORTS_DIR, "local_opt_report.md");
const notesPath = path.join(REPORTS_DIR, "local_opt_notes.md");
const promptsPath = path.join(OPT_DIR, "prompt_tokens.json");
const day28Path = path.join(REPORTS_DIR, "local_rag_results.json");
const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
const evalPath = (id) => path.join(OPT_DIR, `eval_${variantSlug(id)}.json`);
const verifyPath = (id) => path.join(OPT_DIR, `verify_${variantSlug(id)}.json`);
const QWEN = "qwen3.5:9b";

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const cooldownS = Number(option("--cooldown") ?? 180);
if (!Number.isFinite(cooldownS) || cooldownS < 0) fail(`--cooldown must be a number of seconds, got "${option("--cooldown")}"`);
const only = option("--only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
for (const id of only ?? []) {
  try {
    optVariant(id);
  } catch (err) {
    fail(err.message);
  }
}

const day28 = readJson(day28Path);
const day28Qwen = day28?.generators?.find((g) => g.id === QWEN) ?? null;
const day28Claude = day28?.generators?.find((g) => g.id === "claude") ?? null;

// ---- 1. run -------------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (script, variant) => {
  const startedAt = new Date().toISOString();
  console.log(`\n=== ${startedAt.slice(11, 19)} ${script} --variant ${variant} ===`);
  const res = spawnSync(process.execPath, [path.join(PROJECT_DIR, "scripts", script), "--variant", variant], { stdio: "inherit", cwd: PROJECT_DIR });
  return { startedAt, status: res.status };
};

if (!flag("--report")) {
  const todo = OPT_VARIANTS.filter((v) => !only || only.includes(v.id));
  for (const [i, v] of todo.entries()) {
    if (i > 0 && cooldownS > 0) {
      console.log(`\n… cooldown ${cooldownS} s before ${v.id}`);
      await sleep(cooldownS * 1000);
    }
    const e = run("eval-local.js", v.id);
    if (e.status !== 0) fail(`eval:local --variant ${v.id} failed (exit ${e.status})`);
    if (v.id === "baseline" && day28Qwen) {
      const drift = baselineDrift(readJson(evalPath("baseline")).generators[0].summary, day28Qwen.summary);
      console.log(`\nBaseline vs Day 28's qwen: fact score ${drift.factDiff >= 0 ? "+" : ""}${drift.factDiff?.toFixed(2)} · latency ${drift.latencyRatio >= 0 ? "+" : ""}${Math.round((drift.latencyRatio ?? 0) * 100)}%`);
      if (!drift.ok && !flag("--force")) fail("the baseline differs a lot from Day 28 (fact score off by > 0.1 or latency by > 30%): something in the setup changed. Stopping. (--force to go on)");
    }
    const r = run("verify-local.js", v.id);
    if (r.status !== 0) console.log(`(verify:local --variant ${v.id} ended FAIL; recorded, going on)`);
  }

  // ---- 2. the prompts' token counts, on qwen, after the runs (no load before the baseline) ----
  console.log("\nCounting prompt tokens on qwen3.5:9b…");
  const llms = createLlms({ claude: null, claudeAvailable: false });
  const { createOllama } = await loadOllamaModule(llms.settings.dir);
  const ollama = createOllama({ url: llms.settings.url, timeoutMs: llms.settings.timeoutMs });
  const count = async (system) => {
    const messages = [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: "OK" }];
    const res = await ollama.chat({ model: QWEN, messages, num_predict: 1, num_ctx: 8192, think: false });
    return res.metrics.prompt_tokens;
  };
  const empty = await count(null);
  const tokens = async (text) => (await count(text)) - empty;
  const prompts = [
    { key: "contract", label: "contract prompt (`submit_answer`, eval:local)", v1: RAG_SYSTEM, v2: RAG_SYSTEM_V2, diff: true },
    { key: "chat", label: "contract prompt + chat rules (the chat's answer call)", v1: `${RAG_SYSTEM}\n${CHAT_RULES}`, v2: `${RAG_SYSTEM_V2}\n${CHAT_RULES}`, diff: false },
    { key: "router", label: "router prompt (`route`)", v1: ROUTER_SYSTEM, v2: ROUTER_SYSTEM_V2, diff: true },
  ];
  const list = [];
  for (const p of prompts) {
    list.push({ key: p.key, label: p.label, diff: p.diff, v1: { chars: p.v1.length, tokens: await tokens(p.v1), text: p.v1 }, v2: { chars: p.v2.length, tokens: await tokens(p.v2), text: p.v2 } });
  }
  await ollama.unload(QWEN);
  fs.mkdirSync(OPT_DIR, { recursive: true });
  fs.writeFileSync(promptsPath, JSON.stringify({ model: QWEN, countedAt: new Date().toISOString(), method: "prompt_eval_count(system + 'OK') − prompt_eval_count('OK')", list }, null, 2) + "\n");
  for (const p of list) console.log(`  ${p.key}: v1 ${p.v1.tokens} tokens (${p.v1.chars} chars) → v2 ${p.v2.tokens} tokens (${p.v2.chars} chars)`);
}

// ---- 3. assemble, decide, write ----------------------------------------------------------------
const variants = OPT_VARIANTS.map((variant) => variantRecord({ variant, evalRun: readJson(evalPath(variant.id)), verifyRun: readJson(verifyPath(variant.id)) }));
if (!variants.some((v) => v.eval)) fail(`no variant results in ${path.relative(PROJECT_DIR, OPT_DIR)}: run npm run opt:local first`);
const anyEval = readJson(evalPath(variants.find((v) => v.eval).id));
const baseline = variants.find((v) => v.id === "baseline")?.eval?.summary;
const drift = baseline && day28Qwen ? { ...baselineDrift(baseline, day28Qwen.summary), baseline: pick(baseline), day28: pick(day28Qwen.summary) } : null;
const decision = decide(variants);
const results = {
  generatedAt: new Date().toISOString(),
  order: OPT_VARIANT_IDS,
  cooldownS,
  environment: { ...anyEval.environment, machine: anyEval.environment?.machine ?? `${os.cpus()[0]?.model}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM` },
  questions: anyEval.questions,
  variants,
  reference: day28Claude ? { claudeGeneratedAt: day28.generatedAt, claude: { label: day28Claude.label, model: day28Claude.model, summary: day28Claude.summary, rows: day28Claude.rows }, day28Qwen: day28Qwen ? { summary: day28Qwen.summary } : null } : null,
  drift,
  decision,
  prompts: readJson(promptsPath),
};
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2) + "\n");
fs.writeFileSync(reportPath, renderOptReport(results, fs.existsSync(notesPath) ? fs.readFileSync(notesPath, "utf8") : null));

console.log(`\nDecision: adopted ${decision.adopted}`);
console.log(`  ctx8k: ${decision.ctx8k.adopted ? "adopted" : `not adopted — ${decision.ctx8k.failed.join("; ")}`}`);
console.log(`  ctx8k+prompt: ${decision.prompt.adopted ? "adopted" : `not adopted — ${decision.prompt.failed.join("; ")}`}`);
console.log(`→ ${path.relative(PROJECT_DIR, reportPath)}, ${path.relative(PROJECT_DIR, resultsPath)}`);

function pick(s) {
  return { meanFactScore: s.meanFactScore, meanAnswerLatencyMs: s.meanAnswerLatencyMs, meanFaithfulness: s.meanFaithfulness };
}
