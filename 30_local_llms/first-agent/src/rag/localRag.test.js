import assert from "node:assert/strict";
import test from "node:test";

import { OllamaProvider } from "../llm/ollama.js";
import { fakeOllama, ollamaReply } from "../testing/ollamaFake.js";
import { answerQuestion } from "./answer.js";
import { runChatTurn } from "./chatTurn.js";
import { ANSWER_TOOL_NAME } from "./contract.js";
import { emptyMemory } from "./taskMemory.js";
import { loadRetrievals, retrievalKey, runGenerator, summarizeGenerator } from "./localEval.js";

/**
 * **Day 28: the Knowledge RAG path on a local model, offline.** Ollama is a
 * fake `fetch` that answers each JSON-schema call by looking at the schema it
 * was sent (`route`, `submit_answer`, `submit_clarification`); retrieval and
 * rerank are fakes.
 */

const CHUNKS = [
  { score: 0.8, source: "kb/cmp.html", section: "iOS", title: "CMP 1.8", chunk_id: "cmp:3", text: "Compose Multiplatform for iOS is stable as of version 1.8.0. Teams can now ship shared UI to production." },
  { score: 0.6, source: "kb/ktor.html", section: "", title: "Ktor", chunk_id: "ktor:0", text: "Ktor 3 moves to kotlinx-io for its byte channels. The migration guide lists every renamed API." },
];
const search = async () => CHUNKS.map((c) => ({ ...c }));
const rerankHigh = async (_q, passages) => passages.map(() => 0.9);
const rerankLow = async (_q, passages) => passages.map(() => 0.001);

const kind = (body) => {
  const props = body.format?.properties ?? {};
  if ("intent" in props) return "route";
  if ("citations" in props) return "answer";
  if ("clarifying_question" in props) return "clarify";
  return "text";
};
/** A fake Ollama whose replies are picked by the schema each call carries; each kind takes its replies in order. */
function ragOllama(replies) {
  const queues = Object.fromEntries(Object.entries(replies).map(([k, v]) => [k, [...v]]));
  return fakeOllama(
    Array.from({ length: 20 }, () => (body) => {
      const next = queues[kind(body)]?.shift();
      if (next === undefined) throw new Error(`no scripted reply left for ${kind(body)}`);
      return typeof next === "function" ? next(body) : typeof next === "string" ? next : JSON.stringify(next);
    }),
  );
}
const local = (ollama, settings = {}) => new OllamaProvider({ model: "qwen3.5:9b", fetch: ollama.fetch, settings: { numCtx: 16384, numPredict: 2048, ...settings }, log: () => {} });
const GOOD_ANSWER = {
  status: "answered",
  answer: "Compose Multiplatform for iOS is stable since 1.8.0 [c1].",
  citations: [{ id: "c1", chunk_id: "cmp:3", quote: "Compose Multiplatform for iOS is stable as of version 1.8.0." }],
  clarifying_question: "",
};
const ROUTE_SEARCH = { intent: "search", standalone_question: "Is Compose Multiplatform for iOS stable?", queries: ["Compose Multiplatform iOS stable"], reply: "", memory_patch: [] };
const silent = () => {};

test("a local RAG chat turn: route and submit_answer are JSON-schema calls to Ollama, verified like Claude's", async () => {
  const ollama = ragOllama({ route: [ROUTE_SEARCH], answer: [GOOD_ANSWER] });
  const turn = await runChatTurn({ message: "Is CMP for iOS stable?", messages: [], memory: emptyMemory(), turn: 1, provider: local(ollama), ragOptions: { search, rerankScores: rerankHigh, rerank: true }, log: silent });
  const [route, answer] = ollama.chats();
  assert.equal(ollama.chats().length, 2);
  assert.equal(route.format.properties.intent.type, "string");
  assert.deepEqual(answer.format.required, ["status", "answer", "citations"]);
  for (const body of ollama.chats()) {
    assert.equal(body.model, "qwen3.5:9b");
    assert.equal(body.options.num_ctx, 16384);
    assert.equal(body.think, false);
  }
  assert.equal(turn.route.intent, "search");
  assert.equal(turn.route.routerProvider, "local");
  assert.equal(turn.result.status, "answered");
  assert.equal(turn.result.provider, "local");
  assert.equal(turn.result.verification.firstAttemptValid, true);
  assert.equal(turn.result.citations[0].chunk_id, "cmp:3");
  assert.equal(turn.result.sources[0].source, "kb/cmp.html");
  assert.equal(turn.result.localMetrics.ttftMs, 1000);
  assert.equal(turn.result.generation.invalidJson, 0);
});

test("route: invalid JSON is retried once with the error, then the valid reply is used", async () => {
  const ollama = ragOllama({ route: ['{"intent": "search", "queries": "not a list"', ROUTE_SEARCH], answer: [GOOD_ANSWER] });
  const turn = await runChatTurn({ message: "Is CMP for iOS stable?", messages: [], memory: emptyMemory(), turn: 1, provider: local(ollama), ragOptions: { search, rerankScores: rerankHigh, rerank: true }, log: silent });
  const routes = ollama.chats().filter((b) => kind(b) === "route");
  assert.equal(routes.length, 2);
  assert.match(routes[1].messages.at(-1).content, /rejected: not valid JSON/);
  assert.equal(routes[1].messages.at(-1).role, "user");
  assert.equal(turn.route.standaloneQuestion, ROUTE_SEARCH.standalone_question);
  assert.deepEqual(turn.route.routerStructured, { tool: "route", attempts: 2, invalid: 1, errors: [turn.route.routerStructured.errors[0]] });
  assert.equal(turn.result.status, "answered");
});

test("route: still invalid after the retry → the message is searched as typed, locally, with the override recorded", async () => {
  const ollama = ragOllama({ route: ["nope", "still nope"], answer: [GOOD_ANSWER] });
  const turn = await runChatTurn({ message: "Is CMP for iOS stable?", messages: [], memory: emptyMemory(), turn: 1, provider: local(ollama), ragOptions: { search, rerankScores: rerankHigh, rerank: true }, log: silent });
  assert.equal(turn.route.intent, "search");
  assert.equal(turn.route.override, "invalid JSON → search");
  assert.equal(turn.route.standaloneQuestion, "Is CMP for iOS stable?");
  assert.equal(turn.result.status, "answered");
});

test("submit_answer: invalid JSON, then a valid retry; the call counts one invalid reply", async () => {
  const ollama = ragOllama({ answer: ['{"status":"answered","answer":"x"}', GOOD_ANSWER] });
  const run = await answerQuestion("Is CMP for iOS stable?", { provider: local(ollama), search, rerankScores: rerankHigh, rerank: true, log: silent });
  const calls = ollama.chats();
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages.at(-1).content, /rejected: .*citations/);
  assert.equal(run.status, "answered");
  assert.equal(run.verification.firstAttemptValid, true, "the JSON retry is the provider's; the contract saw one valid submission");
  assert.equal(run.generation.invalidJson, 1);
  assert.equal(run.generation.schemaFailures, 0);
});

test("submit_clarification (low relevance): a JSON-schema call, and invalid JSON is retried", async () => {
  const ollama = ragOllama({ clarify: ["{}", { clarifying_question: "Did you mean Compose Multiplatform for iOS?" }] });
  const run = await answerQuestion("pasta?", { provider: local(ollama), search, rerankScores: rerankLow, rerank: true, log: silent });
  const calls = ollama.chats();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].format.required, ["clarifying_question"]);
  assert.match(calls[1].messages.at(-1).content, /rejected: .*clarifying_question/);
  assert.equal(run.status, "dont_know");
  assert.equal(run.dontKnow.reason, "low_relevance");
  assert.equal(run.clarifyingQuestion, "Did you mean Compose Multiplatform for iOS?");
  assert.equal(run.provider, "local");
  assert.equal(run.generation.invalidJson, 1);
});

test("a failed verification is retried as a plain user message (no tool_result), with the same rules as Claude", async () => {
  const fabricated = { ...GOOD_ANSWER, citations: [{ id: "c1", chunk_id: "cmp:3", quote: "Compose for iOS has been stable since 2023 and everyone uses it." }] };
  const ollama = ragOllama({ answer: [fabricated, GOOD_ANSWER] });
  const run = await answerQuestion("Is CMP for iOS stable?", { provider: local(ollama), search, rerankScores: rerankHigh, rerank: true, log: silent });
  const [, retry] = ollama.chats();
  const [assistant, user] = retry.messages.slice(-2);
  assert.equal(assistant.role, "assistant");
  assert.deepEqual(JSON.parse(assistant.content), fabricated, "the model sees its own submission as JSON");
  assert.equal(user.role, "user");
  assert.match(user.content, /^The answer did not pass verification:\n- Rule 4: citation c1's quote is not in chunk "cmp:3"/);
  assert.doesNotMatch(user.content, /\[tool (result|error)\]/);
  assert.equal(run.verification.firstAttemptValid, false);
  assert.equal(run.verification.retried, true);
  assert.equal(run.verification.fabricatedFirstAttempt.length, 1);
  assert.equal(run.status, "answered");
  assert.equal(run.generation.calls.length, 2);
});

test("after a failed retry a local answer is downgraded exactly as Claude's would be", async () => {
  const bad = { ...GOOD_ANSWER, citations: [{ id: "c1", chunk_id: "nope:0", quote: "Compose Multiplatform for iOS is stable as of version 1.8.0." }] };
  const ollama = ragOllama({ answer: [bad, bad] });
  const run = await answerQuestion("Is CMP for iOS stable?", { provider: local(ollama), search, rerankScores: rerankHigh, rerank: true, log: silent });
  assert.equal(run.status, "dont_know");
  assert.equal(run.dontKnow.reason, "verification_failed");
  assert.equal(run.verification.downgraded, true);
});

test("submit_answer never valid JSON: counted as not submitting, retried by the contract, then downgraded", async () => {
  const ollama = ragOllama({ answer: ["{", "{", "{", "{"] });
  const run = await answerQuestion("Is CMP for iOS stable?", { provider: local(ollama), search, rerankScores: rerankHigh, rerank: true, log: silent });
  assert.equal(ollama.chats().length, 4, "two JSON attempts per contract attempt");
  assert.match(run.verification.firstAttemptErrors[0], new RegExp(`not a valid ${ANSWER_TOOL_NAME} JSON object`));
  assert.equal(ollama.chats()[2].messages.at(-1).role, "user");
  assert.equal(run.status, "dont_know");
  assert.equal(run.verification.downgraded, true);
  assert.equal(run.generation.invalidJson, 4);
  assert.equal(run.generation.schemaFailures, 2);
});

test("truncation: a prompt within 10% of num_ctx is logged and flagged as possible_truncation", async () => {
  const lines = [];
  const near = (body) => ollamaReply(JSON.stringify(GOOD_ANSWER), { model: body.model, prompt: 3700 });
  const ollama = fakeOllama([near]);
  const provider = new OllamaProvider({ model: "qwen3.5:9b", fetch: ollama.fetch, settings: { numCtx: 4096, numPredict: 2048 }, log: (line) => lines.push(line) });
  const run = await answerQuestion("Is CMP for iOS stable?", { provider, search, rerankScores: rerankHigh, rerank: true, log: silent });
  assert.equal(run.possible_truncation, true);
  assert.equal(run.generation.possible_truncation, true);
  assert.match(lines.join("\n"), /possible truncation: qwen3\.5:9b prompt 3700 tokens, num_ctx 4096/);

  // Comfortably inside the window: no flag.
  const fine = fakeOllama([(body) => ollamaReply(JSON.stringify(GOOD_ANSWER), { model: body.model, prompt: 3600 })]);
  const ok = await answerQuestion("Is CMP for iOS stable?", { provider: new OllamaProvider({ model: "qwen3.5:9b", fetch: fine.fetch, settings: { numCtx: 4096 }, log: () => assert.fail("no log") }), search, rerankScores: rerankHigh, rerank: true, log: silent });
  assert.equal(ok.possible_truncation, undefined);
});

// ---- eval:local -----------------------------------------------------------------------

const QUESTIONS = [
  { id: "q1", type: "corpus", question: "Is CMP for iOS stable?", expected_facts: ["a", "b"] },
  { id: "q2", type: "off_topic", question: "Best pasta?", expected_facts: ["a", "b"], expect_decline: true },
];
const SETTINGS = { kFinal: 5, kRetrieve: 20, rerankThreshold: 0.02, strategy: "structural", collections: [], minScore: null };

test("eval:local: retrieval runs once per question and is reused from the cache on the next run", async () => {
  let retrieved = 0;
  const retrieve = async (question) => {
    retrieved += 1;
    return { queries: [question], candidates: [], chunks: CHUNKS.map((c, i) => ({ n: i + 1, ...c })), rejected: [], declined: false, rerank: true, rewrite: false, timings: { rewriteMs: 0, retrieveMs: 5, rerankMs: 7 }, rewriteUsage: null };
  };
  const first = await loadRetrievals({ questions: QUESTIONS, settings: SETTINGS, cache: null, retrieve });
  assert.equal(retrieved, 2);
  assert.deepEqual(first.retrieved, ["q1", "q2"]);
  assert.deepEqual(first.cache.settings, retrievalKey(SETTINGS));

  const cache = JSON.parse(JSON.stringify(first.cache)); // as read back from the file
  const second = await loadRetrievals({ questions: QUESTIONS, settings: SETTINGS, cache, retrieve });
  assert.equal(retrieved, 2, "nothing retrieved again");
  assert.deepEqual(second.reused, ["q1", "q2"]);
  assert.deepEqual(second.retrievals, first.retrievals);

  // Other settings, or --fresh: retrieved again.
  await loadRetrievals({ questions: QUESTIONS, settings: { ...SETTINGS, rerankThreshold: 0.5 }, cache, retrieve });
  assert.equal(retrieved, 4);
  await loadRetrievals({ questions: QUESTIONS, settings: SETTINGS, cache, retrieve, fresh: true });
  assert.equal(retrieved, 6);
});

test("eval:local: every generator answers from the same cached chunks, and none of them retrieves", async () => {
  const retrievals = {
    q1: { queries: ["q1"], candidates: [], chunks: CHUNKS.map((c, i) => ({ n: i + 1, ...c })), rejected: [], declined: false, rerank: true, rewrite: false, timings: { rewriteMs: 0, retrieveMs: 5, rerankMs: 7 } },
    q2: { queries: ["q2"], candidates: [], chunks: [], rejected: [{ ...CHUNKS[1], rerankScore: 0.001 }], declined: true, rerank: true, rewrite: false, timings: { rewriteMs: 0, retrieveMs: 4, rerankMs: 6 } },
  };
  const seen = {};
  /** Records the chunk_ids each generator's answer prompt carried. */
  const spy = (id) => ({
    provider: "spy",
    model: id,
    async complete({ messages, toolChoice }) {
      const prompt = String(messages.at(-1).content);
      if (toolChoice.name === ANSWER_TOOL_NAME) (seen[id] ??= []).push([...prompt.matchAll(/chunk_id="([^"]+)"/g)].map((m) => m[1]).join(","));
      const input = toolChoice.name === "submit_clarification" ? { clarifying_question: "Which Kotlin topic?" } : GOOD_ANSWER;
      return { text: "", content: [{ type: "tool_use", id: "t", name: toolChoice.name, input }], model: id, provider: id === "claude" ? "claude" : "local", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" };
    },
  });
  const settings = { ...SETTINGS, search: () => assert.fail("a generator must not search"), rerankScores: () => assert.fail("a generator must not rerank") };
  const order = (() => {
    let n = 1;
    return () => n++;
  })();
  const claude = await runGenerator({ generator: { id: "claude", provider: spy("claude") }, questions: QUESTIONS, retrievals, settings, nextOrder: order });
  const qwen = await runGenerator({ generator: { id: "qwen3.5:9b", provider: spy("qwen3.5:9b") }, questions: QUESTIONS, retrievals, settings, nextOrder: order });
  assert.deepEqual(seen.claude, ["cmp:3,ktor:0"], "q2 was declined by the cutoff: only the clarifying call, no documents");
  assert.deepEqual(seen["qwen3.5:9b"], seen.claude);
  assert.deepEqual(qwen.map((r) => r.run.chunkIds), claude.map((r) => r.run.chunkIds));
  assert.deepEqual(qwen.map((r) => r.order), [3, 4]);
  assert.equal(claude[0].run.timings.rerankMs, 7, "the shared rerank time is reported as it was");
  assert.equal(claude[0].run.retrievalShared, true);
  assert.equal(qwen[1].run.dontKnow.reason, "low_relevance");

  const summary = summarizeGenerator(qwen, { loadMs: 1234 });
  assert.equal(summary.answered, 1);
  assert.equal(summary.correctIdk, 1);
  assert.equal(summary.loadMs, 1234);
});

test("eval:local: a generator whose call fails gets an error row, not a crash and not another model's answer", async () => {
  const retrievals = { q1: { queries: ["q1"], candidates: [], chunks: CHUNKS.map((c, i) => ({ n: i + 1, ...c })), rejected: [], declined: false, rerank: true, rewrite: false, timings: { rewriteMs: 0, retrieveMs: 1, rerankMs: 1 } } };
  const down = { provider: "local", model: "qwen3.5:9b", complete: async () => { throw new Error("Local model unavailable. Ollama isn't reachable"); } };
  const [row] = await runGenerator({ generator: { id: "qwen3.5:9b", provider: down }, questions: [QUESTIONS[0]], retrievals, settings: SETTINGS });
  assert.match(row.error, /Ollama isn't reachable/);
  assert.equal(row.run.status, "error");
  assert.equal(row.checks.idk, false);
  assert.equal(summarizeGenerator([row]).errors.length, 1);
});
