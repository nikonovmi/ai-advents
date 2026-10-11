import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createApp } from "../app.js";
import { FakeProvider } from "../llm/anthropic.js";
import { createLlms } from "../llm/choice.js";
import { OllamaProvider, RELOAD_THRESHOLD_MS, countReloads, localSettings } from "../llm/ollama.js";
import { OPT_VARIANT_IDS, optVariant, variantEnv, variantSlug } from "../llm/variants.js";
import { MemoryInvariantStore } from "../store/invariantStore.js";
import { MemoryStore } from "../store/memoryStore.js";
import { MemoryProfileStore } from "../store/profileStore.js";
import { fakeOllama, ollamaReply } from "../testing/ollamaFake.js";
import { answerQuestion } from "./answer.js";
import { CHAT_RAG_SYSTEM, CHAT_RULES, chatRagSystemFor } from "./chatTurn.js";
import { CLARIFY_SYSTEM } from "./clarify.js";
import { decide, lineDiff, variantRecord } from "./optEval.js";
import { RAG_RULES, RAG_RULES_V2, RAG_SYSTEM, RAG_SYSTEM_V2, promptVariantOf, ragSystemFor } from "./prompt.js";
import { ROUTER_SYSTEM, ROUTER_SYSTEM_V2, routeMessage, routerSystemFor } from "./router.js";

/**
 * **Day 29: the optimization variants**, offline. The variant picks num_ctx
 * and the prompts; every local call uses the one window; reloads are counted
 * from `load_duration`; `v1` is untouched, Claude never gets `v2`, and `v2` is
 * not longer than `v1`.
 */

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ---- the variant picks num_ctx and prompts ---------------------------------------------

test("each variant selects its num_ctx and prompts", () => {
  assert.deepEqual(OPT_VARIANT_IDS, ["baseline", "ctx8k", "ctx8k+prompt"]);
  const expected = {
    baseline: { numCtx: 8192, ragNumCtx: 16384, promptVariant: "v1", rag: RAG_SYSTEM, router: ROUTER_SYSTEM },
    ctx8k: { numCtx: 8192, ragNumCtx: 8192, promptVariant: "v1", rag: RAG_SYSTEM, router: ROUTER_SYSTEM },
    "ctx8k+prompt": { numCtx: 8192, ragNumCtx: 8192, promptVariant: "v2", rag: RAG_SYSTEM_V2, router: ROUTER_SYSTEM_V2 },
  };
  for (const id of OPT_VARIANT_IDS) {
    // The variant wins over whatever .env says.
    const env = variantEnv(id, { LOCAL_NUM_CTX: "4096", LOCAL_RAG_NUM_CTX: "32768", LOCAL_PROMPT_VARIANT: "v1", LOCAL_MODELS: "qwen3.5:9b" });
    const llms = createLlms({ claude: new FakeProvider({ delayMs: 0 }), claudeAvailable: true, env });
    const want = expected[id];
    assert.equal(llms.settings.numCtx, want.numCtx, id);
    assert.equal(llms.settings.ragNumCtx, want.ragNumCtx, id);
    assert.equal(llms.settings.promptVariant, want.promptVariant, id);
    const rag = llms.ragProviderFor("local:qwen3.5:9b");
    const plain = llms.providerFor("local:qwen3.5:9b");
    assert.equal(rag.settings.numCtx, want.ragNumCtx, id);
    assert.equal(plain.settings.numCtx, want.numCtx, id);
    assert.equal(ragSystemFor(rag), want.rag, id);
    assert.equal(routerSystemFor(rag), want.router, id);
    assert.equal(chatRagSystemFor(rag), `${want.rag}\n${CHAT_RULES}`, id);
  }
  assert.equal(variantSlug("ctx8k+prompt"), "ctx8k-prompt");
  assert.throws(() => optVariant("ctx4k"), /--variant must be one of baseline, ctx8k, ctx8k\+prompt/);
  assert.equal(localSettings({}).promptVariant, "v1");
  assert.throws(() => localSettings({ LOCAL_PROMPT_VARIANT: "v3" }), /LOCAL_PROMPT_VARIANT must be "v1" or "v2"/);
});

// ---- every local call uses the one num_ctx ------------------------------------------------

const KB = [
  { score: 0.8, source: "kb/cmp.html", section: "iOS", title: "CMP 1.8", chunk_id: "cmp:3", text: "Compose Multiplatform for iOS is stable as of version 1.8.0.\nTeams can now ship shared UI to production." },
];
/** Ollama answering each call by its schema; a plain call gets text. */
const byFormat = (body) => {
  const props = body.format?.properties ?? {};
  if ("intent" in props) {
    const message = /New message:\n([\s\S]*)$/.exec(body.messages.at(-1).content)?.[1] ?? "";
    return JSON.stringify({ intent: "search", standalone_question: message, queries: [message], reply: "", memory_patch: [] });
  }
  if ("citations" in props) return JSON.stringify({ status: "answered", answer: "It is stable [c1].", citations: [{ id: "c1", chunk_id: "cmp:3", quote: "Compose Multiplatform for iOS is stable as of version 1.8.0." }], clarifying_question: "" });
  if ("clarifying_question" in props) return JSON.stringify({ clarifying_question: "Which Kotlin topic do you mean?" });
  return "plain local answer";
};

async function serve(t, { env, scores = 0.9 }) {
  const ollama = fakeOllama(Array.from({ length: 40 }, () => byFormat), { installed: ["qwen3.5:9b"] });
  const claude = new FakeProvider({ delayMs: 0 });
  const llms = createLlms({ claude, claudeAvailable: true, env, fetch: ollama.fetch });
  const ragDeps = { search: async () => KB.map((c) => ({ ...c })), rerankScores: async (_q, passages) => passages.map(() => scores.value ?? scores), log: () => {} };
  const { app } = await createApp({ env: {}, llms, store: new MemoryStore(), profileStore: new MemoryProfileStore(), invariantStore: new MemoryInvariantStore(), ragDeps });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (body) => {
    const res = await fetch(base + "/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { ollama, call };
}

/** Plain chat, first-agent (reply + memory extractor), a RAG turn (router + answer), a declined RAG turn (router + clarification). */
async function everyKindOfCall(t, env) {
  const scores = { value: 0.9 };
  const { ollama, call } = await serve(t, { env, scores });
  const llm = "local:qwen3.5:9b";
  const kinds = {};
  const mark = (kind, fn) => async () => {
    const before = ollama.chats().length;
    const res = await fn();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    kinds[kind] = ollama.chats().slice(before);
  };
  await mark("plain", () => call({ message: "What is KMP?", sessionId: crypto.randomUUID(), agent: "knowledge", llm, ragMode: "plain" }))();
  await mark("first-agent", () => call({ message: "I'm Mira.", sessionId: crypto.randomUUID(), agent: "first-agent", llm }))();
  await mark("rag", () => call({ message: "Is CMP stable?", sessionId: crypto.randomUUID(), agent: "knowledge", llm, ragMode: "rag", rerank: true }))();
  scores.value = 0.001;
  await mark("clarify", () => call({ message: "Best pasta recipe?", sessionId: crypto.randomUUID(), agent: "knowledge", llm, ragMode: "rag", rerank: true }))();
  return kinds;
}

test("ctx8k: every local call — plain chat, extractor, router, answer, clarification — uses the one num_ctx", async (t) => {
  const kinds = await everyKindOfCall(t, variantEnv("ctx8k", { LOCAL_MODELS: "qwen3.5:9b" }));
  assert.equal(kinds.rag.length, 2, "router + answer");
  assert.ok(kinds.rag.every((b) => b.format), "both JSON-schema");
  assert.ok(kinds.clarify.some((b) => "clarifying_question" in (b.format?.properties ?? {}) && !("citations" in b.format.properties)), "the clarification call ran");
  assert.ok(kinds["first-agent"].length >= 2, "reply + extractor");
  const all = Object.values(kinds).flat();
  assert.deepEqual([...new Set(all.map((b) => b.options.num_ctx))], [8192]);
});

test("baseline: RAG calls at 16384 and plain ones at 8192, as on Day 28", async (t) => {
  const kinds = await everyKindOfCall(t, variantEnv("baseline", { LOCAL_MODELS: "qwen3.5:9b" }));
  for (const kind of ["rag", "clarify"]) assert.ok(kinds[kind].every((b) => b.options.num_ctx === 16384), kind);
  for (const kind of ["plain", "first-agent"]) assert.ok(kinds[kind].every((b) => b.options.num_ctx === 8192), kind);
});

// ---- reloads -----------------------------------------------------------------------------------

test("reloads are counted from load_duration: over 1 s, after the first request", async () => {
  assert.equal(RELOAD_THRESHOLD_MS, 1000);
  // The cold load (first) is not a reload; 1000 ms exactly is not over 1 s.
  assert.deepEqual(countReloads([{ loadMs: 6100 }, { loadMs: 40 }, { loadMs: 1000 }, { loadMs: 5200 }, { loadMs: null }, 1500]), { count: 2, at: [3, 5] });
  assert.deepEqual(countReloads([]), { count: 0, at: [] });

  // The provider reports every response's load time, num_ctx and model.
  const loads = [6_100_000_000, 30_000_000, 4_800_000_000];
  const ollama = fakeOllama(loads.map((ns) => ({ ...ollamaReply("ok"), load_duration: ns })), { installed: ["qwen3.5:9b"] });
  const seen = [];
  const llms = createLlms({ claude: null, claudeAvailable: false, env: variantEnv("baseline", {}), fetch: ollama.fetch, onLocalResponse: (r) => seen.push(r) });
  await llms.providerFor("local:qwen3.5:9b").complete({ messages: [{ role: "user", content: "hi" }] });
  await llms.providerFor("local:qwen3.5:9b").complete({ messages: [{ role: "user", content: "hi" }] });
  await llms.ragProviderFor("local:qwen3.5:9b").complete({ messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(seen.map((r) => [r.loadMs, r.numCtx, r.model]), [[6100, 8192, "qwen3.5:9b"], [30, 8192, "qwen3.5:9b"], [4800, 16384, "qwen3.5:9b"]]);
  assert.equal(countReloads(seen).count, 1, "the window change reloaded the model");
});

// ---- v1 unchanged, Claude never v2, v2 not longer -------------------------------------------------

test("v1 prompts are byte-for-byte what they were before Day 29", () => {
  // SHA-256 of the Day 28 strings (commit c02c6e6).
  assert.equal(sha(RAG_SYSTEM), "4f341c0b3400ae99aa9f508218cf28dba62357a90ec1e6e995f1cb5088a80026");
  assert.equal(sha(ROUTER_SYSTEM), "dc30500464876707961e0f11f11509234b62487961364974caca420d111e062d");
  assert.equal(sha(CHAT_RAG_SYSTEM), "d5f871046232d451e8f0752e3451cc6c15faadb24fa07c21af4be4a505e636eb");
  assert.equal(sha(CLARIFY_SYSTEM), "0a71ea4a21941928e2419a37e526d149e5018748f302432322b3a6477f4a10b1");
  // And v1 is what a local provider gets by default.
  const local = new OllamaProvider({ model: "qwen3.5:9b" });
  assert.equal(promptVariantOf(local), "v1");
  assert.equal(ragSystemFor(local), RAG_SYSTEM);
  assert.equal(routerSystemFor(local), ROUTER_SYSTEM);
  assert.equal(chatRagSystemFor(local), CHAT_RAG_SYSTEM);
});

/** A FakeProvider with the settings a local one would carry — still Claude, so still v1. */
class ClaudeSpy extends FakeProvider {
  calls = [];
  settings = { promptVariant: "v2" };
  constructor() {
    super({ delayMs: 0 });
  }
  async complete(params) {
    this.calls.push(params);
    return super.complete(params);
  }
}

test("Claude never gets v2, even with LOCAL_PROMPT_VARIANT=v2", async (t) => {
  const claude = new ClaudeSpy();
  assert.equal(promptVariantOf(claude), "v1");
  assert.equal(ragSystemFor(claude), RAG_SYSTEM);
  assert.equal(routerSystemFor(claude), ROUTER_SYSTEM);

  const chunks = [{ n: 1, score: 0.9, source: "kb/cmp.html", section: "", title: "CMP", chunk_id: "cmp:3", text: KB[0].text }];
  const retrieval = { queries: ["q"], candidates: [], chunks, rejected: [], declined: false, rerank: true, rewrite: false, timings: { rewriteMs: 0, retrieveMs: 0, rerankMs: 0 } };
  const result = await answerQuestion("Is CMP stable?", { mode: "rag", provider: claude, retrieval, log: () => {} });
  assert.equal(claude.calls.at(-1).system, RAG_SYSTEM);
  assert.equal(result.promptVariant, "v1");
  const route = await routeMessage({ provider: claude, message: "hi", messages: [], memory: null });
  assert.equal(claude.calls.at(-1).system, ROUTER_SYSTEM);
  assert.equal(route.promptVariant, "v1");

  // Over HTTP: Compare Claude vs local with v2 configured — Claude's prompt is v1, the local one's v2.
  const ollama = fakeOllama(Array.from({ length: 4 }, () => byFormat), { installed: ["qwen3.5:9b"] });
  const spy = new ClaudeSpy();
  const llms = createLlms({ claude: spy, claudeAvailable: true, env: variantEnv("ctx8k+prompt", { LOCAL_MODELS: "qwen3.5:9b" }), fetch: ollama.fetch });
  const ragDeps = { search: async () => KB.map((c) => ({ ...c })), rerankScores: async (_q, p) => p.map(() => 0.9), log: () => {} };
  const { app } = await createApp({ env: {}, llms, store: new MemoryStore(), profileStore: new MemoryProfileStore(), invariantStore: new MemoryInvariantStore(), ragDeps });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/rag/compare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "Is CMP stable?", versus: "models", llm: "local:qwen3.5:9b", rerank: true }),
  });
  assert.equal(res.status, 200);
  assert.ok(spy.calls.length > 0);
  assert.ok(spy.calls.every((c) => c.system === RAG_SYSTEM), "Claude: v1");
  const localSystem = ollama.chats()[0].messages[0].content;
  assert.ok(localSystem.startsWith(RAG_SYSTEM_V2), "local: v2");
});

test("a local chat with v2: the router and the answer get v2, the chat rules stay", async (t) => {
  const { ollama, call } = await serve(t, { env: variantEnv("ctx8k+prompt", { LOCAL_MODELS: "qwen3.5:9b" }) });
  const res = await call({ message: "Is CMP stable?", sessionId: crypto.randomUUID(), agent: "knowledge", llm: "local:qwen3.5:9b", ragMode: "rag", rerank: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.meta.route.promptVariant, "v2");
  const [router, answer] = ollama.chats();
  assert.ok(router.messages[0].content.startsWith(ROUTER_SYSTEM_V2));
  assert.ok(answer.messages[0].content.startsWith(`${RAG_SYSTEM_V2}\n${CHAT_RULES}`));
});

test("v2 is not longer than v1, and carries the examples it was made for", () => {
  assert.ok(RAG_RULES_V2.length <= RAG_RULES.length, `contract: v2 ${RAG_RULES_V2.length} > v1 ${RAG_RULES.length} chars`);
  assert.ok(RAG_SYSTEM_V2.length <= RAG_SYSTEM.length);
  assert.ok(ROUTER_SYSTEM_V2.length <= ROUTER_SYSTEM.length, `router: v2 ${ROUTER_SYSTEM_V2.length} > v1 ${ROUTER_SYSTEM.length} chars`);
  // One line, one quote: a worked example of two lines as two citations.
  assert.match(RAG_RULES_V2, /One line, one quote/);
  assert.match(RAG_RULES_V2, /\[c1\]\. .*\[c2\]\./);
  // A qualified answer is still an answer.
  assert.match(RAG_RULES_V2, /qualified answer is still an answer/);
  assert.match(RAG_RULES_V2, /Beta but usable in production by early adopters/);
  // Router: rule-setting messages routed memory_only with their operations, as valid patches.
  const examples = ROUTER_SYSTEM_V2.split("\n").filter((l) => l.startsWith("→ ")).map((l) => JSON.parse(l.slice(2)));
  assert.ok(examples.length >= 1 && examples.length <= 2);
  for (const e of examples) {
    assert.equal(e.intent, "memory_only");
    assert.ok(e.memory_patch.length > 0);
  }
  assert.ok(examples.some((e) => e.memory_patch.some((p) => p.op === "add_constraint" && /=/.test(p.text))), "a term definition");
  assert.doesNotMatch(ROUTER_SYSTEM_V2, /empty memory_patch is normal/);
});

// ---- the decision rule ----------------------------------------------------------------------------

const summary = (over = {}) => ({
  answeredWithCitations: 5, answerableWithSources: 5, fabricatedFirstAttempt: 1, retries: 1, droppedCitations: 1, downgrades: 0,
  claimVerdicts: { supported: 6, partial: 4, unsupported: 0 }, correctIdk: 3, falseIdk: [{ id: "q12" }, { id: "q14" }], meanFactScore: 0.66, meanFaithfulness: 0.53,
  possibleTruncations: [], ...over,
});
const rows = (scores) => scores.map((score, i) => ({ id: `q${i}`, expect_decline: false, grade: { score } }));
const variant = (id, s, r, verify = null) => ({ id, eval: { summary: s, rows: r }, verify });

test("the decision rule: ctx8k on truncations and quality rows, v2 on facts, false IDKs, faithfulness and memory", () => {
  const base = variant("baseline", summary(), rows([1, 1, 0.13, 0, 1, 0, 1]));
  let d = decide([base, variant("ctx8k", summary({ retries: 2 }), rows([1, 1, 0.13, 0, 1, 0, 1]), { possibleTruncations: 0 }), variant("ctx8k+prompt", summary({ meanFactScore: 0.8, falseIdk: [{ id: "q14" }], meanFaithfulness: 0.6 }), rows([1, 1, 1, 0, 1, 0.6, 1]), { memoryCheck: true, possibleTruncations: 0 })]);
  assert.equal(d.ctx8k.adopted, true, d.ctx8k.failed.join("; "));
  assert.equal(d.prompt.adopted, true, d.prompt.failed.join("; "));
  assert.equal(d.adopted, "ctx8k+prompt");

  // Two more downgrades than the baseline, or one truncation, and ctx8k is out.
  d = decide([base, variant("ctx8k", summary({ downgrades: 2 }), rows([1, 1, 0.13, 0, 1, 0, 1]))]);
  assert.equal(d.ctx8k.adopted, false);
  assert.deepEqual(d.ctx8k.failed, ["downgrades: not worse by more than one question"]);
  d = decide([base, variant("ctx8k", summary({ possibleTruncations: ["q16"] }), rows([1, 1, 0.13, 0, 1, 0, 1]))]);
  assert.match(d.ctx8k.failed[0], /0 possible truncations/);

  // v2 with a new false IDK and a failed memory check.
  d = decide([base, variant("ctx8k", summary(), rows([1, 1, 0.13, 0, 1, 0, 1])), variant("ctx8k+prompt", summary({ meanFactScore: 0.7, falseIdk: [{ id: "q12" }, { id: "q02" }] }), rows([1, 1, 1, 0, 1, 0, 1]), { memoryCheck: false })]);
  assert.equal(d.prompt.adopted, false);
  assert.deepEqual(d.prompt.failed, ["no new false \"I don't know\"", "verify:local's memory check passes"]);
  assert.equal(d.adopted, "ctx8k");
});

test("lineDiff marks removed and added lines; variantRecord reads the turn-2 patch", () => {
  assert.deepEqual(lineDiff("a\nb\nc", "a\nx\nc"), [{ op: " ", line: "a" }, { op: "-", line: "b" }, { op: "+", line: "x" }, { op: " ", line: "c" }]);
  const turn = (checks, extra = {}) => ({ message: "m", reply: "r", turnMs: 1000, checks, ...extra });
  const record = variantRecord({
    variant: { id: "ctx8k", description: "" },
    evalRun: null,
    verifyRun: { passed: false, outbound: [], claudeCalls: 0, results: [{ model: "qwen3.5:9b", reloads: 0, conversations: [{ rag: true, turns: [turn({ ok: true }), turn({ ok: true }, { intent: "memory_only", patch: [] }), turn({ ok: true, usesMemory: false })] }] }] },
  });
  assert.equal(record.verify.turns[1].intent, "memory_only");
  assert.deepEqual(record.verify.turns[1].patch, []);
  assert.equal(record.verify.memoryCheck, false);
  assert.deepEqual(record.verify.failed, ["turn 3: usesMemory"]);
});
