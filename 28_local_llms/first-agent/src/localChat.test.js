import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "./app.js";
import { CLAUDE, createLlms } from "./llm/choice.js";
import { FakeProvider } from "./llm/anthropic.js";
import { fakeOllama } from "./testing/ollamaFake.js";
import { MemoryInvariantStore } from "./store/invariantStore.js";
import { MemoryStore } from "./store/memoryStore.js";
import { MemoryProfileStore } from "./store/profileStore.js";

/**
 * **Day 27 over HTTP: the real routes from `createApp`**, an in-memory store,
 * Ollama as a fake `fetch`, and a Claude provider that records every call. A
 * local chat must leave that record empty.
 */

/** A FakeProvider that counts: the "Claude" side of the app. */
class ClaudeSpy extends FakeProvider {
  calls = [];
  constructor() {
    super({ delayMs: 0 });
  }
  async complete(params) {
    this.calls.push(params);
    return super.complete(params);
  }
  async countTokens(params) {
    this.calls.push({ countTokens: true, ...params });
    return super.countTokens(params);
  }
}

async function serve(t, { claudeAvailable = true, env = { LOCAL_MODELS: "qwen3.5:9b,gemma4:12b" }, ollama = fakeOllama() } = {}) {
  const claude = new ClaudeSpy();
  const store = new MemoryStore();
  const llms = createLlms({ claude, claudeAvailable, env, fetch: ollama.fetch });
  const { app } = await createApp({
    env: {},
    llms,
    store,
    profileStore: new MemoryProfileStore(),
    invariantStore: new MemoryInvariantStore(),
    ragDeps: { search: async () => assert.fail("no retrieval in a local chat"), log: () => {} },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { claude, store, ollama, call };
}

const id = () => crypto.randomUUID();

test("a local first-agent chat: every call of the turn goes to Ollama, none to Claude", async (t) => {
  const { claude, store, ollama, call } = await serve(t);
  const sessionId = id();
  const res = await call("POST", "/chat", { message: "My name is Mira.", sessionId, agent: "first-agent", llm: "local:qwen3.5:9b" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.meta.provider, "local");
  assert.equal(res.body.meta.model, "qwen3.5:9b");
  assert.equal(res.body.meta.llm, "local:qwen3.5:9b");
  assert.equal(res.body.meta.localMetrics.genTps, 15);
  assert.ok(res.body.reply.length > 0);
  // The reply and the memory extractor: both local.
  assert.ok(ollama.chats().length >= 2, `expected the reply and the extractor, got ${ollama.chats().length} call(s)`);
  assert.ok(ollama.chats().every((body) => body.model === "qwen3.5:9b" && body.think === false));
  assert.deepEqual(claude.calls, []);

  const record = await store.load(sessionId);
  assert.equal(record.llm, "local:qwen3.5:9b");
  const reply = record.messages.at(-1);
  assert.equal(reply.provider, "local");
  assert.equal(reply.localMetrics.ttftMs, 1000);
});

test("the per-chat Model switch is stored and respected, and Claude chats stay on Claude", async (t) => {
  const { claude, ollama, call } = await serve(t);
  const sessionId = id();
  // A Claude turn first (the default with a key).
  let res = await call("POST", "/chat", { message: "hello", sessionId, agent: "first-agent" });
  assert.equal(res.status, 200);
  assert.equal(res.body.meta.llm, CLAUDE);
  assert.notEqual(res.body.meta.provider, "local");
  assert.ok(claude.calls.length > 0);
  assert.equal(ollama.chats().length, 0);

  // Switch the chat to gemma; the next turn names no model and still goes there.
  res = await call("PUT", `/conversations/${sessionId}/llm`, { llm: "local:gemma4:12b" });
  assert.deepEqual(res.body, { llm: "local:gemma4:12b", saved: true });
  assert.equal((await call("GET", `/conversations/${sessionId}`)).body.llm, "local:gemma4:12b");
  const before = claude.calls.length;
  res = await call("POST", "/chat", { message: "and now?", sessionId, agent: "first-agent" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.meta.provider, "local");
  assert.equal(res.body.meta.model, "gemma4:12b");
  assert.equal(claude.calls.length, before);
  assert.ok(ollama.chats().every((body) => body.model === "gemma4:12b"));

  // A brand-new chat is not saved by the switch; its first message carries it.
  const fresh = id();
  assert.deepEqual((await call("PUT", `/conversations/${fresh}/llm`, { llm: "local:qwen3.5:9b", agent: "first-agent" })).body, { llm: "local:qwen3.5:9b", saved: false });
});

test("a local chat's lifecycle calls (the invariant proposer) run locally too", async (t) => {
  const { claude, ollama, call } = await serve(t);
  const sessionId = id();
  await call("POST", "/chat", { message: "We use Postgres.", sessionId, agent: "first-agent", llm: "local:qwen3.5:9b" });
  const before = ollama.chats().length;
  const res = await call("POST", `/conversations/${sessionId}/memory/invariants/propose`, { text: "Never use MongoDB." });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(ollama.chats().length, before + 1);
  assert.deepEqual(claude.calls, []);
});

test("Knowledge: local is Without RAG only, and asking for RAG is a 400, not Claude", async (t) => {
  const { claude, ollama, call } = await serve(t);
  const sessionId = id();
  let res = await call("POST", "/chat", { message: "What is KMP?", sessionId, agent: "knowledge", llm: "local:qwen3.5:9b", ragMode: "rag" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /local \+ RAG: Day 28/);
  assert.equal(ollama.chats().length, 0);

  res = await call("POST", "/chat", { message: "What is KMP?", sessionId, agent: "knowledge", llm: "local:qwen3.5:9b", ragMode: "plain" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.meta.provider, "local");
  assert.equal(res.body.meta.rag.mode, "plain");
  assert.equal(ollama.chats().length, 1);
  assert.deepEqual(claude.calls, []);

  // The stored choice holds when the next message names no model or mode.
  res = await call("POST", "/chat", { message: "And Compose?", sessionId, agent: "knowledge" });
  assert.equal(res.status, 200);
  assert.equal(res.body.meta.provider, "local");
  assert.equal((await call("GET", `/conversations/${sessionId}`)).body.llm, "local:qwen3.5:9b");
  assert.deepEqual(claude.calls, []);
});

test("Claude-only agents refuse a local model and keep answering with Claude", async (t) => {
  const { claude, ollama, call } = await serve(t);
  const sessionId = id();
  let res = await call("POST", "/chat", { message: "arr?", sessionId, agent: "pirate-support", llm: "local:qwen3.5:9b" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Claude only/);
  res = await call("POST", "/chat", { message: "arr?", sessionId, agent: "pirate-support" });
  assert.equal(res.status, 200);
  assert.ok(claude.calls.length > 0);
  assert.equal(ollama.chats().length, 0);
});

test("without an API key: local is the default and Claude is refused for local-capable agents", async (t) => {
  const { claude, call } = await serve(t, { claudeAvailable: false });
  const status = (await call("GET", "/local/status")).body;
  assert.equal(status.claudeAvailable, false);
  assert.equal(status.defaultChoice, "local:qwen3.5:9b");
  let res = await call("POST", "/chat", { message: "hi", sessionId: id(), agent: "first-agent", llm: "claude" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /ANTHROPIC_API_KEY is not set/);
  res = await call("POST", "/chat", { message: "hi", sessionId: id(), agent: "first-agent" });
  assert.equal(res.status, 200);
  assert.equal(res.body.meta.provider, "local");
  assert.deepEqual(claude.calls, []);
});

test("Ollama down: the reply is a readable error, and nothing falls back to Claude", async (t) => {
  const down = { fetch: async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); }, chats: () => [] };
  const { claude, store, call } = await serve(t, { ollama: down });
  const sessionId = id();
  const res = await call("POST", "/chat", { message: "hi", sessionId, agent: "first-agent", llm: "local:qwen3.5:9b" });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /ollama serve/);
  assert.doesNotMatch(res.body.error, /\n\s+at /);
  assert.deepEqual(claude.calls, []);
  // No dangling user turn.
  assert.equal((await store.load(sessionId))?.messages.length ?? 0, 0);

  const status = (await call("GET", "/local/status")).body;
  assert.equal(status.reachable, false);
  assert.match(status.error, /ollama serve/);

  const knowledge = await call("POST", "/chat", { message: "hi", sessionId: id(), agent: "knowledge", llm: "local:qwen3.5:9b", ragMode: "plain" });
  assert.equal(knowledge.status, 500);
  assert.match(knowledge.body.error, /ollama serve/);
  assert.deepEqual(claude.calls, []);
});

test("the agent catalog says which agents may run locally", async (t) => {
  const { call } = await serve(t);
  const { agents } = (await call("GET", "/agents")).body;
  const local = Object.fromEntries(agents.map((a) => [a.id, a.local]));
  assert.deepEqual(local, { "first-agent": true, "pirate-support": false, "movie-buff": false, knowledge: true, pipeline: false });
});
