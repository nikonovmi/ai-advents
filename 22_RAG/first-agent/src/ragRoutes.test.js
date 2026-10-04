import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { FakeProvider } from "./llm/anthropic.js";
import { RetrievalError } from "./rag/retriever.js";
import { HISTORY_MESSAGES, ragRoutes } from "./ragRoutes.js";
import { MemoryStore } from "./store/memoryStore.js";

/**
 * **The Knowledge chat over HTTP**, with the FakeProvider and a fake searcher:
 * no key, no index, no embedding model.
 */

const SESSION = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const HITS = [
  { score: 0.7, source: "kb/a.html", section: "Intro", title: "A", chunk_id: "a:0", text: "alpha" },
  { score: 0.5, source: "kb/b.html", section: "", title: "B", chunk_id: "b:0", text: "beta" },
];

async function serve(t, { search, reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-reports-")) } = {}) {
  const store = new MemoryStore();
  const searches = [];
  const app = express();
  app.use(express.json());
  app.use(
    ragRoutes({
      store,
      provider: new FakeProvider({ delayMs: 0 }),
      settings: { k: 2, strategy: "structural", collections: [], minScore: null },
      search:
        search ??
        (async (question, options) => {
          searches.push({ question, options });
          return HITS.slice(0, options.k);
        }),
      reportsDir,
      ready: () => false,
    }),
  );
  app.use((req, res) => res.status(418).json({ passedOn: true }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { store, searches, call, reportsDir };
}

test("knowledge chat: RAG reply records its mode and chunks; plain reply has none and never searches", async (t) => {
  const { store, searches, call } = await serve(t);

  const rag = await call("POST", "/chat", { message: "How fast?", sessionId: SESSION, agent: "knowledge", ragMode: "rag" });
  assert.equal(rag.status, 200);
  assert.match(rag.body.reply, /I was given 2 documents/);
  assert.equal(rag.body.meta.rag.mode, "rag");
  assert.deepEqual(rag.body.meta.rag.chunks.map((c) => [c.n, c.source]), [[1, "kb/a.html"], [2, "kb/b.html"]]);
  assert.equal(searches.length, 1);

  const plain = await call("POST", "/chat", { message: "How fast?", sessionId: SESSION, agent: "knowledge", ragMode: "plain" });
  assert.match(plain.body.reply, /No documents were included/);
  assert.equal(plain.body.meta.rag.mode, "plain");
  assert.deepEqual(plain.body.meta.rag.chunks, []);
  assert.equal(searches.length, 1, "plain mode does not search");

  const record = await store.load(SESSION);
  assert.equal(record.agentId, "knowledge");
  assert.equal(record.ragMode, "plain", "the last mode used is the chat's mode");
  assert.deepEqual(record.messages.map((m) => [m.role, m.rag?.mode ?? null]), [["user", null], ["assistant", "rag"], ["user", null], ["assistant", "plain"]]);
  assert.equal(record.messages[1].rag.chunks[0].text, "alpha");
  assert.equal(record.usage.turnCount, 2);

  const loaded = await call("GET", `/conversations/${SESSION}`);
  assert.equal(loaded.body.kind, "knowledge");
  assert.equal(loaded.body.ragMode, "plain");
  assert.equal(loaded.body.messages[1].rag.chunks.length, 2);
});

test("knowledge chat: retrieval uses the question alone; history is short-term", async (t) => {
  const { store, searches, call } = await serve(t);
  for (let i = 0; i < 5; i++) await call("POST", "/chat", { message: `question ${i}`, sessionId: SESSION, agent: "knowledge", ragMode: "plain" });
  await call("POST", "/chat", { message: "the last one", sessionId: SESSION, agent: "knowledge", ragMode: "rag" });
  assert.deepEqual(searches.map((s) => s.question), ["the last one"]);
  assert.equal((await store.load(SESSION)).messages.length, 12);
  assert.equal(HISTORY_MESSAGES, 6);
});

test("knowledge chat: a retrieval failure is a readable 503 and nothing is stored", async (t) => {
  const { store, call } = await serve(t, {
    search: async () => {
      throw new RetrievalError("The document index is missing. Build it first: cd doc_index && npm run index");
    },
  });
  const res = await call("POST", "/chat", { message: "q", sessionId: SESSION, agent: "knowledge", ragMode: "rag" });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "The document index is missing. Build it first: cd doc_index && npm run index");
  assert.equal(await store.load(SESSION), null);
});

test("other agents' chats are passed on untouched", async (t) => {
  const { store, call } = await serve(t);
  assert.equal((await call("POST", "/chat", { message: "hi", sessionId: OTHER, agent: "first-agent" })).status, 418);
  assert.equal((await call("POST", "/chat", { message: "hi", sessionId: OTHER })).status, 418);
  await store.save(OTHER, [], undefined, { agentId: "first-agent" });
  assert.equal((await call("POST", "/chat", { message: "hi", sessionId: OTHER, agent: "knowledge" })).status, 418, "the record's agent wins");
  assert.equal((await call("GET", `/conversations/${OTHER}`)).status, 418);
});

test("the mode switch: kept by the page until the first message, then stored", async (t) => {
  const { store, call } = await serve(t);
  assert.deepEqual((await call("PUT", `/conversations/${SESSION}/rag`, { mode: "plain" })).body, { mode: "plain", saved: false });
  assert.equal(await store.load(SESSION), null);
  assert.equal((await call("PUT", `/conversations/${SESSION}/rag`, { mode: "both" })).status, 400);
  await call("POST", "/chat", { message: "q", sessionId: SESSION, agent: "knowledge", ragMode: "plain" });
  assert.deepEqual((await call("PUT", `/conversations/${SESSION}/rag`, { mode: "rag" })).body, { mode: "rag", saved: true });
  assert.equal((await store.load(SESSION)).ragMode, "rag");
  assert.equal((await call("POST", "/chat", { message: "q", sessionId: SESSION, ragMode: "x" })).status, 400);
});

test("compare: both modes, stored nowhere", async (t) => {
  const { store, call } = await serve(t);
  const res = await call("POST", "/rag/compare", { question: "How fast?" });
  assert.equal(res.status, 200);
  assert.equal(res.body.rag.chunks.length, 2);
  assert.deepEqual(res.body.plain.chunks, []);
  assert.match(res.body.plain.answer, /No documents/);
  assert.deepEqual(await store.listSessions(), []);
});

test("report data: null before the first eval, the files after", async (t) => {
  const { call, reportsDir } = await serve(t);
  assert.deepEqual((await call("GET", "/rag-report/data")).body, { results: null, notes: null });
  fs.writeFileSync(path.join(reportsDir, "rag_results.json"), JSON.stringify({ summary: { count: 10 } }));
  fs.writeFileSync(path.join(reportsDir, "rag_notes.md"), "**Findings.**");
  assert.deepEqual((await call("GET", "/rag-report/data")).body, { results: { summary: { count: 10 } }, notes: "**Findings.**" });
  const status = await call("GET", "/rag/status");
  assert.equal(status.body.k, 2);
  assert.equal(status.body.ready, false);
});
