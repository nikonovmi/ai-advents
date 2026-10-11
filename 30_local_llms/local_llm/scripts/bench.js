import fs from "node:fs";

import { loadRequests, machineInfo, pickModels, runBench, summarize } from "../src/bench.js";
import { createOllama, OllamaError, pullHint } from "../src/ollama.js";
import { renderReport, summaryTable } from "../src/report.js";
import { loadEnv, parseArgs, runMain } from "./common.js";

/**
 * npm run bench [-- --model qwen3.5:9b] [-- --only reasoning]
 *
 * Runs eval/requests.json against each model, one model at a time, and writes
 * reports/day26_results.json and reports/day26_report.md.
 */

loadEnv();
const { flags } = parseArgs();
const RESULTS = new URL("../reports/day26_results.json", import.meta.url);
const REPORT = new URL("../reports/day26_report.md", import.meta.url);
const SEED = 42;

runMain(async () => {
  const ollama = createOllama();
  const ollama_version = await ollama.version();
  const { models, missing } = pickModels(await ollama.list(), { model: flags.model });
  if (missing.length) throw new OllamaError(`Not installed: ${missing.join(", ")}.\nPull with \`${missing.map(pullHint).join(" && ")}\`.`, { code: "model_missing" });
  if (!models.length) throw new OllamaError("No gemma4 / qwen3.5 model is installed. Pull one (`ollama pull qwen3.5:9b`) or set LOCAL_MODELS.", { code: "model_missing" });

  let requests = loadRequests();
  if (flags.only) requests = requests.filter((r) => String(flags.only).split(",").includes(r.id));

  const machine = await machineInfo();
  console.log(`Ollama ${ollama_version} · ${machine.chip}, ${machine.ram_gb} GB · ${models.join(", ")} · ${requests.length} requests`);

  const started_at = new Date().toISOString();
  const run = await runBench({ ollama, models, requests, seed: SEED, log: (l) => console.log(l) });
  const out = {
    started_at,
    finished_at: new Date().toISOString(),
    ollama_url: ollama.url,
    ollama_version,
    machine,
    settings: { temperature: 0, seed: SEED, think: false },
    ...run,
    summary: summarize(run),
  };

  fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2) + "\n");
  fs.writeFileSync(REPORT, renderReport(out, requests));
  console.log(`\n${summaryTable(out.summary)}\n\n→ reports/day26_results.json, reports/day26_report.md`);
});
