import assert from "node:assert/strict";
import { test } from "node:test";

import { buildMessages, loadRequests, pickModels, runBench, summarize } from "./bench.js";
import { createOllama } from "./ollama.js";
import { renderReport } from "./report.js";
import { chatResponse, fakeFetch } from "./testing/fakes.js";

const installed = [{ name: "gemma4:12b" }, { name: "qwen3.5:9b" }, { name: "embeddinggemma:latest" }];

test("model picking: families by default, LOCAL_MODELS, then --model", () => {
  assert.deepEqual(pickModels(installed, { envModels: "" }).models, ["gemma4:12b", "qwen3.5:9b"]);
  assert.deepEqual(pickModels(installed, { envModels: "qwen3.5:9b, llama3:8b" }), { models: ["qwen3.5:9b"], missing: ["llama3:8b"] });
  assert.deepEqual(pickModels(installed, { model: "gemma4:12b", envModels: "qwen3.5:9b" }).models, ["gemma4:12b"]);
  assert.deepEqual(pickModels(installed, { model: "embeddinggemma" }).models, ["embeddinggemma"]);
});

test("a grounded request puts the passage and the question in the user turn", () => {
  const req = loadRequests().find((r) => r.id === "grounded-unanswerable");
  const [system, user] = buildMessages(req);
  assert.match(system.content, /I don't know/);
  assert.match(user.content, /adds only ~9 MB/);
  assert.match(user.content, /Question: What is the minimum iOS version/);
});

test("bench: warm-up, requests, unload, one model at a time", async () => {
  const answers = { simple: "Canberra", reasoning: "Answer: 7", structured: "{}", "grounded-answerable": "About 9 MB.", "grounded-unanswerable": "I don't know" };
  const requests = loadRequests();
  const fetch = fakeFetch({
    "GET /api/tags": { models: installed },
    "POST /api/show": { details: { family: "fake", parameter_size: "9B", quantization_level: "Q4_K_M" }, capabilities: ["completion"] },
    "POST /api/generate": {},
    "POST /api/chat": (body) => {
      const last = body.messages.at(-1).content;
      const req = requests.find((r) => buildMessages(r).at(-1).content === last);
      return chatResponse(req ? answers[req.id] : "OK", req ? {} : { load_duration: 4e9 });
    },
  });
  const run = await runBench({ ollama: createOllama({ fetch }), models: ["gemma4:12b", "qwen3.5:9b"], requests });

  const sequence = fetch.calls.filter((c) => c.path !== "/api/tags").map((c) => `${c.path} ${c.body.model}`);
  const perModel = (m) => [`/api/show ${m}`, ...Array(1 + requests.length).fill(`/api/chat ${m}`), `/api/generate ${m}`];
  assert.deepEqual(sequence, [...perModel("gemma4:12b"), ...perModel("qwen3.5:9b")]);

  assert.equal(run.results.length, 2 * requests.length);
  assert.equal(run.models[0].warmup.metrics.load_ms, 4000);
  assert.equal(run.models[0].quantization, "Q4_K_M");

  const [s] = summarize(run);
  assert.equal(s.passed, requests.length - 1); // "{}" fails the structured check
  assert.equal(s.load_ms, 4000);
  assert.equal(s.mean_gen_tps, 20);
  assert.equal(s.mean_ttft_ms, 750);

  const md = renderReport({ ...run, started_at: "2026-10-11T12:00:00Z", machine: { chip: "Apple M2", ram_gb: 16, os: "macOS" }, ollama_version: "0.40.2", ollama_url: "http://localhost:11434", settings: { temperature: 0, seed: 42, think: false } }, requests);
  assert.match(md, /\| `gemma4:12b` \| 9B Q4_K_M \| 4\/5 \| 4\.00 s \| 0\.75 s \| 20\.0 tok\/s \| 3\.00 s \|/);
  assert.match(md, /failed `structured` \(schema:/);
});
