import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { formatDocument, formatQuery } from "./embed.js";
import { buildIndex } from "./indexer.js";
import { createSearcher } from "./search.js";
import { IndexMismatchError, openStore } from "./store.js";
import { fakeEmbedder } from "./testing/fakes.js";

const words = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`).join(" ");
const documents = [
  { doc_id: "a", collection: "knowledge", source: "a.md", format: "markdown", title: "Alpha", text: `Alpha\n\n${words(400, "a")}`, sections: [{ path: ["Alpha"], start: 0, end: 5 + 2 + words(400, "a").length }] },
  { doc_id: "b", collection: "projects", source: "b.md", format: "markdown", title: "Beta", text: words(120, "b"), sections: [{ path: [], start: 0, end: words(120, "b").length }] },
];
const config = { fixed: { size: 100, overlap: 20 }, structural: { minTokens: 10, maxTokens: 150 } };
const quiet = () => {};

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-index-"));
  return path.join(dir, "index.sqlite");
}

async function build(dbPath, embedder, opts = {}) {
  const store = openStore(dbPath);
  try {
    return await buildIndex({ documents, embedder, store, config, log: quiet, ...opts });
  } finally {
    store.close();
  }
}

test("embedder: prefixes are always applied, vectors are unit length and truncated", async () => {
  const e = fakeEmbedder({ dims: 8 });
  const [v] = await e.embedDocuments([{ title: "T", text: "hello" }]);
  const q = await e.embedQuery("hi");
  assert.deepEqual(e.calls, ["title: T | text: hello", "task: search result | query: hi"]);
  assert.equal(formatDocument({ title: "", text: "x" }), "title: none | text: x");
  assert.equal(formatQuery("x"), "task: search result | query: x");
  assert.equal(v.length, 8);
  assert.ok(Math.abs(v.reduce((s, x) => s + x * x, 0) - 1) < 1e-5);
  assert.ok(Math.abs(q.reduce((s, x) => s + x * x, 0) - 1) < 1e-5);
});

test("index: chunk ids are stable across runs, and the cache skips unchanged chunks", async () => {
  const dbPath = tmpDb();
  const e = fakeEmbedder();
  const first = await build(dbPath, e);
  assert.ok(first.fixed.embedded > 0 && first.structural.embedded > 0);
  const store = openStore(dbPath);
  const ids1 = store.chunks("fixed").map((c) => c.chunk_id);
  store.close();

  e.calls.length = 0;
  const second = await build(dbPath, e);
  assert.equal(e.calls.length, 0, "nothing re-embedded");
  assert.equal(second.fixed.embedded, 0);
  assert.equal(second.fixed.cached, first.fixed.chunks);
  const store2 = openStore(dbPath);
  assert.deepEqual(store2.chunks("fixed").map((c) => c.chunk_id), ids1);
  assert.equal(store2.chunksWithVectors("fixed").length, ids1.length, "every chunk has its vector");
  store2.close();

  // A different chunker config re-chunks; only new texts are embedded.
  const third = await build(dbPath, e, { config: { ...config, fixed: { size: 80, overlap: 20 } } });
  assert.ok(third.fixed.embedded > 0);
  assert.equal(third.structural.embedded, 0);
  const s3 = openStore(dbPath);
  assert.deepEqual(s3.getMeta("chunker").fixed, { size: 80, overlap: 20 });
  s3.close();
});

test("index: refuses to mix embedding settings unless rebuilt", async () => {
  const dbPath = tmpDb();
  await build(dbPath, fakeEmbedder({ dims: 16 }));
  await assert.rejects(build(dbPath, fakeEmbedder({ dims: 8 })), IndexMismatchError);
  await assert.rejects(build(dbPath, fakeEmbedder({ modelId: "other" })), /npm run index -- --rebuild/);
  const rebuilt = await build(dbPath, fakeEmbedder({ dims: 8 }), { rebuild: true });
  assert.ok(rebuilt.fixed.embedded > 0);
});

test("search: results come back in score order, with metadata", async () => {
  const dbPath = tmpDb();
  const e = fakeEmbedder();
  await build(dbPath, e);
  const searcher = createSearcher({ dbPath, embedder: e });
  for (const strategy of ["fixed", "structural"]) {
    const hits = await searcher.search("a5 a6 a7", { strategy, k: 4 });
    assert.equal(hits.length, 4);
    for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score);
    for (const h of hits) {
      assert.equal(h.strategy, strategy);
      assert.ok(typeof h.section === "string" && h.source && h.text && h.chunk_id);
    }
  }
  const all = await searcher.search("anything", { strategy: "fixed", k: 1000 });
  const store = openStore(dbPath);
  assert.equal(all.length, store.chunks("fixed").length);
  store.close();
  searcher.close();
});

test("search: refuses an index built with another model", async () => {
  const dbPath = tmpDb();
  await build(dbPath, fakeEmbedder({ modelId: "model-a" }));
  assert.throws(() => createSearcher({ dbPath, embedder: fakeEmbedder({ modelId: "model-b" }) }), IndexMismatchError);
  assert.throws(() => createSearcher({ dbPath, embedder: fakeEmbedder({ modelId: "model-a", dims: 8 }) }), /dims 16 ≠ 8/);
});

test("search: a collections filter keeps only chunks of those collections", async () => {
  const dbPath = tmpDb();
  const e = fakeEmbedder();
  await build(dbPath, e);
  const searcher = createSearcher({ dbPath, embedder: e });
  const all = await searcher.search("anything", { strategy: "structural", k: 1000 });
  assert.deepEqual(new Set(all.map((h) => h.collection)), new Set(["knowledge", "projects"]));

  const knowledge = await searcher.search("anything", { strategy: "structural", k: 1000, collections: ["knowledge"] });
  assert.ok(knowledge.length > 0 && knowledge.length < all.length);
  assert.ok(knowledge.every((h) => h.collection === "knowledge" && h.source === "a.md"));
  for (let i = 1; i < knowledge.length; i++) assert.ok(knowledge[i - 1].score >= knowledge[i].score);

  const top = await searcher.search("anything", { strategy: "fixed", k: 1, collections: ["projects"] });
  assert.equal(top.length, 1);
  assert.equal(top[0].source, "b.md");
  assert.deepEqual(await searcher.search("anything", { strategy: "fixed", collections: ["nope"] }), []);
  const fixedAll = await searcher.search("anything", { strategy: "fixed", k: 1000 });
  assert.equal((await searcher.search("anything", { strategy: "fixed", k: 1000, collections: [] })).length, fixedAll.length, "empty list means all");
  searcher.close();
});
