import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeTokenizer } from "../testing/fakes.js";
import { chunkFixed } from "./fixed.js";
import { chunkDocument } from "./index.js";
import { chunkStructural } from "./structural.js";

const words = (n, prefix = "w") => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");

function doc(paragraphs, { format = "markdown" } = {}) {
  // paragraphs: [{ path, text }] → one section per entry
  let text = "";
  const sections = [];
  for (const p of paragraphs) {
    const start = text ? text.length + 2 : 0;
    text = text ? `${text}\n\n${p.text}` : p.text;
    sections.push({ path: p.path, start, end: text.length });
  }
  return { doc_id: "d", source: "d.md", format, title: "D", text, sections };
}

test("fixed: size and overlap hold, words are never cut, the text is covered", () => {
  const d = doc([{ path: ["A"], text: words(500) }, { path: ["B"], text: words(230, "x") }]);
  const chunks = chunkFixed(d, fakeTokenizer, { size: 100, overlap: 20 });
  const textWords = d.text.split(/\s+/);
  for (const [i, c] of chunks.entries()) {
    assert.ok(c.token_count <= 100);
    assert.equal(c.text, d.text.slice(c.char_start, c.char_end));
    assert.ok(c.char_start === 0 || /\s/.test(d.text[c.char_start - 1]), "starts at a word start");
    assert.ok(c.char_end === d.text.length || /\s/.test(d.text[c.char_end]), "ends at a word end");
    if (i < chunks.length - 1) {
      assert.equal(c.token_count, 100);
      const next = chunks[i + 1];
      assert.equal(fakeTokenizer.count(d.text.slice(next.char_start, c.char_end)), 20, "overlap is 20 tokens");
    }
  }
  // Coverage: every word is in some chunk.
  const covered = new Set(chunks.flatMap((c) => c.text.split(/\s+/)));
  for (const w of textWords) assert.ok(covered.has(w), w);
  assert.equal(chunks[0].section, "A");
  assert.equal(chunks.at(-1).section, "B");
  assert.equal(chunks.at(-1).char_end, d.text.length);
});

test("structural: tiny sections merge forward, oversized ones split, all fit", () => {
  const d = doc([
    { path: ["Intro"], text: "Tiny." },
    { path: ["Intro", "Body"], text: words(60) },
    { path: ["Big"], text: [words(150, "a"), words(150, "b"), words(150, "c"), words(150, "d")].join("\n\n") },
    { path: ["Huge paragraph"], text: Array.from({ length: 30 }, (_, i) => `${words(20, `s${i}_`)}.`).join(" ") },
    { path: ["End"], text: "Bye now." },
  ]);
  const chunks = chunkStructural(d, fakeTokenizer, { minTokens: 40, maxTokens: 500 });
  for (const c of chunks) assert.ok(c.token_count <= 500, `${c.section}: ${c.token_count}`);

  const first = chunks[0];
  assert.equal(first.section, "Intro › Body", "the tiny section merged into the next and took its breadcrumb");
  assert.ok(first.text.startsWith("Tiny."));

  const big = chunks.filter((c) => c.section === "Big");
  assert.equal(big.length, 2, "600 tokens split at paragraph boundaries into two");
  for (const c of big) assert.ok(/^a0 |^c0 /.test(c.text), "each piece starts at a paragraph");

  const huge = chunks.filter((c) => c.section === "Huge paragraph");
  assert.ok(huge.length >= 2, "a 630-token paragraph is cut at sentences");
  for (const c of huge) assert.ok(c.text.endsWith("."), "…and only at sentence ends");

  const last = chunks.at(-1);
  assert.equal(last.section, "Huge paragraph", "a tiny last section merges backwards");
  assert.ok(last.text.endsWith("Bye now."));
});

test("structural: code splits at line boundaries", () => {
  const lines = Array.from({ length: 80 }, (_, i) => `  call${i}(${words(9, `a${i}_`)});`);
  const text = `function big() {\n${lines.join("\n")}\n}`;
  const d = { doc_id: "c", source: "c.js", format: "code", title: "c.js", text, sections: [{ path: ["big"], start: 0, end: text.length }] };
  const chunks = chunkStructural(d, fakeTokenizer, { minTokens: 40, maxTokens: 300 });
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    assert.ok(c.token_count <= 300);
    assert.ok(c.char_start === 0 || text[c.char_start - 1] === "\n" || /^\s*$/.test(text.slice(text.lastIndexOf("\n", c.char_start - 1) + 1, c.char_start)), "starts on a line");
    assert.equal(c.section, "big");
  }
});

test("chunk records: ids are stable and hashes cover the embedded string", () => {
  const d = doc([{ path: ["A"], text: words(700) }]);
  const config = { fixed: { size: 300, overlap: 50 }, structural: { minTokens: 40, maxTokens: 500 } };
  const a = chunkDocument(d, fakeTokenizer, "fixed", config);
  const b = chunkDocument(d, fakeTokenizer, "fixed", config);
  assert.deepEqual(a, b);
  assert.equal(a[0].chunk_id, "d:fixed:0");
  assert.equal(a[1].index, 1);
  const otherTitle = chunkDocument({ ...d, title: "E" }, fakeTokenizer, "fixed", config);
  assert.notEqual(otherTitle[0].content_hash, a[0].content_hash, "the title is part of the embedded string");
  assert.throws(() => chunkDocument(d, fakeTokenizer, "semantic", config), /unknown strategy/);
});
