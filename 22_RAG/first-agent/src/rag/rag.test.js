import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FakeProvider } from "../llm/anthropic.js";
import { answerQuestion } from "./answer.js";
import { RAG_MAX_TOKENS, RAG_QUESTIONS_PATH, ragSettings } from "./config.js";
import { citationCheck, citedNumbers, ragOutcome, retrievalHit, summarize, validateQuestions, verdict, verifyAgainstIndex } from "./eval.js";
import { GRADE_TOOL, blind, judgeAnswer, parseGrade } from "./judge.js";
import { BASE_SYSTEM, RAG_SYSTEM, buildRagPrompt } from "./prompt.js";
import { RetrievalError, createRetriever, readableRetrievalError } from "./retriever.js";

/**
 * **The Knowledge agent's RAG path, offline.** A fake searcher stands in for
 * doc_index, so nothing here loads the embedding model or opens the index.
 */

const HITS = [
  { score: 0.71, source: "kb/a.html", section: "Intro", title: "Alpha", chunk_id: "a:structural:0", text: "Use List<Int> & \"quotes\" freely." },
  { score: 0.55, source: "kb/b.html", section: "Perf › iOS", title: "Beta", chunk_id: "b:structural:3", text: "It is 3.6 times faster." },
  { score: 0.31, source: "code/x.js", section: "", title: "x", chunk_id: "x:structural:1", text: "function x() {}" },
];

/** Records every search; returns the hits above. */
function fakeSearch(hits = HITS) {
  const calls = [];
  const search = async (question, options) => {
    calls.push({ question, options });
    return hits.slice(0, options.k);
  };
  return Object.assign(search, { calls });
}

/** A provider that records each call and answers with a fixed text. */
function recordingProvider(text = "ok [1]") {
  const calls = [];
  return {
    calls,
    model: "stub-model",
    async complete(params) {
      calls.push(params);
      return { text, content: [{ type: "text", text }], model: "stub-model", stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 10 } };
    },
  };
}

const quiet = () => {};

// ---- buildRagPrompt -------------------------------------------------------------

test("buildRagPrompt: numbered docs with their metadata, then the question", () => {
  const chunks = HITS.slice(0, 2).map((h, i) => ({ ...h, n: i + 1 }));
  const prompt = buildRagPrompt("How fast is it?", chunks);
  const lines = prompt.split("\n");
  assert.equal(lines[0], "<documents>");
  assert.match(prompt, /<doc n="1" source="kb\/a.html" section="Intro" title="Alpha">\n/);
  assert.match(prompt, /<doc n="2" source="kb\/b.html" section="Perf › iOS" title="Beta">\nIt is 3.6 times faster.\n<\/doc>/);
  assert.ok(prompt.indexOf('n="1"') < prompt.indexOf('n="2"'));
  assert.ok(prompt.endsWith("</documents>\n\nQuestion: How fast is it?"));
  assert.equal(buildRagPrompt("How fast is it?", chunks), prompt, "pure: same input, same string");
});

test("buildRagPrompt: chunk text is verbatim; only attributes and closing tags are escaped", () => {
  const prompt = buildRagPrompt("q", [
    { n: 1, source: 'a"b.html', section: "x < y & z", title: "T", text: 'Use List<Int> & "quotes" freely. if (a && b) {}' },
    { n: 2, source: "c", section: "", title: "", text: "a </doc> b </documents> c" },
  ]);
  assert.ok(prompt.includes('Use List<Int> & "quotes" freely. if (a && b) {}'), "code and quotes untouched");
  assert.ok(prompt.includes('source="a&quot;b.html" section="x &lt; y &amp; z"'));
  assert.ok(prompt.includes("a <\\/doc> b <\\/documents> c"));
  assert.equal(prompt.match(/<\/doc>/g).length, 2, "one closing tag per doc");
});

// ---- answerQuestion -------------------------------------------------------------

test("answerQuestion plain: never searches; neutral system prompt; question as the user message", async () => {
  const search = fakeSearch();
  const provider = recordingProvider("plain answer");
  const history = [{ role: "user", content: "earlier" }, { role: "assistant", content: "earlier reply" }];
  const out = await answerQuestion("What is KMP?", { mode: "plain", provider, search, history, log: quiet });
  assert.equal(search.calls.length, 0);
  assert.equal(out.mode, "plain");
  assert.deepEqual(out.chunks, []);
  assert.equal(out.answer, "plain answer");
  assert.equal(out.timings.retrieveMs, 0);
  const [call] = provider.calls;
  assert.equal(call.system, BASE_SYSTEM);
  assert.deepEqual(call.messages, [...history, { role: "user", content: "What is KMP?" }]);
  assert.equal(call.temperature, 0);
  assert.equal(call.maxTokens, RAG_MAX_TOKENS);
});

test("answerQuestion rag: searches the question alone, sends the chunks in the latest user message, returns them", async () => {
  const search = fakeSearch();
  const provider = recordingProvider();
  const history = [{ role: "user", content: "an older question about something else" }, { role: "assistant", content: "old" }];
  const out = await answerQuestion("How fast?", { mode: "rag", provider, search, history, k: 2, strategy: "structural", collections: ["knowledge"], minScore: null, log: quiet });

  assert.deepEqual(search.calls, [{ question: "How fast?", options: { k: 2, strategy: "structural", collections: ["knowledge"] } }]);
  assert.deepEqual(
    out.chunks.map(({ n, score, source, section, title, chunk_id, text }) => ({ n, score, source, section, title, chunk_id, text })),
    HITS.slice(0, 2).map(({ score, source, section, title, chunk_id, text }, i) => ({ n: i + 1, score, source, section, title, chunk_id, text })),
  );
  const [call] = provider.calls;
  assert.equal(call.system, RAG_SYSTEM);
  assert.ok(!call.system.includes("<doc "), "documents are not in the system prompt");
  assert.deepEqual(call.messages.slice(0, 2), history);
  assert.equal(call.messages.at(-1).content, buildRagPrompt("How fast?", out.chunks));
  assert.equal(call.temperature, 0);
  assert.equal(call.maxTokens, RAG_MAX_TOKENS, "same ceiling as plain");
  assert.equal(out.mode, "rag");
  assert.equal(out.usage.inputTokens, 100);
  assert.ok(out.timings.retrieveMs >= 0 && out.timings.llmMs >= 0);
});

test("answerQuestion rag: minScore drops low chunks and the rest are renumbered; scores are logged", async () => {
  const lines = [];
  const out = await answerQuestion("q", { mode: "rag", provider: recordingProvider(), search: fakeSearch(), k: 3, minScore: 0.5, log: (l) => lines.push(l) });
  assert.deepEqual(out.chunks.map((c) => [c.n, c.source]), [[1, "kb/a.html"], [2, "kb/b.html"]]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /0\.710 0\.550 0\.310 · minScore 0\.5 kept 2/);
});

test("answerQuestion with the FakeProvider: the reply shows whether documents were included", async () => {
  const provider = new FakeProvider({ delayMs: 0 });
  const rag = await answerQuestion("How fast?", { mode: "rag", provider, search: fakeSearch(), k: 2, log: quiet });
  assert.match(rag.answer, /with RAG\) I was given 2 documents/);
  assert.match(rag.answer, /\[1\] kb\/a\.html › Intro/);
  assert.match(rag.answer, /\[2\] kb\/b\.html › Perf › iOS/);
  const plain = await answerQuestion("How fast?", { mode: "plain", provider, search: fakeSearch(), log: quiet });
  assert.match(plain.answer, /without RAG\) No documents were included/);
  const none = await answerQuestion("How fast?", { mode: "rag", provider, search: fakeSearch([]), log: quiet });
  assert.match(none.answer, /do not cover it/);
});

test("answerQuestion: an unknown mode is refused", async () => {
  await assert.rejects(answerQuestion("q", { mode: "both", provider: recordingProvider(), search: fakeSearch(), log: quiet }), /mode must be/);
});

// ---- retrieval errors -----------------------------------------------------------

test("retrieval errors become one readable sentence", async () => {
  assert.match(readableRetrievalError(new Error("no index at /x/data/index.sqlite: run npm run index")), /index is missing\. Build it first: cd doc_index && npm run index$/);
  const mismatch = Object.assign(new Error("the index was built with different embedding settings (model a ≠ b); refusing to mix them. Run: npm run index -- --rebuild"), { name: "IndexMismatchError" });
  assert.equal(readableRetrievalError(mismatch), "The document index was built with a different embedding model (model a ≠ b). Rebuild it: cd doc_index && npm run index -- --rebuild");
  assert.match(readableRetrievalError(new Error('no "fixed" chunks in x: run npm run index')), /no "fixed" chunks/);
  assert.match(readableRetrievalError(Object.assign(new Error("Cannot find package 'better-sqlite3'"), { code: "ERR_MODULE_NOT_FOUND" })), /npm install/);

  // Whatever the searcher throws reaches the caller as a RetrievalError, and the model is never called.
  const provider = recordingProvider();
  const failing = async () => {
    throw new Error("boom\n    at stack line");
  };
  const err = await answerQuestion("q", { mode: "rag", provider, search: failing, log: quiet }).catch((e) => e);
  assert.ok(err instanceof RetrievalError);
  assert.equal(err.message, "Retrieval failed: boom");
  assert.equal(provider.calls.length, 0);
});

test("createRetriever: a missing index or doc_index folder is a RetrievalError, and is retried next time", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-retriever-"));
  const retriever = createRetriever({ dir, log: quiet });
  await assert.rejects(retriever.search("q", { k: 5, strategy: "structural" }), (err) => err instanceof RetrievalError && /not installed/.test(err.message));

  // A doc_index stand-in whose search() fails the way a missing index does.
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "search.js"), 'export async function search() { throw new Error("no index at /tmp/x.sqlite: run npm run index"); }\n');
  fs.writeFileSync(path.join(dir, "src", "config.js"), 'export const embedSettings = () => ({ modelId: "m", dtype: "q8", dims: 8 });\n');
  await assert.rejects(retriever.search("q", { k: 5, strategy: "structural" }), /index is missing/);
  assert.equal(retriever.ready(), false);
});

test("createRetriever: logs one line when the model is ready, then reuses it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-retriever-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "search.js"), 'export async function search(q, o) { return [{ score: 1, source: "s", text: q + o.k }]; }\n');
  fs.writeFileSync(path.join(dir, "src", "config.js"), 'export const embedSettings = () => ({ modelId: "m", dtype: "q8", dims: 8 });\n');
  const lines = [];
  const retriever = createRetriever({ dir, log: (l) => lines.push(l) });
  assert.deepEqual(await retriever.search("q", { k: 2, strategy: "structural" }), [{ score: 1, source: "s", text: "q2" }]);
  await retriever.search("q", { k: 2, strategy: "structural" });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[rag\] embedding model ready: m \(q8, 8 dims\) in \d+\.\d s$/);
  assert.equal(retriever.ready(), true);
});

test("ragSettings: defaults and validation", () => {
  assert.deepEqual(ragSettings({}), { k: 5, strategy: "structural", collections: [], minScore: null });
  assert.deepEqual(ragSettings({ RAG_K: "3", RAG_STRATEGY: "fixed", RAG_COLLECTIONS: "knowledge, downloads", RAG_MIN_SCORE: "0.4" }), {
    k: 3,
    strategy: "fixed",
    collections: ["knowledge", "downloads"],
    minScore: 0.4,
  });
  assert.throws(() => ragSettings({ RAG_K: "0" }), /RAG_K/);
  assert.throws(() => ragSettings({ RAG_STRATEGY: "semantic" }), /RAG_STRATEGY/);
  assert.throws(() => ragSettings({ RAG_MIN_SCORE: "high" }), /RAG_MIN_SCORE/);
});

// ---- the question file ------------------------------------------------------------

test("questions.json: 10 entries, 7 corpus / 2 general / 1 unanswerable, every field present", () => {
  const questions = JSON.parse(fs.readFileSync(RAG_QUESTIONS_PATH, "utf8"));
  assert.deepEqual(validateQuestions(questions), []);
  assert.equal(questions.length, 10);
  const count = (type) => questions.filter((q) => q.type === type).length;
  assert.deepEqual([count("corpus"), count("general"), count("unanswerable")], [7, 2, 1]);
  for (const q of questions) {
    for (const field of ["id", "type", "question", "expected_facts", "expected_sources", "notes"]) assert.ok(field in q, `${q.id}: ${field}`);
  }
  // The corpus questions are spread over different files.
  assert.equal(new Set(questions.filter((q) => q.type === "corpus").map((q) => q.expected_sources[0])).size, 7);
});

test("validateQuestions / verifyAgainstIndex fail loudly", () => {
  const good = { id: "x", type: "corpus", question: "q", expected_facts: ["a 1", "b 2"], evidence: ["one", "two"], expected_sources: ["s.html"], notes: "n" };
  const errors = validateQuestions([good, { ...good, id: "x", type: "unanswerable" }]);
  assert.ok(errors.some((e) => /exactly 10/.test(e)));
  assert.ok(errors.some((e) => /duplicate id/.test(e)));
  assert.ok(errors.some((e) => /unanswerable question has no expected sources/.test(e)));
  assert.ok(errors.some((e) => /expected 7 corpus/.test(e)));
  assert.ok(validateQuestions([{ ...good, expected_facts: ["only one"] }]).some((e) => /2–4/.test(e)));

  const docs = new Map([["s.html", "It has ONE\n  thing, and nothing else."]]);
  assert.deepEqual(verifyAgainstIndex([{ ...good, evidence: ["one thing", "nothing   else"] }], docs), []);
  const bad = verifyAgainstIndex([good, { ...good, id: "y", expected_sources: ["gone.html"] }], docs);
  assert.ok(bad.some((e) => /x: fact 2 .* evidence "two" is not in its sources/.test(e)));
  assert.ok(bad.some((e) => /y: expected source not in the index: gone.html/.test(e)));
});

// ---- the judge --------------------------------------------------------------------

test("parseGrade: the forced tool call becomes per-fact grades and a score", () => {
  const facts = ["a", "b", "c", "d"];
  const completion = {
    content: [
      { type: "text", text: "" },
      {
        type: "tool_use",
        name: "submit_grade",
        input: {
          facts: [
            { fact: "a", grade: "present" },
            { fact: "b", grade: "partial", note: "vague" },
            { fact: "c", grade: "contradicted" },
            { fact: "d", grade: "nonsense" },
          ],
          hallucination: true,
          hallucination_note: "made-up flag",
          declined: false,
        },
      },
    ],
  };
  const grade = parseGrade(completion, facts);
  assert.deepEqual(grade.facts.map((f) => f.grade), ["present", "partial", "contradicted", "missing"]);
  assert.equal(grade.score, (1 + 0.5) / 4);
  assert.equal(grade.hallucination, true);
  assert.equal(grade.hallucinationNote, "made-up flag");
  assert.equal(grade.declined, false);
  assert.equal(parseGrade({ content: [{ type: "tool_use", name: "submit_grade", input: { facts: [], hallucination: false, declined: true } }] }, ["a", "b"]).score, 0);
  assert.throws(() => parseGrade({ content: [{ type: "text", text: "I think…" }] }, facts), /did not call submit_grade/);
});

test("judgeAnswer: one forced call, temperature 0, blind to the mode", async () => {
  const calls = [];
  const provider = {
    async complete(params) {
      calls.push(params);
      return {
        text: "",
        content: [{ type: "tool_use", name: "submit_grade", input: { facts: [{ grade: "present" }, { grade: "missing" }], hallucination: false, declined: false } }],
        model: "judge",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const grade = await judgeAnswer({ provider, question: "Q?", type: "corpus", expectedFacts: ["a", "b"], answer: "It is 3.6x faster [1][2], see [3, 4]." });
  assert.equal(grade.score, 0.5);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].toolChoice, { name: GRADE_TOOL.name });
  assert.equal(calls[0].temperature, 0);
  const sent = calls[0].messages[0].content;
  assert.ok(sent.includes("It is 3.6x faster, see."));
  assert.ok(!/\brag\b|\bplain\b|\[1\]/i.test(sent), "no mode, no citation markers");
  assert.equal(blind("A [1]. B [2][3]."), "A. B.");
});

// ---- retrieval / citation checks and verdicts --------------------------------------

test("retrievalHit, citationCheck, ragOutcome, verdict", () => {
  const chunks = HITS.map((h, i) => ({ ...h, n: i + 1 }));
  assert.deepEqual(retrievalHit(chunks, ["kb/b.html"]), { hit: true, rank: 2 });
  assert.deepEqual(retrievalHit(chunks, ["kb/z.html"]), { hit: false, rank: null });
  assert.deepEqual(retrievalHit(chunks, []), { hit: null, rank: null });

  assert.deepEqual(citedNumbers("a [2] b [1][2] c [3, 7]"), [2, 1, 3, 7]);
  assert.deepEqual(citationCheck("a [2] b [7]", chunks, ["kb/b.html"]), { cited: [2, 7], invalid: [7], valid: false, citesExpected: true });
  assert.deepEqual(citationCheck("a [1]", chunks, ["kb/b.html"]), { cited: [1], invalid: [], valid: true, citesExpected: false });
  assert.equal(citationCheck("none", chunks, []).citesExpected, null);

  const corpus = { type: "corpus", expected_sources: ["kb/b.html"] };
  const good = { score: 1, hallucination: false, declined: false };
  const weak = { score: 0.25, hallucination: false, declined: false };
  assert.equal(ragOutcome(corpus, good, { hit: true }), "pass");
  assert.equal(ragOutcome(corpus, weak, { hit: true }), "generation miss");
  assert.equal(ragOutcome(corpus, weak, { hit: false }), "retrieval miss");
  assert.equal(ragOutcome(corpus, { ...good, hallucination: true }, { hit: true }), "generation miss");
  assert.equal(ragOutcome({ type: "unanswerable", expected_sources: [] }, { ...weak, declined: false }, { hit: null }), "not declined");
  assert.equal(ragOutcome({ type: "general", expected_sources: [] }, weak, { hit: null }), "not in corpus");

  assert.equal(verdict(corpus, weak, good), "RAG better (+0.75)");
  assert.equal(verdict(corpus, good, good), "same (+0.00)");
  assert.equal(verdict({ type: "unanswerable" }, { declined: false }, { declined: true }), "RAG better: declined, plain answered anyway");
});

test("summarize: means per mode, hit@k and miss counts", () => {
  const run = (score, extra = {}) => ({ grade: { score, hallucination: false, declined: false, ...extra }, timings: { retrieveMs: 10, llmMs: 990 }, usage: { inputTokens: 100, outputTokens: 50 } });
  const rows = [
    { type: "corpus", expected_sources: ["a"], plain: run(0), rag: { ...run(1), retrieval: { hit: true, rank: 1 }, citations: { valid: true, citesExpected: true }, outcome: "pass" } },
    { type: "corpus", expected_sources: ["b"], plain: run(0.5), rag: { ...run(0), retrieval: { hit: false, rank: null }, citations: { valid: true, citesExpected: false }, outcome: "retrieval miss" } },
    { type: "unanswerable", expected_sources: [], plain: run(0), rag: { ...run(1, { declined: true }), retrieval: { hit: null, rank: null }, citations: { valid: true, citesExpected: null }, outcome: "pass" } },
  ];
  const s = summarize(rows);
  assert.equal(s.plain.meanScore, 0.25);
  assert.equal(s.rag.meanScore, 0.5);
  assert.equal(s.rag.hits, 1);
  assert.equal(s.rag.withSources, 2);
  assert.equal(s.rag.unanswerableDeclined, 1);
  assert.equal(s.rag.outcomes["retrieval miss"], 1);
  assert.equal(s.plain.meanLatencyMs, 1000);
});
