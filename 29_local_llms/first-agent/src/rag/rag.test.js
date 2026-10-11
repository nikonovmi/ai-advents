import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FakeProvider } from "../llm/anthropic.js";
import { REJECTED_SHOWN, answerQuestion, mergeHits, modeLabel, parseModeLabel } from "./answer.js";
import { DEFAULT_RERANK_THRESHOLD, RAG_CONTRACT_MAX_TOKENS, RAG_MAX_TOKENS, RAG_QUESTIONS_PATH, ragSettings } from "./config.js";
import { DECLINE_TYPES, QUESTION_TYPES, citationCheck, citedNumbers, outcome, rankMove, renderReport, retrievalHit, retrievalStats, summarize, summaryRows, validateQuestions, verifyAgainstIndex } from "./eval.js";
import { GRADE_TOOL, blind, judgeAnswer, parseGrade } from "./judge.js";
import { BASE_SYSTEM, RAG_SYSTEM, buildRagPrompt } from "./prompt.js";
import { createReranker } from "./reranker.js";
import { REWRITE_TOOL, parseQueries, rewriteQuery } from "./rewrite.js";
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

/**
 * A provider that records each call and answers with a fixed text, or, when a
 * tool is forced, in that tool's shape: `submit_answer` quotes document 1 whole
 * (so it verifies), `submit_clarification` asks a fixed question.
 */
function recordingProvider(text = "ok [1]") {
  const calls = [];
  const usage = { inputTokens: 100, outputTokens: 10 };
  const use = (name, input) => ({ text: "", content: [{ type: "tool_use", id: `toolu_${calls.length}`, name, input }], model: "stub-model", stopReason: "tool_use", usage });
  return {
    calls,
    model: "stub-model",
    async complete(params) {
      calls.push(params);
      if (params.toolChoice?.name === "submit_answer") {
        const doc = /<doc n="1" chunk_id="([^"]*)"[^>]*>\n([\s\S]*?)\n<\/doc>/.exec(params.messages.at(-1).content);
        return use("submit_answer", doc ? { status: "answered", answer: "ok [c1]", citations: [{ id: "c1", chunk_id: doc[1], quote: doc[2] }] } : { status: "dont_know", answer: "", citations: [], clarifying_question: "Which one?" });
      }
      if (params.toolChoice?.name === "submit_clarification") return use("submit_clarification", { clarifying_question: "Did you mean X or Y?" });
      return { text, content: [{ type: "text", text }], model: "stub-model", stopReason: "end_turn", usage };
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
  assert.match(prompt, /<doc n="1" chunk_id="a:structural:0" source="kb\/a.html" section="Intro" title="Alpha">\n/);
  assert.match(prompt, /<doc n="2" chunk_id="b:structural:3" source="kb\/b.html" section="Perf › iOS" title="Beta">\nIt is 3.6 times faster.\n<\/doc>/);
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
  const out = await answerQuestion("How fast?", { mode: "rag", provider, search, history, kFinal: 2, strategy: "structural", collections: ["knowledge"], minScore: null, log: quiet });

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
  assert.equal(call.maxTokens, RAG_CONTRACT_MAX_TOKENS, "room for the quotes and chunk_ids");
  assert.deepEqual(call.toolChoice, { name: "submit_answer" });
  assert.equal(out.answer, "ok [c1]");
  assert.deepEqual(out.sources.map((s) => s.chunk_id), ["a:structural:0"]);
  assert.equal(out.mode, "rag");
  assert.equal(out.usage.inputTokens, 100);
  assert.ok(out.timings.retrieveMs >= 0 && out.timings.llmMs >= 0);
});

test("answerQuestion rag: minScore drops low chunks and the rest are renumbered; scores are logged", async () => {
  const lines = [];
  const out = await answerQuestion("q", { mode: "rag", provider: recordingProvider(), search: fakeSearch(), kFinal: 3, minScore: 0.5, log: (l) => lines.push(l) });
  assert.deepEqual(out.chunks.map((c) => [c.n, c.source]), [[1, "kb/a.html"], [2, "kb/b.html"]]);
  assert.equal(lines.length, 2, "the scores, then the contract's outcome");
  assert.match(lines[0], /0\.710 0\.550 0\.310 · minScore 0\.5 kept 2/);
  assert.match(lines[1], /contract answered · 1 citation/);
});

test("answerQuestion with the FakeProvider: the reply shows whether documents were included", async () => {
  const provider = new FakeProvider({ delayMs: 0 });
  const rag = await answerQuestion("How fast?", { mode: "rag", provider, search: fakeSearch(), kFinal: 2, log: quiet });
  assert.match(rag.answer, /with RAG\) I was given 2 documents/);
  assert.match(rag.answer, /\[1\] kb\/a\.html › Intro/);
  assert.match(rag.answer, /\[2\] kb\/b\.html › Perf › iOS/);
  const plain = await answerQuestion("How fast?", { mode: "plain", provider, search: fakeSearch(), log: quiet });
  assert.match(plain.answer, /without RAG\) No documents were included/);
  assert.equal(rag.status, "answered");
  assert.equal(rag.verification.firstAttemptValid, true, "the fake's quotes are verbatim");
  assert.deepEqual(rag.citations.map((c) => c.chunk_id), ["a:structural:0", "b:structural:3"]);
  const none = await answerQuestion("How fast?", { mode: "rag", provider, search: fakeSearch([]), log: quiet });
  assert.match(none.answer, /^I don't know\./);
  assert.equal(none.dontKnow.reason, "model");
});

test("answerQuestion: an unknown mode is refused", async () => {
  await assert.rejects(answerQuestion("q", { mode: "both", provider: recordingProvider(), search: fakeSearch(), log: quiet }), /mode must be/);
});

// ---- Day 23: rerank, cutoff, rewrite ------------------------------------------------

/** Eight candidates, best vector score first. */
const POOL = Array.from({ length: 8 }, (_, i) => ({
  score: 0.8 - i * 0.05,
  source: `kb/${"abcdefgh"[i]}.html`,
  section: `S${i}`,
  title: `T${i}`,
  chunk_id: `c${i}`,
  text: `This is text ${i} here.`,
}));

/** A fake cross-encoder: a fixed 0–1 score per chunk text; records each call. */
function fakeRerank(byText) {
  const calls = [];
  const score = async (query, passages) => {
    calls.push({ query, passages });
    return passages.map((p) => byText[/text \d+/.exec(p)?.[0]] ?? 0);
  };
  return Object.assign(score, { calls });
}

test("modeLabel / parseModeLabel", () => {
  assert.equal(modeLabel({ mode: "plain", rerank: true }), "plain");
  assert.equal(modeLabel({ mode: "rag" }), "rag");
  assert.equal(modeLabel({ mode: "rag", rerank: true }), "rag+rerank");
  assert.equal(modeLabel({ mode: "rag", rerank: true, rewrite: true }), "rag+rewrite+rerank");
  assert.deepEqual(parseModeLabel("rag+rewrite+rerank"), { mode: "rag", rerank: true, rewrite: true });
  assert.deepEqual(parseModeLabel("plain"), { mode: "plain", rerank: false, rewrite: false });
  assert.equal(parseModeLabel("rag+rerank+rewrite"), null, "one spelling per mode");
  assert.equal(parseModeLabel("rag+magic"), null);
});

test("rerank: re-sorts the candidates, applies the cutoff, keeps at most kFinal", async () => {
  // Vector order c0…c7; the cross-encoder prefers c6, c2, c7, c0, c4; c1/c3/c5 fall under 0.3.
  const rerankScores = fakeRerank({ "text 6": 0.95, "text 2": 0.9, "text 7": 0.8, "text 0": 0.6, "text 4": 0.4, "text 1": 0.2, "text 3": 0.1, "text 5": 0.05 });
  const search = fakeSearch(POOL);
  const provider = recordingProvider();
  const out = await answerQuestion("Which one?", { mode: "rag", rerank: true, provider, search, rerankScores, kFinal: 3, kRetrieve: 8, rerankThreshold: 0.3, log: quiet });

  assert.deepEqual(search.calls[0].options.k, 8, "kRetrieve candidates");
  assert.deepEqual(rerankScores.calls, [{ query: "Which one?", passages: POOL.map((h) => h.text) }]);
  assert.deepEqual(out.chunks.map((c) => [c.n, c.chunk_id, c.rerankScore, c.score]), [[1, "c6", 0.95, POOL[6].score], [2, "c2", 0.9, POOL[2].score], [3, "c7", 0.8, POOL[7].score]]);
  assert.deepEqual(out.candidates.map((c) => c.chunk_id), ["c6", "c2", "c7", "c0", "c4", "c1", "c3", "c5"], "candidates in rerank order");
  assert.deepEqual(out.candidates.filter((c) => c.kept).map((c) => c.chunk_id), ["c6", "c2", "c7"]);
  assert.deepEqual(out.candidates[0], { chunk_id: "c6", source: "kb/g.html", section: "S6", vectorScore: POOL[6].score, rerankScore: 0.95, vectorRank: 7, rerankRank: 1, kept: true });
  assert.equal(out.declined, false);
  assert.equal(out.label, "rag+rerank");
  assert.equal(provider.calls[0].messages.at(-1).content, buildRagPrompt("Which one?", out.chunks));

  // A higher cutoff keeps fewer than kFinal.
  const strict = await answerQuestion("Which one?", { mode: "rag", rerank: true, provider: recordingProvider(), search: fakeSearch(POOL), rerankScores, kFinal: 3, kRetrieve: 8, rerankThreshold: 0.92, log: quiet });
  assert.deepEqual(strict.chunks.map((c) => c.chunk_id), ["c6"]);
});

test("low relevance: nothing passes the cutoff → the answering model is not called; one clarifying call; I don't know", async () => {
  const provider = recordingProvider();
  const rerankScores = fakeRerank({ "text 3": 0.04, "text 1": 0.03, "text 0": 0.02, "text 2": 0.01 });
  const out = await answerQuestion("Capital of France?", { mode: "rag", rerank: true, provider, search: fakeSearch(POOL), rerankScores, kFinal: 5, kRetrieve: 8, rerankThreshold: 0.1, log: quiet });
  assert.equal(provider.calls.length, 1, "only the clarifying call");
  const [call] = provider.calls;
  assert.deepEqual(call.toolChoice, { name: "submit_clarification" });
  assert.ok(!call.tools.some((t) => t.name === "submit_answer"), "the answering tool is never offered");
  assert.equal(call.temperature, 0);
  const sent = call.messages[0].content;
  assert.ok(sent.startsWith("Question: Capital of France?"));
  assert.ok(["T3 · section: S3", "T1 · section: S1", "T0 · section: S0"].every((x) => sent.includes(x)), "the top 3 rejected: title and section");
  assert.ok(sent.includes("This is text 3 here.") && !sent.includes("text 2 here"), "their text, only the top 3");
  assert.equal(out.declined, true);
  assert.equal(out.status, "dont_know");
  assert.deepEqual(out.dontKnow, { reason: "low_relevance" });
  assert.equal(out.clarifyingQuestion, "Did you mean X or Y?");
  assert.equal(out.answer, "I don't know. Did you mean X or Y?");
  assert.deepEqual(out.citations, []);
  assert.deepEqual(out.sources, []);
  assert.deepEqual(out.chunks, []);
  assert.equal(out.rejected.length, REJECTED_SHOWN);
  assert.deepEqual(out.rejected.map((c) => [c.chunk_id, c.rerankScore]), [["c3", 0.04], ["c1", 0.03], ["c0", 0.02]]);
  assert.ok(out.rejected.every((c) => c.text), "rejected chunks carry their text for display");
  assert.ok(out.candidates.every((c) => !c.kept));
  assert.deepEqual(out.usage, { inputTokens: 100, outputTokens: 10 }, "the clarifying call is counted");
  assert.deepEqual(out.usageByStage.llm, null);
  assert.equal(out.timings.llmMs, 0);
});

test("rerank off: the Day 22 baseline, unchanged — top kFinal by vector score, no reranker call", async () => {
  const rerankScores = fakeRerank({});
  const search = fakeSearch(POOL);
  const provider = recordingProvider();
  const out = await answerQuestion("Which one?", { mode: "rag", provider, search, rerankScores, kFinal: 5, kRetrieve: 20, rerankThreshold: 0.9, minScore: null, log: quiet });
  assert.equal(rerankScores.calls.length, 0);
  assert.deepEqual(search.calls, [{ question: "Which one?", options: { k: 5, strategy: "structural", collections: [] } }], "kFinal, not kRetrieve");
  // Exactly the chunk objects and the prompt Day 22 built.
  const day22 = POOL.slice(0, 5).map((hit, i) => ({ n: i + 1, score: hit.score, source: hit.source, section: hit.section, title: hit.title, chunk_id: hit.chunk_id, text: hit.text }));
  assert.deepEqual(out.chunks, day22);
  assert.equal(provider.calls[0].system, RAG_SYSTEM);
  assert.equal(provider.calls[0].messages.at(-1).content, buildRagPrompt("Which one?", day22));
  assert.deepEqual(out.queries, ["Which one?"]);
  assert.equal(out.label, "rag");
  assert.equal(out.declined, false);
  assert.ok(out.candidates.every((c) => c.rerankScore === null && c.kept));
});

test("rewrite: several queries, results merged without duplicate chunk_ids, the model still gets the original question", async () => {
  // Two queries whose hits overlap on c1 and c2 (with different scores).
  const byQuery = {
    "compose ios size": [{ ...POOL[1], score: 0.7 }, { ...POOL[2], score: 0.5 }, POOL[4]],
    "compose ios stable": [{ ...POOL[2], score: 0.66 }, { ...POOL[1], score: 0.4 }, POOL[6]],
  };
  const searched = [];
  const search = async (query, options) => {
    searched.push({ query, options });
    return (byQuery[query] ?? []).slice(0, options.k);
  };
  const rewriter = async (question) => ({ queries: Object.keys(byQuery), usage: { inputTokens: 40, outputTokens: 12 } });
  const provider = recordingProvider();
  const question = "so is compose on iOS ready and how big does it make my app??";
  const out = await answerQuestion(question, { mode: "rag", rewrite: true, provider, search, rewriter, kFinal: 5, log: quiet });

  assert.deepEqual(searched.map((s) => s.query), ["compose ios size", "compose ios stable"]);
  assert.deepEqual(out.queries, ["compose ios size", "compose ios stable"]);
  const ids = out.chunks.map((c) => c.chunk_id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate chunk_id");
  assert.deepEqual(out.chunks.map((c) => [c.chunk_id, c.score]), [["c1", 0.7], ["c2", 0.66], ["c4", POOL[4].score], ["c6", POOL[6].score]], "best score per chunk, best first");
  assert.deepEqual(out.candidates.map((c) => c.query), [0, 1, 0, 1], "which query found each one");
  const sent = provider.calls[0].messages.at(-1).content;
  assert.ok(sent.endsWith(`Question: ${question}`), "the original question, not a rewrite");
  assert.ok(!/Question: compose ios/.test(sent));
  assert.equal(out.label, "rag+rewrite");
  assert.deepEqual(out.usage, { inputTokens: 140, outputTokens: 22 }, "both calls counted");
  assert.deepEqual(out.usageByStage.rewrite, { inputTokens: 40, outputTokens: 12 });
});

test("rewrite + rerank: the reranker scores against the original question", async () => {
  const rerankScores = fakeRerank({ "text 0": 0.9, "text 1": 0.8 });
  const out = await answerQuestion("the original?", {
    mode: "rag",
    rewrite: true,
    rerank: true,
    provider: recordingProvider(),
    search: fakeSearch(POOL),
    rewriter: async () => ({ queries: ["q one", "q two"] }),
    rerankScores,
    kFinal: 5,
    kRetrieve: 3,
    rerankThreshold: 0.5,
    log: quiet,
  });
  assert.equal(rerankScores.calls.length, 1);
  assert.equal(rerankScores.calls[0].query, "the original?");
  assert.deepEqual(rerankScores.calls[0].passages, POOL.slice(0, 3).map((h) => h.text), "each chunk scored once though both queries found it");
  assert.equal(out.label, "rag+rewrite+rerank");
  assert.deepEqual(out.chunks.map((c) => c.chunk_id), ["c0", "c1"]);
});

test("plain mode ignores the rerank and rewrite switches", async () => {
  const rerankScores = fakeRerank({});
  let rewrites = 0;
  const out = await answerQuestion("q", { mode: "plain", rerank: true, rewrite: true, provider: recordingProvider(), search: fakeSearch(), rerankScores, rewriter: async () => (rewrites++, { queries: ["x"] }), log: quiet });
  assert.equal(out.label, "plain");
  assert.equal(rewrites + rerankScores.calls.length, 0);
});

test("mergeHits keeps each chunk once, with its best score", () => {
  const merged = mergeHits([[{ chunk_id: "a", score: 0.2 }, { chunk_id: "b", score: 0.9 }], [{ chunk_id: "a", score: 0.5 }]]);
  assert.deepEqual(merged, [{ chunk_id: "b", score: 0.9, queryIndex: 0 }, { chunk_id: "a", score: 0.5, queryIndex: 1 }]);
});

test("rewriteQuery: one forced submit_queries call at temperature 0; the queries are cleaned up", async () => {
  const provider = new FakeProvider({ delayMs: 0, script: [{ toolUse: [{ name: "submit_queries", input: { queries: [" Compose iOS  app size ", "compose ios app size", "Compose iOS stable", "fourth", "fifth"] } }] }] });
  const { queries } = await rewriteQuery("hey so how big…", { provider });
  assert.deepEqual(queries, ["Compose iOS app size", "Compose iOS stable", "fourth"]);
  assert.equal(provider.toolCalls.length, 1);
  assert.deepEqual(provider.toolCalls[0].toolChoice, { name: REWRITE_TOOL.name });
  assert.deepEqual(parseQueries({ content: [{ type: "text", text: "no tool" }] }, "orig"), ["orig"], "falls back to the question");
});

test("createReranker: a missing doc_index is a RetrievalError, and the model is never loaded by the tests", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-reranker-"));
  const reranker = createReranker({ dir, log: quiet });
  await assert.rejects(reranker.score("q", ["p"]), (err) => err instanceof RetrievalError && /npm install/.test(err.message));
  assert.equal(reranker.ready(), false);

  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "rerank.js"), 'export async function loadReranker() { return { modelId: "m", dtype: "q8", score: async (q, ps) => ps.map((p) => p.length / 10) }; }\n');
  const lines = [];
  const loaded = createReranker({ dir, log: (l) => lines.push(l) });
  assert.deepEqual(await loaded.score("q", ["ab", "abcd"]), [0.2, 0.4]);
  await loaded.score("q", ["x"]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[rag\] reranker ready: m \(q8\) in \d+\.\d s$/);
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
  assert.deepEqual(ragSettings({}), { kFinal: 5, kRetrieve: 20, rerankThreshold: DEFAULT_RERANK_THRESHOLD, strategy: "structural", collections: [], minScore: null });
  assert.deepEqual(
    ragSettings({ RAG_K_FINAL: "3", RAG_K_RETRIEVE: "30", RAG_RERANK_THRESHOLD: "0.2", RAG_STRATEGY: "fixed", RAG_COLLECTIONS: "knowledge, downloads", RAG_MIN_SCORE: "0.4" }),
    { kFinal: 3, kRetrieve: 30, rerankThreshold: 0.2, strategy: "fixed", collections: ["knowledge", "downloads"], minScore: 0.4 },
  );
  assert.equal(ragSettings({ RAG_K: "4" }).kFinal, 4, "Day 22's RAG_K still works");
  assert.throws(() => ragSettings({ RAG_K: "0" }), /RAG_K/);
  assert.throws(() => ragSettings({ RAG_K_FINAL: "8", RAG_K_RETRIEVE: "6" }), /at least RAG_K_FINAL/);
  assert.throws(() => ragSettings({ RAG_RERANK_THRESHOLD: "1.5" }), /RAG_RERANK_THRESHOLD/);
  assert.throws(() => ragSettings({ RAG_STRATEGY: "semantic" }), /RAG_STRATEGY/);
  assert.throws(() => ragSettings({ RAG_MIN_SCORE: "high" }), /RAG_MIN_SCORE/);
});

// ---- the question file ------------------------------------------------------------

test("questions.json: 17 entries — Day 22's 10 unchanged, Day 23's 6, Day 24's ambiguous one; 10 tagged citations", () => {
  const questions = JSON.parse(fs.readFileSync(RAG_QUESTIONS_PATH, "utf8"));
  assert.deepEqual(validateQuestions(questions), []);
  assert.equal(questions.length, 17);
  const count = (type) => questions.filter((q) => q.type === type).length;
  assert.deepEqual(
    ["corpus", "general", "unanswerable", "near_miss", "off_topic", "paraphrased", "messy", "multi_part", "ambiguous"].map(count),
    [7, 2, 1, 2, 1, 1, 1, 1, 1],
  );
  const set = questions.filter((q) => q.sets?.includes("citations"));
  assert.equal(set.length, 10);
  assert.deepEqual(set.filter((q) => q.expect_decline).map((q) => q.type).sort(), ["ambiguous", "off_topic", "unanswerable"]);
  const answerable = set.filter((q) => !q.expect_decline);
  assert.equal(answerable.length, 7);
  for (const type of ["corpus", "near_miss", "multi_part", "paraphrased", "messy"]) assert.ok(answerable.some((q) => q.type === type), type);
  assert.ok(new Set(answerable.flatMap((q) => q.expected_sources)).size >= 6, "spread across documents");
  assert.equal(questions.find((q) => q.type === "ambiguous").expect_decline, true);
  assert.deepEqual(questions.slice(0, 10).map((q) => q.id), ["q01", "q02", "q03", "q04", "q05", "q06", "q07", "q08", "q09", "q10"], "the regression set comes first");
  for (const q of questions) {
    for (const field of ["id", "type", "question", "expected_facts", "expected_sources", "notes"]) assert.ok(field in q, `${q.id}: ${field}`);
    assert.equal(q.expect_decline === true, DECLINE_TYPES.includes(q.type), `${q.id}: expect_decline only on unanswerable / off_topic / ambiguous`);
  }
  assert.deepEqual(questions.filter((q) => q.expect_decline).map((q) => q.type).sort(), ["ambiguous", "off_topic", "unanswerable"]);
  // The corpus questions are spread over different files; the multi-part one needs two.
  assert.equal(new Set(questions.filter((q) => q.type === "corpus").map((q) => q.expected_sources[0])).size, 7);
  assert.equal(new Set(questions.find((q) => q.type === "multi_part").expected_sources).size, 2);
});

test("validateQuestions / verifyAgainstIndex fail loudly", () => {
  const good = { id: "x", type: "corpus", question: "q", expected_facts: ["a 1", "b 2"], evidence: ["one", "two"], expected_sources: ["s.html"], notes: "n" };
  const errors = validateQuestions([good, { ...good, id: "x", type: "unanswerable" }]);
  assert.ok(errors.some((e) => /exactly 17/.test(e)));
  assert.ok(errors.some((e) => /set "citations": expected 10 questions, got 0/.test(e)));
  assert.ok(errors.some((e) => /expected 1 ambiguous/.test(e)));
  assert.ok(validateQuestions([{ ...good, sets: ["nope"] }]).some((e) => /x: sets must be an array of citations/.test(e)));
  assert.ok(validateQuestions([{ ...good, type: "ambiguous", expected_sources: [] }]).some((e) => /x: an ambiguous question needs expect_decline/.test(e)));
  assert.ok(errors.some((e) => /duplicate id/.test(e)));
  assert.ok(errors.some((e) => /unanswerable question has no expected sources/.test(e)));
  assert.ok(errors.some((e) => /unanswerable question needs expect_decline/.test(e)));
  assert.ok(errors.some((e) => /expected 7 corpus/.test(e)));
  assert.ok(errors.some((e) => /expected 2 near_miss/.test(e)));
  assert.ok(validateQuestions([{ ...good, expected_facts: ["only one"] }]).some((e) => /2–4/.test(e)));
  assert.ok(validateQuestions([{ ...good, type: "multi_part" }]).some((e) => /two different documents/.test(e)));
  assert.ok(validateQuestions([{ ...good, expect_decline: true }]).some((e) => /only unanswerable \/ off_topic \/ ambiguous/.test(e)));
  assert.ok(validateQuestions([{ ...good, type: "off_topic", expected_sources: [], expect_decline: true }]).every((e) => !e.startsWith("x:")));

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

test("retrievalHit, retrievalStats, citationCheck, outcome", () => {
  const chunks = HITS.map((h, i) => ({ ...h, n: i + 1 }));
  assert.deepEqual(retrievalHit(chunks, ["kb/b.html"]), { hit: true, rank: 2 });
  assert.deepEqual(retrievalHit(chunks, ["kb/z.html"]), { hit: false, rank: null });
  assert.deepEqual(retrievalHit(chunks, []), { hit: null, rank: null });

  // Before the rerank, b.html was 7th; after it, 2nd. One of two expected documents made it; 2 chunks are noise.
  const candidates = [{ source: "kb/a.html", vectorRank: 1 }, { source: "kb/b.html", vectorRank: 7 }, { source: "kb/c.html", vectorRank: 9 }];
  const stats = retrievalStats({ chunks, candidates }, ["kb/b.html", "kb/c.html"]);
  assert.deepEqual(stats, { hit: true, rank: 2, rankBefore: 7, sourcesFound: 1, sourcesExpected: 2, noise: 2 });
  assert.equal(rankMove(stats), "7 → 2");
  assert.equal(rankMove({ ...stats, rankBefore: 2 }), "2");
  assert.equal(rankMove({ ...stats, rank: null }), "7 → miss");
  assert.deepEqual(retrievalStats({ chunks, candidates }, []), { hit: null, rank: null, rankBefore: null, sourcesFound: null, sourcesExpected: 0, noise: null });
  assert.equal(rankMove(retrievalStats({ chunks, candidates }, [])), "—");

  assert.deepEqual(citedNumbers("a [2] b [1][2] c [3, 7]"), [2, 1, 3, 7]);
  assert.deepEqual(citationCheck("a [2] b [7]", chunks, ["kb/b.html"]), { cited: [2, 7], invalid: [7], valid: false, citesExpected: true });
  assert.deepEqual(citationCheck("a [1]", chunks, ["kb/b.html"]), { cited: [1], invalid: [], valid: true, citesExpected: false });
  assert.equal(citationCheck("none", chunks, []).citesExpected, null);

  const corpus = { type: "corpus", expected_sources: ["kb/b.html"] };
  const run = (grade, extra = {}) => ({ mode: "rag", declined: false, grade: { score: 1, hallucination: false, declined: false, ...grade }, retrieval: { hit: true }, ...extra });
  assert.equal(outcome(corpus, run({})), "pass");
  assert.equal(outcome(corpus, run({ score: 0.25 })), "generation miss");
  assert.equal(outcome(corpus, run({ score: 0.25 }, { retrieval: { hit: false } })), "retrieval miss");
  assert.equal(outcome(corpus, run({ hallucination: true })), "generation miss");
  assert.equal(outcome(corpus, run({ score: 0, declined: true }, { declined: true })), "wrong decline (cutoff)");
  assert.equal(outcome(corpus, run({ score: 0, declined: true })), "wrong decline (model)");
  assert.equal(outcome(corpus, run({ score: 0.25 }, { mode: "plain" })), "fail");
  const offTopic = { type: "off_topic", expected_sources: [], expect_decline: true };
  assert.equal(outcome(offTopic, run({ score: 0 }, { declined: true })), "pass", "a cutoff decline counts even before the judge reads it");
  assert.equal(outcome(offTopic, run({ score: 0, declined: true })), "pass");
  assert.equal(outcome(offTopic, run({ score: 0 })), "not declined");
  assert.equal(outcome({ type: "general", expected_sources: [] }, run({ score: 0.25 })), "not in corpus");
});

test("summarize: per-mode means, declines (right and wrong, by name), rank before → after, noise, cost per stage", () => {
  const run = (mode, score, extra = {}) => ({
    mode,
    declined: false,
    grade: { score, hallucination: false, declined: false, ...(extra.grade ?? {}) },
    timings: { rewriteMs: 0, retrieveMs: 10, rerankMs: 0, llmMs: 990, ...(extra.timings ?? {}) },
    usage: { inputTokens: 100, outputTokens: 50 },
    usageByStage: { rewrite: null, llm: { inputTokens: 100, outputTokens: 50 }, ...(extra.usageByStage ?? {}) },
    chunks: extra.chunks ?? [],
    retrieval: extra.retrieval,
    citations: { valid: true, citesExpected: true },
    ...(extra.declined ? { declined: true } : {}),
  });
  const two = [{ n: 1, score: 0.6, source: "a", section: "", text: "alpha" }, { n: 2, score: 0.5, source: "x", section: "", text: "x-ray" }];
  const rows = [
    {
      id: "q1", type: "corpus", expected_sources: ["a"],
      runs: {
        plain: run("plain", 0),
        rag: run("rag", 1, { chunks: two, retrieval: { hit: true, rank: 1, rankBefore: 1, noise: 1 } }),
        "rag+rerank": run("rag", 1, { chunks: [two[0]], retrieval: { hit: true, rank: 1, rankBefore: 3, noise: 0 }, timings: { rerankMs: 2000 } }),
      },
    },
    {
      id: "q2", type: "near_miss", expected_sources: ["b"],
      runs: {
        plain: run("plain", 0.5),
        rag: run("rag", 0, { chunks: two, retrieval: { hit: false, rank: null, rankBefore: null, noise: 2 } }),
        "rag+rerank": run("rag", 0, { declined: true, grade: { declined: true }, retrieval: { hit: false, rank: null, rankBefore: 9, noise: 0 }, timings: { llmMs: 0 } }),
      },
    },
    {
      id: "q3", type: "off_topic", expected_sources: [], expect_decline: true,
      runs: {
        plain: run("plain", 0),
        rag: run("rag", 0, { grade: { declined: true }, chunks: two, retrieval: { hit: null, rank: null, rankBefore: null, noise: null } }),
        "rag+rerank": run("rag", 0, { declined: true, retrieval: { hit: null, rank: null, rankBefore: null, noise: null } }),
      },
    },
  ];
  for (const row of rows) for (const r of Object.values(row.runs)) r.outcome = outcome(row, r);
  const s = summarize(rows, ["plain", "rag", "rag+rerank"]);
  assert.equal(s.answerable, 2);
  assert.equal(s.byMode.plain.meanScore, 0.25);
  assert.equal(s.byMode.plain.isRag, false);
  assert.equal(s.byMode.plain.hits, undefined, "no retrieval columns for plain");
  assert.equal(s.byMode.rag.meanScore, 0.5);
  assert.deepEqual([s.byMode.plain.correctDeclines, s.byMode.rag.correctDeclines, s.byMode["rag+rerank"].correctDeclines], [0, 1, 1]);
  assert.deepEqual(s.byMode["rag+rerank"].wrongDeclines, [{ id: "q2", type: "near_miss", by: "cutoff" }]);
  assert.deepEqual(s.byMode.rag.wrongDeclines, []);
  assert.equal(s.byMode.rag.hits, 1);
  assert.equal(s.byMode.rag.withSources, 2);
  assert.equal(s.byMode["rag+rerank"].meanRankBefore, 6);
  assert.equal(s.byMode["rag+rerank"].meanRank, 1);
  assert.equal(s.byMode.rag.meanNoise, 1.5);
  assert.equal(s.byMode["rag+rerank"].meanNoise, 0);
  assert.equal(s.byMode["rag+rerank"].latencyMs.rerank, 2000 / 3);
  assert.equal(s.byMode.plain.meanLatencyMs, 1000);
  assert.equal(s.byMode.rag.outcomes["retrieval miss"], 1);
  assert.equal(s.byMode["rag+rerank"].outcomes["wrong decline (cutoff)"], 1);

  // The report: modes as columns, every wrong decline named, one rank column per RAG mode.
  const table = summaryRows(s);
  assert.ok(table.every(([, values]) => values.length === 3));
  assert.match(table.find(([label]) => label.startsWith("wrong declines"))[1][2], /q2 \(cutoff\)/);
  const md = renderReport({ generatedAt: "now", settings: { model: "m", judgeModel: "j", maxTokens: 1, strategy: "structural", collections: [], minScore: null, kFinal: 5, kRetrieve: 20, rerankThreshold: 0.02 }, summary: s, rows: rows.map((r) => ({ ...r, question: r.id, notes: "n", expected_facts: [], runs: Object.fromEntries(Object.entries(r.runs).map(([m, x]) => [m, { ...x, answer: "a", queries: [], candidates: [], grade: { ...x.grade, facts: [] }, citations: { ...x.citations, cited: [], invalid: [] } }])) })) });
  assert.match(md, /^# RAG eval: 3 questions × 3 modes/);
  assert.match(md, /\| \| plain \| rag \| rag\+rerank \|/);
  assert.match(md, /\| rank rag \| rank rag\+rerank \|/);
  assert.match(md, /\| \[q1\]\(#q1\) \| corpus \| q1 \| 0\.00 \| 1\.00 \| 1\.00 \| 1 \| 3 → 1 \|/);
});
