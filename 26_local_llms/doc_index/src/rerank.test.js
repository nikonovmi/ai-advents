import assert from "node:assert/strict";
import test from "node:test";

import { createReranker, sigmoid } from "./rerank.js";

/** A fake cross-encoder (logit = passage length − 3): the real model is never loaded here. */
function fakeRaw() {
  const calls = [];
  const scoreRaw = async (query, passages) => {
    calls.push({ query, passages });
    return passages.map((p) => p.length - 3);
  };
  return Object.assign(scoreRaw, { calls });
}

test("createReranker: one sigmoid score per passage, in order, one pair per pass by default", async () => {
  const raw = fakeRaw();
  const reranker = createReranker({ modelId: "fake", dtype: "q8", scoreRaw: raw });
  const scores = await reranker.score("q", ["abc", "a", "abcdef"]);
  assert.deepEqual(scores, [0.5, sigmoid(-2), sigmoid(3)]);
  assert.ok(scores.every((s) => s > 0 && s < 1));
  assert.deepEqual(raw.calls.map((c) => c.passages), [["abc"], ["a"], ["abcdef"]], "batch size 1: a score never depends on its neighbours");
  assert.ok(raw.calls.every((c) => c.query === "q"));
  assert.deepEqual(await reranker.score("q", []), []);
});

test("createReranker: a larger batch keeps the order", async () => {
  const raw = fakeRaw();
  const reranker = createReranker({ modelId: "fake", dtype: "q8", scoreRaw: raw, batchSize: 2 });
  assert.deepEqual(await reranker.score("q", ["abc", "abcd", "ab"]), [0.5, sigmoid(1), sigmoid(-1)]);
  assert.deepEqual(raw.calls.map((c) => c.passages.length), [2, 1]);
});
