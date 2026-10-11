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

async function serve(t, { claudeAvailable = true, env = { LOCAL_MODELS: "qwen3.5:9b,gemma4:12b" }, ollama = fakeOllama(), ragDeps } = {}) {
  const claude = new ClaudeSpy();
  const store = new MemoryStore();
  const llms = createLlms({ claude, claudeAvailable, env, fetch: ollama.fetch });
  const { app } = await createApp({
    env: {},
    llms,
    store,
    profileStore: new MemoryProfileStore(),
    invariantStore: new MemoryInvariantStore(),
    ragDeps: ragDeps ?? { search: async () => assert.fail("no retrieval in a local chat"), log: () => {} },
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

const KB = [
  { score: 0.8, source: "kb/cmp.html", section: "iOS", title: "CMP 1.8", chunk_id: "cmp:3", text: "Compose Multiplatform for iOS is stable as of version 1.8.0. Teams can now ship shared UI to production." },
  { score: 0.6, source: "kb/ktor.html", section: "", title: "Ktor", chunk_id: "ktor:0", text: "Ktor 3 moves to kotlinx-io for its byte channels. The migration guide lists every renamed API." },
];
/** Ollama answering each JSON-schema call by its schema: the router searches, the answer cites cmp:3. */
const ragReply = (body) => {
  const props = body.format?.properties ?? {};
  if ("intent" in props) {
    const message = /New message:\n([\s\S]*)$/.exec(body.messages.at(-1).content)?.[1] ?? "";
    return JSON.stringify({ intent: "search", standalone_question: message, queries: [message], reply: "", memory_patch: [{ op: "add_constraint", text: "'CMP' = Compose Multiplatform" }] });
  }
  if ("citations" in props) {
    return JSON.stringify({ status: "answered", answer: "It is stable since 1.8.0 [c1].", citations: [{ id: "c1", chunk_id: "cmp:3", quote: "Compose Multiplatform for iOS is stable as of version 1.8.0." }], clarifying_question: "" });
  }
  if ("clarifying_question" in props) return JSON.stringify({ clarifying_question: "Which Kotlin topic do you mean?" });
  return "plain local answer";
};
const ragDeps = (counter = { searches: 0 }) => ({
  search: async () => {
    counter.searches += 1;
    return KB.map((c) => ({ ...c }));
  },
  rerankScores: async (_q, passages) => passages.map(() => 0.9),
  log: () => {},
});

test("Knowledge with RAG on a local model: router, answer and verification all local, nothing to Claude (Day 28)", async (t) => {
  const ollama = fakeOllama(Array.from({ length: 12 }, () => ragReply));
  const { claude, store, call } = await serve(t, { ollama, ragDeps: ragDeps(), env: { LOCAL_MODELS: "qwen3.5:9b,gemma4:12b", LOCAL_RAG_NUM_CTX: "12288" } });
  const sessionId = id();
  let res = await call("POST", "/chat", { message: "Is CMP for iOS stable?", sessionId, agent: "knowledge", llm: "local:qwen3.5:9b", ragMode: "rag", rerank: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.meta.provider, "local");
  assert.equal(res.body.meta.model, "qwen3.5:9b");
  assert.equal(res.body.meta.rag.mode, "rag");
  assert.equal(res.body.meta.rag.label, "rag+rerank");
  assert.equal(res.body.meta.rag.status, "answered");
  assert.equal(res.body.meta.rag.verification.firstAttemptValid, true);
  assert.equal(res.body.meta.rag.citations[0].chunk_id, "cmp:3");
  assert.equal(res.body.meta.route.routerProvider, "local");
  assert.ok(res.body.meta.localMetrics.ttftMs > 0);
  // Two calls (router + answer), both JSON-schema, both with the RAG window.
  assert.equal(ollama.chats().length, 2);
  assert.ok(ollama.chats().every((b) => b.model === "qwen3.5:9b" && b.format && b.options.num_ctx === 12288));
  assert.deepEqual(claude.calls, []);

  // The follow-up names no model or mode: the stored ones hold, and the term the router stored is in the memory.
  res = await call("POST", "/chat", { message: "And Ktor?", sessionId, agent: "knowledge" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.meta.provider, "local");
  assert.equal(res.body.meta.rag.mode, "rag");
  assert.match(ollama.chats().at(-1).messages.at(-1).content, /'CMP' = Compose Multiplatform/);
  assert.deepEqual(claude.calls, []);
  const record = await store.load(sessionId);
  assert.equal(record.llm, "local:qwen3.5:9b");
  assert.equal(record.ragMode, "rag");
  assert.ok(record.messages.filter((m) => m.role === "assistant").every((m) => m.provider === "local"));
});

test("Knowledge with RAG, Ollama down: a readable error, and no Claude answer in its place", async (t) => {
  const down = { fetch: async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); }, chats: () => [] };
  const { claude, store, call } = await serve(t, { ollama: down, ragDeps: ragDeps() });
  const sessionId = id();
  const res = await call("POST", "/chat", { message: "Is CMP for iOS stable?", sessionId, agent: "knowledge", llm: "local:qwen3.5:9b", ragMode: "rag" });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /ollama serve/);
  assert.deepEqual(claude.calls, []);
  assert.equal((await store.load(sessionId))?.messages.length ?? 0, 0);
});

test("Knowledge Without RAG on a local model still works as on Day 27", async (t) => {
  const { claude, ollama, call } = await serve(t);
  const res = await call("POST", "/chat", { message: "What is KMP?", sessionId: id(), agent: "knowledge", llm: "local:qwen3.5:9b", ragMode: "plain" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.meta.provider, "local");
  assert.equal(res.body.meta.rag.mode, "plain");
  assert.equal(ollama.chats().length, 1);
  assert.equal(ollama.chats()[0].format, undefined);
  assert.deepEqual(claude.calls, []);
});

test("Compare, Claude vs local: one retrieval, both answer from the same chunks", async (t) => {
  const counter = { searches: 0 };
  const ollama = fakeOllama(Array.from({ length: 4 }, () => ragReply));
  const { claude, call } = await serve(t, { ollama, ragDeps: ragDeps(counter) });
  const res = await call("POST", "/rag/compare", { question: "Is CMP for iOS stable?", versus: "models", llm: "local:qwen3.5:9b", rerank: true, rewrite: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(counter.searches, 1, "retrieval ran once");
  assert.equal(res.body.local.provider, "local");
  assert.equal(res.body.local.status, "answered");
  assert.equal(res.body.claude.provider, "fake");
  assert.equal(res.body.claude.rewrite, false, "no Rewrite stage in a Claude vs local comparison");
  assert.deepEqual(res.body.local.chunks.map((c) => c.chunk_id), res.body.claude.chunks.map((c) => c.chunk_id));
  // Claude's prompt carried the same chunk ids as the local one.
  const claudePrompt = String(claude.calls.at(-1).messages.at(-1).content);
  for (const chunk of res.body.local.chunks) assert.match(claudePrompt, new RegExp(`chunk_id="${chunk.chunk_id}"`));
  for (const side of [res.body.claude, res.body.local]) {
    assert.equal(typeof side.compareTimings.retrieveMs, "number");
    assert.equal(typeof side.compareTimings.rerankMs, "number");
    assert.equal(typeof side.compareTimings.totalMs, "number");
  }
  assert.equal(res.body.local.compareTimings.ttftMs, 1000);
  assert.equal(res.body.local.compareTimings.generationMs, 2000);
});

test("Compare, Claude vs local with the local model failing: that side is an error, never Claude's answer", async (t) => {
  const ollama = fakeOllama([], { installed: ["gemma4:12b"] });
  const { call } = await serve(t, { ollama, ragDeps: ragDeps() });
  const res = await call("POST", "/rag/compare", { question: "Is CMP for iOS stable?", versus: "models", llm: "local:qwen3.5:9b", rerank: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.local.error, /ollama pull qwen3\.5:9b/);
  assert.equal(res.body.local.answer, undefined);
  assert.equal(res.body.claude.status, "answered");
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
