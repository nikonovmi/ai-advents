import assert from "node:assert/strict";
import test from "node:test";

import { readableError } from "../app.js";
import { CLAUDE, createLlms, isLlmChoice, localChoice, localModelOf } from "./choice.js";
import { OllamaProvider, flatten, parseStructured, toOllamaMessages } from "./ollama.js";
import { LlmError } from "./provider.js";
import { fakeOllama, ollamaReply } from "../testing/ollamaFake.js";

/**
 * **The local provider, offline.** Ollama is a fake `fetch` that answers
 * `/api/chat` from a script and records every body it was sent.
 */

const provider = (fetch, settings = {}) => new OllamaProvider({ model: "qwen3.5:9b", fetch, settings: { numCtx: 4096, numPredict: 512, ...settings } });

test("message mapping: the system prompt becomes a system message and blocks become text", () => {
  const wire = toOllamaMessages("Be brief.", [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "get_movie", input: { title: "Heat" } }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "Heat (1995)" }, { type: "text", text: "and?" }] },
  ]);
  assert.deepEqual(wire, [
    { role: "system", content: "Be brief." },
    { role: "user", content: "hi" },
    { role: "assistant", content: 'Looking.\n[called get_movie with {"title":"Heat"}]' },
    { role: "user", content: "[tool result] Heat (1995)\nand?" },
  ]);
  assert.deepEqual(toOllamaMessages(undefined, [{ role: "user", content: "x" }]), [{ role: "user", content: "x" }]);
  assert.equal(flatten([{ type: "tool_result", content: "boom", isError: true }]), "[tool error] boom");
});

test("a call sends think:false, the context window and a capped num_predict, and returns the neutral shape", async () => {
  const ollama = fakeOllama(["  Hello, Mira!  "]);
  const result = await provider(ollama.fetch).complete({ system: "S", messages: [{ role: "user", content: "hi" }], temperature: 0.2, maxTokens: 4096 });
  const [body] = ollama.chats();
  assert.equal(body.model, "qwen3.5:9b");
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.deepEqual(body.options, { temperature: 0.2, num_predict: 512, num_ctx: 4096 });
  assert.equal(body.format, undefined);
  assert.equal(body.messages[0].role, "system");

  assert.equal(result.text, "Hello, Mira!");
  assert.deepEqual(result.content, [{ type: "text", text: "Hello, Mira!" }]);
  assert.equal(result.provider, "local");
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 30 });
});

test("metrics: TTFT, generation tok/s, latency and token counts from Ollama's timings", async () => {
  const ollama = fakeOllama([ollamaReply("x", { done_reason: "length" })]);
  const result = await provider(ollama.fetch).complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
  const m = result.metrics;
  assert.equal(m.ttftMs, 1000); // load 200 ms + prompt eval 800 ms
  assert.equal(m.genTps, 15); // 30 tokens / 2 s
  assert.equal(m.totalMs, 3000);
  assert.equal(m.loadMs, 200);
  assert.equal(m.promptTokens, 120);
  assert.equal(m.outputTokens, 30);
  assert.equal(typeof m.wallMs, "number");
  assert.equal(result.stopReason, "max_tokens");
  assert.equal(ollama.chats()[0].options.num_predict, 100);
});

test("a Claude model id is never sent to Ollama", async () => {
  const ollama = fakeOllama(["ok"]);
  await provider(ollama.fetch).complete({ messages: [{ role: "user", content: "hi" }], model: "claude-sonnet-5" });
  assert.equal(ollama.chats()[0].model, "qwen3.5:9b");
});

const ROUTE_TOOL = {
  name: "route",
  description: "Classify the message.",
  inputSchema: {
    type: "object",
    properties: { intent: { type: "string", enum: ["search", "chat"] }, queries: { type: "array", items: { type: "string" } } },
    required: ["intent", "queries"],
    additionalProperties: false,
  },
};

test("forced tool use becomes a JSON-schema format, validated, returned as a tool_use block", async () => {
  const ollama = fakeOllama(['{"intent":"search","queries":["kmp ktor"]}']);
  const result = await provider(ollama.fetch).complete({
    system: "Route it.",
    messages: [{ role: "user", content: "ktor?" }],
    tools: [ROUTE_TOOL],
    toolChoice: { name: "route" },
  });
  const [body] = ollama.chats();
  assert.deepEqual(body.format, ROUTE_TOOL.inputSchema);
  assert.match(body.messages[0].content, /^Route it\.\n\nReply with one JSON object: the input for "route"/);
  assert.equal(result.stopReason, "tool_use");
  assert.equal(result.attempts, 1);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "tool_use");
  assert.equal(result.content[0].name, "route");
  assert.deepEqual(result.content[0].input, { intent: "search", queries: ["kmp ktor"] });
});

test("an invalid JSON reply is retried once with the validation error, and the usage of both is counted", async () => {
  const ollama = fakeOllama(['{"intent":"maybe"}', '```json\n{"intent":"chat","queries":[]}\n```']);
  const result = await provider(ollama.fetch).complete({ messages: [{ role: "user", content: "hi" }], tools: [ROUTE_TOOL], toolChoice: { name: "route" } });
  const [, retry] = ollama.chats();
  assert.equal(ollama.chats().length, 2);
  assert.equal(retry.messages.at(-2).role, "assistant");
  assert.equal(retry.messages.at(-2).content, '{"intent":"maybe"}');
  assert.match(retry.messages.at(-1).content, /rejected: .*(intent|queries)/);
  assert.deepEqual(retry.format, ROUTE_TOOL.inputSchema);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.content[0].input, { intent: "chat", queries: [] });
  assert.deepEqual(result.usage, { inputTokens: 240, outputTokens: 60 });
});

test("two invalid replies are a readable error, not a guess", async () => {
  const ollama = fakeOllama(["not json", '{"intent":"search"}']);
  await assert.rejects(
    provider(ollama.fetch).complete({ messages: [{ role: "user", content: "hi" }], tools: [ROUTE_TOOL], toolChoice: { name: "route" } }),
    (err) => err instanceof LlmError && err.local && err.status === 422 && /didn't return valid JSON for route after one retry/.test(err.message),
  );
  assert.equal(ollama.chats().length, 2);
});

test("parseStructured: JSON, schema errors and fences", () => {
  assert.deepEqual(parseStructured('{"intent":"chat","queries":[]}', ROUTE_TOOL.inputSchema), { ok: true, value: { intent: "chat", queries: [] } });
  assert.equal(parseStructured("nope", ROUTE_TOOL.inputSchema).ok, false);
  assert.match(parseStructured('{"intent":"x","queries":[]}', ROUTE_TOOL.inputSchema).error, /equal to one of the allowed values/);
});

test("tools without a forced choice are refused: tool calling stays with Claude", async () => {
  const ollama = fakeOllama();
  await assert.rejects(provider(ollama.fetch).complete({ messages: [{ role: "user", content: "hi" }], tools: [ROUTE_TOOL] }), /Tool calling isn't supported for local models/);
  assert.equal(ollama.chats().length, 0);
});

test("readable errors: server down", async () => {
  const down = async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }) });
  };
  const err = await provider(down).complete({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
  assert.ok(err instanceof LlmError && err.local);
  assert.equal(err.status, 0); // not retried by completeWithRetry
  assert.equal(err.code, "unreachable");
  assert.match(err.message, /isn't reachable at http:\/\/localhost:11434 \(ECONNREFUSED\)/);
  assert.match(err.message, /ollama serve/);
  assert.equal(readableError(err), err.message);
  assert.doesNotMatch(readableError(err), /\n\s+at /);
});

test("readable errors: model not pulled", async () => {
  const ollama = fakeOllama([], { installed: ["gemma4:12b"] });
  const err = await provider(ollama.fetch).complete({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
  assert.equal(err.status, 404);
  assert.equal(err.code, "model_missing");
  assert.match(readableError(err), /ollama pull qwen3\.5:9b/);
});

test("readable errors: timeout", async () => {
  const slow = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  const err = await provider(slow, { timeoutMs: 180000 }).complete({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
  assert.equal(err.status, 408);
  assert.equal(err.code, "timeout");
  assert.match(readableError(err), /qwen3\.5:9b didn't finish within 180 s \(LOCAL_TIMEOUT_MS\)/);
});

test("choices: claude or local:<tag>, and nothing else", () => {
  assert.ok(isLlmChoice("claude"));
  assert.ok(isLlmChoice("local:qwen3.5:9b"));
  assert.ok(isLlmChoice("local:gemma4:12b"));
  for (const bad of ["", "local:", "gpt-4", "local:../../etc", "local:a b", 5, null]) assert.equal(isLlmChoice(bad), false, String(bad));
  assert.equal(localModelOf(localChoice("gemma4:12b")), "gemma4:12b");
  assert.equal(localModelOf(CLAUDE), null);
});

test("createLlms: defaults from what is installed, Claude off without a key, status for a down server", async () => {
  const claude = { complete: async () => assert.fail("Claude must not be called") };
  const ollama = fakeOllama([], { installed: ["llama3:8b", "qwen3.5:9b", "gemma4:12b", "qwen3.5:27b"], loaded: ["qwen3.5:9b"] });
  const keyless = createLlms({ claude, claudeAvailable: false, env: {}, fetch: ollama.fetch });
  assert.deepEqual(await keyless.localModels(), ["gemma4:12b", "qwen3.5:9b"]);
  assert.equal(await keyless.defaultChoice(), "local:gemma4:12b");
  const status = await keyless.status();
  assert.equal(status.reachable, true);
  assert.equal(status.version, "0.40.2");
  assert.deepEqual(status.loaded, ["qwen3.5:9b"]);
  assert.deepEqual(status.models, [
    { name: "gemma4:12b", installed: true, loaded: false },
    { name: "qwen3.5:9b", installed: true, loaded: true },
  ]);
  assert.equal(status.claudeAvailable, false);

  const keyed = createLlms({ claude, claudeAvailable: true, env: { LOCAL_MODELS: "qwen3.5:9b" }, fetch: ollama.fetch });
  assert.equal(await keyed.defaultChoice(), CLAUDE);
  assert.equal(keyed.providerFor(CLAUDE), claude);
  assert.equal(keyed.providerFor("local:qwen3.5:9b").model, "qwen3.5:9b");
  assert.equal(keyed.providerFor("local:qwen3.5:9b"), keyed.providerFor("local:qwen3.5:9b"));
  const pinned = createLlms({ claude, claudeAvailable: true, env: { LOCAL_DEFAULT_MODEL: "qwen3.5:9b" }, fetch: ollama.fetch });
  assert.equal(await pinned.defaultChoice(), "local:qwen3.5:9b");

  const down = createLlms({ claude, claudeAvailable: true, env: {}, fetch: async () => { throw new TypeError("fetch failed"); } });
  const downStatus = await down.status();
  assert.equal(downStatus.reachable, false);
  assert.match(downStatus.error, /ollama serve/);
});
