import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { FakeProvider } from "../llm/anthropic.js";
import { ragRoutes } from "../ragRoutes.js";
import { MemoryStore } from "../store/memoryStore.js";
import { CHECKS, MAX_MESSAGES, MIN_MESSAGES, chatSummaryRows, loadScenarios, missingElements, renderChatReport, sentenceCount, summarizeScenario, turnChecks, validateScenario } from "./chatEval.js";
import { parseMemoryCheck, parseOnTrack } from "./chatJudge.js";
import { CHAT_RAG_SYSTEM, answerHistory, chatRagPrompt, runChatTurn } from "./chatTurn.js";
import { chatSettings } from "./config.js";
import { ASSISTANT_PREVIEW_CHARS, ROUTE_TOOL, parseRoute, routeMessage, routerHistory, routerPrompt } from "./router.js";
import { addOpenQuestion, applyPatch, emptyMemory, memoryDiff, renderMemory, taskMemoryOf } from "./taskMemory.js";

/**
 * **Day 25, offline**: the router, the task memory, one chat turn, the chat
 * route, and the scenario files. A fake router, provider, searcher and
 * reranker stand in for the models and doc_index.
 */

const quiet = () => {};
const HITS = [
  { score: 0.7, source: "kb/a.html", section: "Intro", title: "A", chunk_id: "a:0", text: "Compose adds about 9 MB to an iOS app." },
  { score: 0.5, source: "kb/b.html", section: "", title: "B", chunk_id: "b:0", text: "Startup time is comparable to native apps." },
];

/** A completion in the shape of a forced `route` call. */
const routeCall = (input) => ({ content: [{ type: "tool_use", id: "toolu_r", name: "route", input }], usage: { inputTokens: 50, outputTokens: 20 }, model: "router-model" });

/** A provider that records every call; `submit_answer` quotes document 1, `submit_clarification` asks a fixed question. */
function recordingProvider({ dontKnow = false } = {}) {
  const calls = [];
  const use = (name, input) => ({ text: "", content: [{ type: "tool_use", id: `toolu_${calls.length}`, name, input }], model: "stub", stopReason: "tool_use", usage: { inputTokens: 100, outputTokens: 10 } });
  return {
    calls,
    model: "stub",
    async complete(params) {
      calls.push(params);
      if (params.toolChoice?.name === "submit_answer") {
        if (dontKnow) return use("submit_answer", { status: "dont_know", answer: "", citations: [], clarifying_question: "Which part of the migration do you mean?" });
        const doc = /<doc n="1" chunk_id="([^"]*)"[^>]*>\n([\s\S]*?)\n<\/doc>/.exec(params.messages.at(-1).content);
        return use("submit_answer", { status: "answered", answer: "It adds about 9 MB [c1].", citations: [{ id: "c1", chunk_id: doc[1], quote: doc[2] }] });
      }
      if (params.toolChoice?.name === "submit_clarification") return use("submit_clarification", { clarifying_question: "Did you mean X or Y?" });
      throw new Error(`unexpected call: ${params.toolChoice?.name}`);
    },
  };
}

/** A router that returns the given routes in order (parsed with the real overrides), recording what it saw. */
function scriptedRouter(...inputs) {
  const seen = [];
  const router = async ({ message, messages, memory, historyTurns }) => {
    seen.push({ message, messages, memory, historyTurns });
    return { ...parseRoute(routeCall(inputs.shift() ?? {}), { message, memory }), usage: { inputTokens: 50, outputTokens: 20 }, model: "router-model" };
  };
  return Object.assign(router, { seen });
}

function fakeSearch() {
  const calls = [];
  const search = async (query, options) => (calls.push({ query, options }), HITS.slice(0, options.k));
  return Object.assign(search, { calls });
}
function fakeRerank(score = () => 0.9) {
  const calls = [];
  const rerankScores = async (query, passages) => (calls.push({ query, passages }), passages.map(score));
  return Object.assign(rerankScores, { calls });
}
const SETTINGS = { kFinal: 2, kRetrieve: 4, rerankThreshold: 0.5, strategy: "structural", collections: [], minScore: null };

// ---- router ----------------------------------------------------------------------

test("router output: parsed into intent, standalone question, queries, reply and patch", () => {
  const route = parseRoute(
    routeCall({ intent: "search", standalone_question: "  How much does Compose Multiplatform add to iOS app size? ", queries: ["Compose Multiplatform iOS app size", "compose multiplatform ios app size", "", "  SwiftUI comparison  ", "4th"], reply: "ignored", memory_patch: [{ op: "add_constraint", text: "max 3 sentences" }] }),
    { message: "how big?", memory: emptyMemory() },
  );
  assert.equal(route.intent, "search");
  assert.equal(route.override, null);
  assert.equal(route.standaloneQuestion, "How much does Compose Multiplatform add to iOS app size?");
  assert.deepEqual(route.queries, ["Compose Multiplatform iOS app size", "SwiftUI comparison", "4th"], "trimmed, de-duplicated, at most 3");
  assert.equal(route.reply, "", "a search turn has no router reply");
  assert.deepEqual(route.patch, [{ op: "add_constraint", text: "max 3 sentences" }]);

  const chat = parseRoute(routeCall({ intent: "chat", reply: "You're welcome!", memory_patch: [] }), { message: "thanks", memory: emptyMemory() });
  assert.deepEqual([chat.intent, chat.reply, chat.queries, chat.standaloneQuestion], ["chat", "You're welcome!", [], ""]);
  const memoryOnly = parseRoute(routeCall({ intent: "memory_only", memory_patch: "nonsense" }), { message: "max 3 sentences", memory: emptyMemory() });
  assert.deepEqual([memoryOnly.intent, memoryOnly.reply, memoryOnly.patch], ["memory_only", "Noted.", []], "a missing reply gets a default; a bad patch is empty");
});

test("router overrides: a missing or invalid intent is search; an open question makes anything but chat search", () => {
  const missing = parseRoute(routeCall({ memory_patch: [] }), { message: "why?", memory: emptyMemory() });
  assert.deepEqual([missing.intent, missing.override, missing.standaloneQuestion, missing.queries], ["search", "missing intent → search", "why?", ["why?"]]);
  const invalid = parseRoute(routeCall({ intent: "smalltalk" }), { message: "hm", memory: emptyMemory() });
  assert.deepEqual([invalid.intent, invalid.routedIntent], ["search", "smalltalk"]);
  const noCall = parseRoute({ content: [{ type: "text", text: "hello" }] }, { message: "hi", memory: emptyMemory() });
  assert.deepEqual([noCall.intent, noCall.called], ["search", false]);

  const open = addOpenQuestion(emptyMemory(), { text: "Which part do you mean?", about: "How long would the migration take?", turn: 6 }).memory;
  const forced = parseRoute(routeCall({ intent: "memory_only", reply: "Noted.", memory_patch: [] }), { message: "I mean gradually", memory: open });
  assert.equal(forced.intent, "search");
  assert.equal(forced.override, "open question q6 → search");
  assert.equal(forced.standaloneQuestion, "How long would the migration take? (clarification: I mean gradually)", "without the router's, the open question plus the clarification");
  const chat = parseRoute(routeCall({ intent: "chat", reply: "Hi!" }), { message: "thanks", memory: open });
  assert.equal(chat.intent, "chat", "chat stays chat even with an open question");
});

test("routeMessage: one forced route call at temperature 0 with the router model; memory, history and the message in the prompt", async () => {
  const calls = [];
  const provider = { complete: async (p) => (calls.push(p), routeCall({ intent: "chat", reply: "Hi", memory_patch: [] })) };
  const memory = applyPatch(emptyMemory(), [{ op: "set_goal", text: "Pick a UI toolkit" }], { turn: 1 }).memory;
  const route = await routeMessage({ provider, model: "claude-haiku-4-5-20251001", message: "hello", messages: [{ role: "user", content: "earlier" }], memory });
  assert.equal(route.intent, "chat");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].temperature, 0);
  assert.equal(calls[0].model, "claude-haiku-4-5-20251001");
  assert.deepEqual(calls[0].toolChoice, { name: "route" });
  assert.deepEqual(calls[0].tools, [ROUTE_TOOL]);
  const prompt = calls[0].messages[0].content;
  assert.match(prompt, /Goal: Pick a UI toolkit/);
  assert.match(prompt, /User: earlier/);
  assert.ok(prompt.endsWith("New message:\nhello"));
  assert.deepEqual(chatSettings({}), { routerModel: "claude-haiku-4-5-20251001", historyTurns: 6 });
  assert.deepEqual(chatSettings({ RAG_ROUTER_MODEL: "m", RAG_HISTORY_TURNS: "4" }), { routerModel: "m", historyTurns: 4 });
  assert.throws(() => chatSettings({ RAG_HISTORY_TURNS: "0" }), /RAG_HISTORY_TURNS/);
});

// ---- history window -----------------------------------------------------------------

test("history window: bounded to the last N messages; assistant messages shortened, citations stripped", () => {
  const long = "Compose Multiplatform adds about 9 MB [c1]. ".repeat(20);
  const messages = [];
  for (let i = 1; i <= 6; i++) messages.push({ role: "user", content: `question ${i}` }, { role: "assistant", content: `answer ${i} [c1][c2] ${long}` });
  const history = routerHistory(messages, 6);
  assert.equal(history.length, 6);
  assert.deepEqual(history.filter((m) => m.role === "user").map((m) => m.content), ["question 4", "question 5", "question 6"]);
  for (const m of history.filter((x) => x.role === "assistant")) {
    assert.ok(m.content.length <= ASSISTANT_PREVIEW_CHARS + 2, `cut to ~${ASSISTANT_PREVIEW_CHARS} chars, got ${m.content.length}`);
    assert.doesNotMatch(m.content, /\[c\d+\]/);
    assert.ok(m.content.endsWith("…"));
  }
  assert.deepEqual(routerHistory(messages, 2).map((m) => m.role), ["user", "assistant"]);
  const prompt = routerPrompt({ message: "and the other one?", history, memory: emptyMemory() });
  assert.doesNotMatch(prompt, /question 3/, "nothing older than the window");

  // The answering call: the same window, citations stripped, not cut.
  const answer = answerHistory(messages, 4);
  assert.equal(answer.length, 4);
  assert.doesNotMatch(answer[1].content, /\[c\d\]/);
  assert.ok(answer[1].content.length > ASSISTANT_PREVIEW_CHARS);
});

// ---- task memory -------------------------------------------------------------------

test("memory patches: applied in order, ids per turn, a correction replaces its item", () => {
  let { memory, applied, skipped } = applyPatch(
    emptyMemory(),
    [
      { op: "set_goal", text: "Decide on Compose Multiplatform for iOS" },
      { op: "add_constraint", text: "Answers at most 3 sentences" },
      { op: "add_constraint", text: "'CMP' = Compose Multiplatform" },
      { op: "add_clarified", text: "The team is Android-only" },
    ],
    { turn: 2 },
  );
  assert.deepEqual(skipped, []);
  assert.equal(memory.goal, "Decide on Compose Multiplatform for iOS");
  assert.deepEqual(memory.constraints.map((c) => [c.id, c.turn]), [["k2", 2], ["k2b", 2]]);
  assert.deepEqual(memory.clarified.map((c) => c.id), ["d2"]);
  assert.equal(applied.length, 4);

  const corrected = applyPatch(memory, [{ op: "remove", id: "d2" }, { op: "add_clarified", text: "The team ships to Android and iOS" }], { turn: 6 });
  assert.deepEqual(corrected.memory.clarified.map((c) => [c.id, c.text]), [["d6", "The team ships to Android and iOS"]]);
  assert.deepEqual(memoryDiff(memory, corrected.memory), { added: ["d6"], removed: [{ id: "d2", list: "clarified", text: "The team is Android-only" }], goalChanged: false, previousGoal: "Decide on Compose Multiplatform for iOS" });
  assert.equal(corrected.memory.constraints.length, 2, "the rest is untouched");
});

test("memory patches: an unknown op or id is skipped, never fatal; nothing disappears without a remove", () => {
  const start = applyPatch(emptyMemory(), [{ op: "set_goal", text: "Goal" }, { op: "add_constraint", text: "Max 3 sentences" }], { turn: 1 }).memory;
  const logged = [];
  const { memory, applied, skipped } = applyPatch(
    start,
    [
      { op: "rewrite_all", memory: {} },
      null,
      { op: "remove", id: "k99" },
      { op: "resolve_question", id: "k1" },
      { op: "add_constraint", text: "max 3 SENTENCES" },
      { op: "add_clarified", text: "   " },
      { op: "set_goal", text: "" },
      { op: "add_clarified", text: "They mean gradual adoption" },
    ],
    { turn: 3, log: (line) => logged.push(line) },
  );
  assert.deepEqual(skipped.map((s) => s.reason), ["unknown op", "unknown op", "unknown id", "not an open question", "duplicate", "empty text", "empty text"]);
  assert.equal(logged.length, 7, "each skip is logged");
  assert.deepEqual(applied.map((a) => a.op), ["add_clarified"]);
  assert.equal(memory.goal, "Goal", "an empty set_goal does not clear the goal");
  assert.deepEqual(memory.constraints.map((c) => c.id), ["k1"], "nothing removed without a remove op");
  assert.deepEqual(applyPatch(start, undefined, { turn: 4 }).memory, start, "no patch, no change");

  // A stored memory is coerced, and the prompt rendering carries the ids.
  assert.deepEqual(taskMemoryOf({ goal: 3, clarified: [{ id: "d1", text: "x" }, { id: "d1", text: "dup" }, { text: "no id" }] }), { goal: null, clarified: [{ id: "d1", text: "x", turn: null }], constraints: [], open_questions: [] });
  assert.match(renderMemory(memory), /\[k1\] Max 3 sentences/);
  assert.doesNotMatch(renderMemory(memory, { ids: false }), /\[k1\]/);
});

// ---- one turn ----------------------------------------------------------------------

test("non-search intents: chat and memory_only never call search or the answering model", async () => {
  for (const input of [
    { intent: "chat", reply: "You're welcome!", memory_patch: [] },
    { intent: "memory_only", reply: "Got it: at most 3 sentences.", memory_patch: [{ op: "add_constraint", text: "Answers at most 3 sentences" }] },
  ]) {
    const provider = recordingProvider();
    const search = fakeSearch();
    const rerankScores = fakeRerank();
    const turn = await runChatTurn({ message: "x", messages: [], memory: emptyMemory(), turn: 2, provider, router: scriptedRouter(input), ragOptions: { ...SETTINGS, rerank: true, search, rerankScores }, log: quiet });
    assert.equal(turn.route.intent, input.intent);
    assert.equal(turn.result, null);
    assert.equal(turn.reply, input.reply);
    assert.equal(search.calls.length, 0, `${input.intent}: no search`);
    assert.equal(rerankScores.calls.length, 0);
    assert.equal(provider.calls.length, 0, `${input.intent}: no answering call`);
    assert.equal(turn.route.answerMs, 0);
  }
});

test("rerank input: the reranker scores against standalone_question, the search uses the router's queries", async () => {
  const provider = recordingProvider();
  const search = fakeSearch();
  const rerankScores = fakeRerank();
  const router = scriptedRouter({ intent: "search", standalone_question: "How does Compose Multiplatform start up on iOS compared with native apps?", queries: ["Compose Multiplatform iOS startup time", "iOS scrolling performance"], memory_patch: [] });
  const memory = applyPatch(emptyMemory(), [{ op: "set_goal", text: "Choose CMP or SwiftUI" }, { op: "add_constraint", text: "At most 3 sentences" }], { turn: 1 }).memory;
  const turn = await runChatTurn({ message: "and the second one?", messages: [{ role: "user", content: "q1" }, { role: "assistant", content: "a1 [c1]" }], memory, turn: 2, provider, router, ragOptions: { ...SETTINGS, rerank: true, search, rerankScores }, log: quiet });

  assert.deepEqual(search.calls.map((c) => c.query), ["Compose Multiplatform iOS startup time", "iOS scrolling performance"]);
  assert.ok(rerankScores.calls.length >= 1);
  for (const call of rerankScores.calls) assert.equal(call.query, "How does Compose Multiplatform start up on iOS compared with native apps?", "never the raw 'and the second one?'");
  assert.equal(turn.result.status, "answered");

  const answerCall = provider.calls.find((c) => c.toolChoice?.name === "submit_answer");
  assert.equal(answerCall.system, CHAT_RAG_SYSTEM);
  assert.match(answerCall.system, /\(as you said\)/);
  assert.match(answerCall.system, /task memory is never a source/);
  const latest = answerCall.messages.at(-1).content;
  assert.match(latest, /^<task_memory>\nGoal: Choose CMP or SwiftUI/);
  assert.match(latest, /The user's message: and the second one\?\nQuestion: How does Compose Multiplatform start up/);
  assert.deepEqual(answerCall.messages.slice(0, -1), [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }], "the history, citations stripped");
  assert.equal(chatRagPrompt({ message: "m", standaloneQuestion: "s", memory: emptyMemory(), chunks: [] }).split("\n").at(-1), "Question: s");
});

test("clarification loop (in code): an \"I don't know\" adds its clarifying question to open_questions", async () => {
  for (const [label, provider, rerankScores] of [
    ["model", recordingProvider({ dontKnow: true }), fakeRerank()],
    ["low relevance", recordingProvider(), fakeRerank(() => 0.01)],
  ]) {
    const router = scriptedRouter({ intent: "search", standalone_question: "How long would the migration take?", queries: ["migration time"], memory_patch: [] });
    const turn = await runChatTurn({ message: "How long would the migration take for us?", memory: emptyMemory(), turn: 6, provider, router, ragOptions: { ...SETTINGS, rerank: true, search: fakeSearch(), rerankScores }, log: quiet });
    assert.equal(turn.result.status, "dont_know", label);
    assert.deepEqual(turn.memory.open_questions.map((q) => [q.id, q.turn, q.question]), [["q6", 6, "How long would the migration take?"]], label);
    assert.equal(turn.memory.open_questions[0].text, turn.result.clarifyingQuestion);
    assert.deepEqual(turn.route.openQuestionAdded.id, "q6");
    assert.deepEqual(turn.route.diff.added, ["q6"]);
  }
});

// ---- over HTTP -----------------------------------------------------------------------

const SESSION = "66666666-6666-4666-8666-666666666666";

async function serve(t, { routeTurn, rerankScores = fakeRerank(), search = fakeSearch(), provider = new FakeProvider({ delayMs: 0 }) } = {}) {
  const store = new MemoryStore();
  const app = express();
  app.use(express.json());
  app.use(ragRoutes({ store, provider, settings: SETTINGS, search, rerankScores, ...(routeTurn ? { routeTurn } : {}), reportsDir: fs.mkdtempSync(path.join(os.tmpdir(), "chat-reports-")), ready: () => false, rerankerReady: () => false, log: quiet }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { store, call, search, rerankScores };
}

test("clarification loop (over the chat route): I don't know → open question → the clarification is routed to search and resolves it", async (t) => {
  const router = scriptedRouter(
    { intent: "search", standalone_question: "How long would the migration take?", queries: ["migration duration"], memory_patch: [{ op: "set_goal", text: "Decide on CMP for iOS" }] },
    // The router mislabels the clarification as memory_only: the open question forces search anyway.
    { intent: "memory_only", reply: "Noted.", standalone_question: "Can we migrate to Compose Multiplatform gradually, one screen at a time?", queries: ["gradual adoption one screen at a time"], memory_patch: [{ op: "resolve_question", id: "q1" }, { op: "add_clarified", text: "By migration they mean gradual adoption" }] },
  );
  // First turn: nothing passes the cutoff. Second: everything does.
  let threshold = 0.01;
  const rerankScores = fakeRerank(() => threshold);
  const { store, call, search } = await serve(t, { routeTurn: router, rerankScores });

  const first = await call("POST", "/chat", { message: "How long would the migration take for us?", sessionId: SESSION, agent: "knowledge", ragMode: "rag" });
  assert.equal(first.status, 200);
  assert.match(first.body.reply, /^I don't know\./);
  assert.deepEqual(first.body.meta.taskMemory.open_questions.map((q) => q.id), ["q1"]);
  assert.equal(first.body.meta.route.intent, "search");

  threshold = 0.9;
  const second = await call("POST", "/chat", { message: "I mean gradually, one screen at a time", sessionId: SESSION, agent: "knowledge" });
  assert.equal(second.status, 200);
  const route = second.body.meta.route;
  assert.equal(route.intent, "search");
  assert.equal(route.routedIntent, "memory_only");
  assert.equal(route.override, "open question q1 → search");
  assert.equal(second.body.meta.rag.status, "answered");
  assert.deepEqual(search.calls.at(-1).query, "gradual adoption one screen at a time");
  assert.equal(rerankScores.calls.at(-1).query, "Can we migrate to Compose Multiplatform gradually, one screen at a time?");
  assert.deepEqual(second.body.meta.taskMemory.open_questions, [], "resolved");
  assert.deepEqual(route.diff.removed.map((r) => r.id), ["q1"]);
  assert.equal(router.seen[1].memory.open_questions.length, 1, "the router saw the open question");

  // Stored: the route on each user message, the memory on the record; GET returns both.
  const record = await store.load(SESSION);
  assert.deepEqual(record.messages.map((m) => [m.role, m.route?.intent ?? null]), [["user", "search"], ["assistant", null], ["user", "search"], ["assistant", null]]);
  assert.equal(record.messages[2].route.memoryAfter.clarified[0].text, "By migration they mean gradual adoption");
  const loaded = await call("GET", `/conversations/${SESSION}`);
  assert.equal(loaded.body.taskMemory.goal, "Decide on CMP for iOS");
  assert.equal(loaded.body.messages[0].route.openQuestionAdded.id, "q1");

  // The panel's reset clears the memory and nothing else.
  assert.deepEqual((await call("DELETE", `/conversations/${SESSION}/task-memory`)).body, { taskMemory: emptyMemory(), saved: true });
  assert.deepEqual((await store.load(SESSION)).taskMemory, emptyMemory());
  assert.equal((await store.load(SESSION)).messages.length, 4);
});

test("a chat turn over the route: the router's reply, no documents; plain mode skips the router", async (t) => {
  const router = scriptedRouter({ intent: "chat", reply: "Happy to help!", memory_patch: [] });
  const { store, call, search } = await serve(t, { routeTurn: router });
  const res = await call("POST", "/chat", { message: "thanks!", sessionId: SESSION, agent: "knowledge", ragMode: "rag" });
  assert.equal(res.status, 200);
  assert.equal(res.body.reply, "Happy to help!");
  assert.equal(res.body.meta.rag, undefined);
  assert.equal(res.body.meta.route.intent, "chat");
  assert.equal(search.calls.length, 0);
  assert.equal(res.body.meta.tokens.input, 50, "the router's tokens");

  await call("POST", "/chat", { message: "plain question", sessionId: SESSION, agent: "knowledge", ragMode: "plain" });
  assert.equal(router.seen.length, 1, "plain mode never routes");
  const record = await store.load(SESSION);
  assert.equal(record.messages[2].route, undefined);
  assert.equal(record.messages[1].content, "Happy to help!");
});

test("the offline FakeProvider routes every message to search for itself", async () => {
  const route = await routeMessage({ provider: new FakeProvider({ delayMs: 0 }), message: "How big is it?", messages: [], memory: emptyMemory() });
  assert.deepEqual([route.intent, route.standaloneQuestion, route.queries], ["search", "How big is it?", ["How big is it?"]]);
});

// ---- scenarios and the eval's checks --------------------------------------------------

test("scenario files: valid against the schema, 12–15 messages each, and every required element present", () => {
  const scenarios = loadScenarios();
  assert.deepEqual(scenarios.map((s) => s.id), ["scenario-1", "scenario-2"]);
  assert.deepEqual(scenarios.map((s) => s.kind), ["deep_dive", "comparison"]);
  for (const s of scenarios) {
    assert.deepEqual(validateScenario(s), [], s.id);
    assert.ok(s.messages.length >= MIN_MESSAGES && s.messages.length <= MAX_MESSAGES, `${s.id}: ${s.messages.length} messages`);
  }
  assert.deepEqual(missingElements(scenarios, { historyTurns: chatSettings({}).historyTurns }), []);
  // At least one chat, one memory_only and both kinds of decline across the two.
  const all = scenarios.flatMap((s) => s.messages);
  for (const intent of ["search", "memory_only", "chat"]) assert.ok(all.some((m) => m.expected_intent === intent), intent);
  assert.ok(all.filter((m) => m.expect.decline).length >= 2);
});

test("scenario validation fails loudly", () => {
  const [s1] = loadScenarios(["scenario-1"]);
  const broken = structuredClone(s1);
  broken.messages = broken.messages.slice(0, 5);
  broken.messages[1].expected_intent = "talk";
  broken.messages[2].expect.sources = ["elsewhere/x.html"];
  broken.messages[3].constraint_check = { max_lines: 2 };
  broken.messages[4].tags = ["nope"];
  const errors = validateScenario(broken);
  for (const pattern of [/5 messages; must be 12–15/, /expected_intent/, /knowledge_database/, /constraint_check/, /tags must be/]) assert.ok(errors.some((e) => pattern.test(e)), `${pattern} in ${errors.join(" | ")}`);
  // Without the late reference or the vague → clarification pair, the elements check says so.
  const scenarios = loadScenarios();
  const stripped = scenarios.map((s) => ({ ...s, messages: s.messages.map((m) => ({ ...m, tags: (m.tags ?? []).filter((t) => t !== "late_reference" && t !== "clarification") })) }));
  const missing = missingElements(stripped);
  assert.equal(missing.length, 2);
  assert.match(missing.join(" "), /vague question/);
  assert.match(missing.join(" "), /late question/);
});

test("eval checks: intent, sources, expected source, constraint, memory, on track, facts", () => {
  const message = { turn: 3, user: "How big?", expected_intent: "search", expect: { decline: false, sources: ["kb/a.html"], facts: ["9 MB"] }, memory_checkpoint: ["x"], constraint_check: { max_sentences: 2 }, notes: "n" };
  const run = { status: "answered", sources: [{ source: "kb/a.html" }], citations: [{ id: "c1" }], chunks: [{ source: "kb/a.html" }], verification: { firstAttemptCitations: 1, fabricatedFirstAttempt: [], retried: false } };
  const good = { route: { intent: "search", routerMs: 900, answerMs: 2000 }, run, reply: "It adds 9 MB [c1]. That is small [c1].", memoryCheck: { passed: true, statements: [{ statement: "x", reflected: true }], stale: [] }, onTrack: { onTrack: true }, faithfulness: { faithfulness: 1, unsupported: 0 }, grade: { score: 1, hallucination: false } };
  assert.deepEqual(turnChecks(message, good), { intent: true, sources: true, expectedSource: true, constraint: true, memory: true, onTrack: true, facts: true });
  const bad = { ...good, route: { intent: "memory_only" }, reply: "One. Two. Three.", run: null, memoryCheck: { passed: false }, onTrack: { onTrack: true }, faithfulness: null, grade: { score: 0.5 } };
  assert.deepEqual(turnChecks(message, bad), { intent: false, sources: false, expectedSource: false, constraint: false, memory: false, onTrack: true, facts: false });
  const unfaithful = { ...good, faithfulness: { faithfulness: 0.5, unsupported: 1 } };
  assert.equal(turnChecks(message, unfaithful).onTrack, false, "on track includes the faithfulness judge: an unsupported claim fails");
  assert.equal(turnChecks(message, { ...good, faithfulness: { faithfulness: 0.67, unsupported: 0, partial: 1 } }).onTrack, true, "a partial claim is reported, not failed");
  // A turn expected to decline passes on dont_know with a clarifying question; its constraint does not apply.
  const decline = { turn: 6, user: "?", expected_intent: "search", expect: { decline: true }, constraint_check: { max_sentences: 1 }, notes: "n" };
  const idk = { route: { intent: "search" }, run: { status: "dont_know", clarifyingQuestion: "Which?", sources: [], citations: [], chunks: [] }, reply: "I don't know. Which?" };
  assert.deepEqual(turnChecks(decline, idk), { intent: true, sources: true, expectedSource: null, constraint: null, memory: null, onTrack: null, facts: null });
  assert.equal(sentenceCount("First claim [c1]. Second, e.g. this one [c2].\n- a bullet"), 3);

  const rows = [
    { message, ...good, ms: 3000, tokens: { input: 10, output: 5 }, cost: 0.01 },
    { message: decline, ...idk, ms: 1000, tokens: { input: 5, output: 1 }, cost: 0.001 },
  ].map((r) => ({ ...r, checks: turnChecks(r.message, r) }));
  const summary = summarizeScenario(rows);
  assert.equal(summary.turnsPassed, 2);
  assert.deepEqual(summary.intent, { correct: 2, total: 2 });
  assert.equal(summary.correctDeclines, 1);
  assert.equal(chatSummaryRows(summary).length, 15);
  assert.equal(CHECKS.length, 7);
  const md = renderChatReport({ generatedAt: "now", settings: { routerModel: "r", historyTurns: 6, model: "m", mode: "rag+rerank", rerankThreshold: 0.02, kFinal: 5, kRetrieve: 20, judgeModel: "j" }, scenarios: [{ id: "scenario-1", title: "T", rows: rows.map((r) => ({ ...r, reasons: [], route: { ...r.route, queries: [], standaloneQuestion: "", memoryAfter: emptyMemory(), diff: { added: [], removed: [], goalChanged: false } } })), summary }], notes: "Findings here." });
  assert.match(md, /## Findings\n\nFindings here\./);
  assert.match(md, /scenario-1 · turn 3/);
});

test("judges: memory checkpoint and on-track calls are parsed; stale ids must exist", () => {
  const memory = applyPatch(emptyMemory(), [{ op: "add_clarified", text: "Android-only" }], { turn: 2 }).memory;
  const check = parseMemoryCheck(
    { content: [{ type: "tool_use", name: "submit_memory_check", input: { statements: [{ n: 1, reflected: true }, { n: 2, reflected: false, note: "absent" }], stale_items: [{ id: "[d2]", must_remove: true, why: "corrected" }, { id: "zz", must_remove: true, why: "invented" }, { id: "d2", must_remove: false, why: "on reflection, keep" }] } }] },
    ["a", "b"],
    memory,
  );
  assert.deepEqual(check.statements.map((s) => s.reflected), [true, false]);
  assert.deepEqual(check.stale, [{ id: "d2", why: "corrected" }]);
  assert.equal(check.passed, false);
  assert.deepEqual(parseOnTrack({ content: [{ type: "tool_use", name: "submit_on_track", input: { addresses_question: true, consistent: false, note: "4 sentences" } }] }), { addressesQuestion: true, consistent: false, onTrack: false, note: "4 sentences" });
  assert.throws(() => parseOnTrack({ content: [] }), /submit_on_track/);
});
