import assert from "node:assert/strict";
import { test } from "node:test";

import { loadRequests } from "./bench.js";
import { finalNumber, isDecline, runCheck, validateSchema } from "./checks.js";

const byId = Object.fromEntries(loadRequests().map((r) => [r.id, r]));

test("simple: the answer must contain the expected word", () => {
  const { check } = byId.simple;
  assert.equal(runCheck("Canberra.", check).pass, true);
  assert.equal(runCheck("canberra", check).pass, true);
  assert.equal(runCheck("Sydney", check).pass, false);
});

test("reasoning: the final number, preferring an `Answer:` line", () => {
  const { check } = byId.reasoning;
  assert.equal(finalNumber("150 left, then 90, so 7 boxes with 6 left over.\nAnswer: 7"), 7);
  assert.equal(finalNumber("**Answer:** 7"), 7);
  assert.equal(finalNumber("1,250 cookies"), 1250);
  assert.equal(runCheck("240 × 5/8 = 150, 150 × 0.6 = 90, 90 / 12 = 7.5\nAnswer: 7", check).pass, true);
  assert.equal(runCheck("90 / 12 = 7.5, so 8 boxes", check).pass, false);
  assert.equal(runCheck("I can't tell", check).detail, "got no number, expected 7");
});

test("structured: valid JSON, valid against the schema, right values", () => {
  const { check } = byId.structured;
  const good = { order_id: "A-1043", customer: "Maria Lopez", date: "2026-03-14", product: "USB-C dock", quantity: 3, unit_price: 89.5, currency: "EUR", city: "Lisbon", express: true };
  assert.equal(runCheck(JSON.stringify(good), check).pass, true);
  assert.match(runCheck("{not json", check).detail, /invalid JSON/);
  assert.match(runCheck(JSON.stringify({ ...good, quantity: "3" }), check).detail, /\$\.quantity: expected integer, got string/);
  assert.match(runCheck(JSON.stringify({ ...good, date: "14/03/2026" }), check).detail, /does not match/);
  assert.match(runCheck(JSON.stringify({ ...good, quantity: 2 }), check).detail, /wrong values: quantity=2/);
  const { express, ...missing } = good;
  assert.match(runCheck(JSON.stringify(missing), check).detail, /\$\.express: missing/);
});

test("schema validator: integers, extra keys, enums", () => {
  const schema = { type: "object", properties: { n: { type: "integer" }, c: { type: "string", enum: ["EUR"] } }, required: ["n"], additionalProperties: false };
  assert.deepEqual(validateSchema({ n: 1, c: "EUR" }, schema), []);
  assert.deepEqual(validateSchema({ n: 1.5 }, schema), ["$.n: expected integer, got number"]);
  assert.deepEqual(validateSchema({ n: 1, x: 0 }, schema), ["$.x: not allowed"]);
  assert.deepEqual(validateSchema({ n: 1, c: "USD" }, schema), ['$.c: "USD" not in enum']);
});

test("grounded: answerable needs the fact and no decline", () => {
  const { check } = byId["grounded-answerable"];
  assert.equal(runCheck("It adds only about 9 MB compared to a native SwiftUI app.", check).pass, true);
  assert.equal(runCheck("~9MB.", check).pass, true);
  assert.equal(runCheck("It adds very little.", check).pass, false);
  assert.equal(runCheck("I don't know", check).detail, "declined an answerable question");
});

test("grounded: unanswerable must decline", () => {
  const { check } = byId["grounded-unanswerable"];
  assert.ok(isDecline("I don’t know."));
  assert.ok(isDecline("I do not know"));
  assert.equal(runCheck("I don't know", check).pass, true);
  assert.equal(runCheck("iOS 15 or later.", check).detail, "answered instead of declining");
});

test("the grounded passage is a real doc_index chunk", async () => {
  const fs = await import("node:fs");
  const { passage } = byId["grounded-answerable"];
  const chunks = new URL("../../doc_index/reports/chunks.structural.jsonl", import.meta.url);
  const line = fs.readFileSync(chunks, "utf8").split("\n").find((l) => l.includes(`"${passage.chunk_id}"`));
  assert.ok(line, "chunk not found in doc_index");
  assert.equal(JSON.parse(line).text, passage.text);
});
