import assert from "node:assert/strict";
import { test } from "node:test";

import { isHit, metricsFor } from "./evaluate.js";
import { endsMidSentence, percentile, startsMidSentence } from "./stats.js";

test("mid-sentence detection", () => {
  const text = "First sentence. Second one here\nnext line";
  assert.equal(startsMidSentence(text, 0), false);
  assert.equal(startsMidSentence(text, text.indexOf("Second")), false);
  assert.equal(startsMidSentence(text, text.indexOf("one")), true);
  assert.equal(startsMidSentence(text, text.indexOf("next")), false);
  assert.equal(endsMidSentence(text, text.indexOf(" Second"), "First sentence."), false);
  assert.equal(endsMidSentence(text, text.indexOf(" here"), "Second one"), true);
  assert.equal(endsMidSentence(text, text.indexOf("\nnext"), "Second one here"), false);
});

test("percentiles and metrics", () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([5], 50), 5);
  const m = metricsFor([1, 3, null, 2]);
  assert.equal(m.hit1, 0.25);
  assert.equal(m.hit3, 0.75);
  assert.ok(Math.abs(m.mrr - (1 + 1 / 3 + 1 / 2) / 4) < 1e-9);
});

test("a hit needs the source and the phrase, case and whitespace ignored", () => {
  const q = { expected_source: "knowledge_database/Page", expected_text: "Stable  in Kotlin" };
  assert.ok(isHit({ source: "knowledge_database/Page One.html", text: "… stable\nin kotlin …" }, q));
  assert.ok(!isHit({ source: "other.md", text: "stable in kotlin" }, q));
  assert.ok(!isHit({ source: "knowledge_database/Page.html", text: "stable kotlin" }, q));
});
