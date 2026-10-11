import assert from "node:assert/strict";
import { test } from "node:test";

import { createOllama, deriveMetrics, OllamaError } from "./ollama.js";
import { chatResponse, fakeFetch, refusedFetch } from "./testing/fakes.js";

test("metrics come from Ollama's nanosecond fields", () => {
  const m = deriveMetrics(chatResponse("hi"));
  assert.equal(m.total_ms, 3000);
  assert.equal(m.load_ms, 500);
  assert.equal(m.prompt_eval_ms, 250);
  assert.equal(m.eval_ms, 2000);
  assert.equal(m.ttft_ms, 750); // load + prompt eval
  assert.equal(m.prompt_tps, 400); // 100 tokens / 0.25 s
  assert.equal(m.gen_tps, 20); // 40 tokens / 2 s
  assert.equal(m.gen_tokens, 40);
});

test("cached prompt tokens don't count toward prompt tok/s", () => {
  const m = deriveMetrics(chatResponse("hi", { prompt_eval_count: 300, prompt_eval_cached_count: 250 }));
  assert.equal(m.prompt_tps, 200); // 50 evaluated tokens / 0.25 s
  assert.equal(m.cached_prompt_tokens, 250);
});

test("missing or zero durations give null rates, not Infinity", () => {
  const m = deriveMetrics({ total_duration: 1e9, eval_count: 5, eval_duration: 0 });
  assert.equal(m.gen_tps, null);
  assert.equal(m.prompt_tps, null);
  assert.equal(m.ttft_ms, null);
  assert.equal(m.total_ms, 1000);
});

test("chat sends a non-streaming request with temperature 0 and think false by default", async () => {
  const fetch = fakeFetch({ "POST /api/chat": () => chatResponse("OK") });
  const ollama = createOllama({ url: "http://ollama.test:11434/", fetch });
  const res = await ollama.chat({ model: "fake:1b", messages: [{ role: "user", content: "Say OK" }], num_predict: 8, seed: 1, format: { type: "object" } });
  const { body } = fetch.calls[0];
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.deepEqual(body.options, { temperature: 0, seed: 1, num_predict: 8 });
  assert.deepEqual(body.format, { type: "object" });
  assert.equal(res.text, "OK");
  assert.equal(res.think, false);
  assert.equal(res.timings.eval_count, 40);
  assert.equal(res.metrics.gen_tps, 20);
  assert.ok(res.metrics.wall_ms >= 0);
});

test("version, list and unload hit the native endpoints", async () => {
  const fetch = fakeFetch({
    "GET /api/version": { version: "0.40.2" },
    "GET /api/tags": { models: [{ name: "qwen3.5:9b" }] },
    "POST /api/generate": {},
  });
  const ollama = createOllama({ fetch });
  assert.equal(await ollama.version(), "0.40.2");
  assert.deepEqual((await ollama.list()).map((m) => m.name), ["qwen3.5:9b"]);
  await ollama.unload("qwen3.5:9b");
  assert.deepEqual(fetch.calls.at(-1).body, { model: "qwen3.5:9b", keep_alive: 0 });
});

test("a server that's down gives a readable error with the fix", async () => {
  const ollama = createOllama({ url: "http://localhost:11434", fetch: refusedFetch });
  await assert.rejects(ollama.version(), (err) => {
    assert.ok(err instanceof OllamaError);
    assert.equal(err.code, "unreachable");
    assert.match(err.message, /isn't reachable at http:\/\/localhost:11434 \(ECONNREFUSED\)/);
    assert.match(err.message, /ollama serve/);
    return true;
  });
});

test("a missing model says which `ollama pull` to run", async () => {
  const fetch = fakeFetch({ "POST /api/chat": { status: 404, json: { error: "model 'gemma4:12b' not found" } } });
  const ollama = createOllama({ fetch });
  await assert.rejects(ollama.chat({ model: "gemma4:12b", messages: [] }), (err) => {
    assert.equal(err.code, "model_missing");
    assert.match(err.message, /ollama pull gemma4:12b/);
    return true;
  });
});
