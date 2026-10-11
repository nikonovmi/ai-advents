import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { promisify } from "node:util";

import { runCheck } from "./checks.js";

/**
 * **The benchmark: every request in eval/requests.json against each model.**
 *
 * Models run one after another, never in parallel (two ~8 GB models don't fit
 * in 16 GB together). For each model: one warm-up request that isn't counted
 * (it pays the load, reported separately as `load_ms`), then the request set,
 * then `keep_alive: 0` so the model leaves memory before the next one loads.
 */

export const REQUESTS_PATH = new URL("../eval/requests.json", import.meta.url);

/** The model families this project benchmarks by default. */
export const DEFAULT_FAMILIES = ["gemma4", "qwen3.5"];

export function loadRequests(path = REQUESTS_PATH) {
  const { passages = {}, requests } = JSON.parse(fs.readFileSync(path, "utf8"));
  return requests.map((r) => (r.passage ? { ...r, passage: { id: r.passage, ...passages[r.passage] } } : r));
}

/** The chat messages for a request; a grounded one gets the passage in the user turn. */
export function buildMessages(request) {
  if (request.type !== "grounded") return request.messages;
  return [
    { role: "system", content: request.system },
    { role: "user", content: `Passage:\n"""\n${request.passage.text}\n"""\n\nQuestion: ${request.question}` },
  ];
}

/**
 * Which models to run: `--model` wins, then LOCAL_MODELS (comma-separated),
 * then every installed model whose name starts with one of the families.
 * Returns `{ models, missing }`, `missing` being requested names not installed.
 */
export function pickModels(installed, { model, envModels = process.env.LOCAL_MODELS, families = DEFAULT_FAMILIES } = {}) {
  const names = installed.map((m) => m.name ?? m.model);
  const has = (name) => names.includes(name) || names.includes(`${name}:latest`);
  const requested = model ? [].concat(model) : envModels ? envModels.split(",").map((s) => s.trim()).filter(Boolean) : null;
  if (requested) return { models: requested.filter(has), missing: requested.filter((n) => !has(n)) };
  return { models: names.filter((n) => families.some((f) => n.startsWith(`${f}:`) || n.startsWith(`${f}-`))).sort(), missing: [] };
}

const run = promisify(execFile);
async function sysctl(key) {
  try {
    return (await run("sysctl", ["-n", key])).stdout.trim();
  } catch {
    return null;
  }
}

/** Chip, RAM and OS of this machine. */
export async function machineInfo() {
  const chip = (await sysctl("machdep.cpu.brand_string")) ?? os.cpus()[0]?.model ?? "unknown";
  let osName = `${os.type()} ${os.release()}`;
  try {
    const { stdout } = await run("sw_vers", ["-productVersion"]);
    osName = `macOS ${stdout.trim()}`;
  } catch {}
  return { chip, ram_gb: Math.round(os.totalmem() / 2 ** 30), cpus: os.cpus().length, os: osName, arch: os.arch() };
}

/** The bits of /api/show worth keeping. */
export function modelInfo(name, installed, show) {
  const tag = installed.find((m) => m.name === name);
  return {
    name,
    digest: tag?.digest?.slice(0, 12) ?? null,
    size_gb: tag?.size ? Number((tag.size / 1e9).toFixed(1)) : null,
    family: show?.details?.family ?? null,
    parameter_size: show?.details?.parameter_size ?? null,
    quantization: show?.details?.quantization_level ?? null,
    format: show?.details?.format ?? null,
    runner: show?.details?.runner ?? null,
    capabilities: show?.capabilities ?? [],
  };
}

const WARMUP = { messages: [{ role: "user", content: "Say OK." }], num_predict: 8 };

/**
 * @param {object} o
 * @param {ReturnType<import("./ollama.js").createOllama>} o.ollama
 * @param {string[]} o.models
 * @param {object[]} o.requests from loadRequests()
 * @param {(line: string) => void} [o.log]
 * @param {number} [o.seed]
 */
export async function runBench({ ollama, models, requests, log = () => {}, seed = 42 }) {
  const installed = await ollama.list();
  const results = [];
  const modelInfos = [];
  for (const name of models) {
    modelInfos.push(modelInfo(name, installed, await ollama.show(name)));

    log(`\n${name}: loading (warm-up)…`);
    const warm = await ollama.chat({ model: name, ...WARMUP, seed });
    const warmup = { text: warm.text, metrics: warm.metrics };
    log(`  loaded in ${(warm.metrics.load_ms / 1000).toFixed(1)} s`);
    modelInfos.at(-1).warmup = warmup;

    for (const request of requests) {
      const res = await ollama.chat({
        model: name,
        messages: buildMessages(request),
        format: request.format,
        seed,
        ...request.options,
      });
      const check = runCheck(res.text, request.check);
      results.push({
        request: request.id,
        type: request.type,
        model: name,
        think: res.think,
        text: res.text,
        done_reason: res.done_reason,
        check,
        metrics: res.metrics,
        timings: res.timings,
      });
      const m = res.metrics;
      log(`  ${check.pass ? "✓" : "✗"} ${request.id.padEnd(22)} ${String(m.gen_tps ?? "–").padStart(5)} tok/s  ${(m.total_ms / 1000).toFixed(1).padStart(5)} s  ${check.detail}`);
    }

    await ollama.unload(name);
    log(`  unloaded`);
  }
  return { models: modelInfos, results };
}

const mean = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

const rate = (rs, count, ms) => {
  const c = rs.reduce((a, r) => a + (r.metrics[count] ?? 0), 0);
  const t = rs.reduce((a, r) => a + (r.metrics[ms] ?? 0), 0);
  return c && t ? Number(((c / t) * 1000).toFixed(1)) : null;
};

/** Per-model summary: checks passed, load time, mean TTFT / gen tok/s / total latency. */
export function summarize({ models, results }) {
  return models.map((m) => {
    const rs = results.filter((r) => r.model === m.name);
    return {
      model: m.name,
      quantization: m.quantization,
      parameter_size: m.parameter_size,
      passed: rs.filter((r) => r.check.pass).length,
      total: rs.length,
      load_ms: m.warmup?.metrics?.load_ms ?? null,
      mean_ttft_ms: mean(rs.map((r) => r.metrics.ttft_ms)),
      mean_prompt_tps: mean(rs.map((r) => r.metrics.prompt_tps)),
      mean_gen_tps: mean(rs.map((r) => r.metrics.gen_tps)),
      mean_total_ms: mean(rs.map((r) => r.metrics.total_ms)),
      gen_tokens: rs.reduce((a, r) => a + (r.metrics.gen_tokens ?? 0), 0),
      // Token-weighted: total generated tokens / total generation time, so
      // two-token answers don't drag the rate down the way they do the mean.
      overall_gen_tps: rate(rs, "gen_tokens", "eval_ms"),
      overall_prompt_tps: rate(
        rs.map((r) => ({ metrics: { ...r.metrics, new_prompt_tokens: (r.metrics.prompt_tokens ?? 0) - (r.metrics.cached_prompt_tokens ?? 0) } })),
        "new_prompt_tokens",
        "prompt_eval_ms",
      ),
    };
  });
}
