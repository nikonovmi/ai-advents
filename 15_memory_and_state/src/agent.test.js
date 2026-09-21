import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Agent, personas } from "./agent.js";
import { FakeProvider } from "./llm/anthropic.js";
import { JsonFileStore } from "./store/jsonFileStore.js";
import { MemoryStore } from "./store/memoryStore.js";
import { MemoryProfileStore } from "./store/profileStore.js";
import { MemoryInvariantStore } from "./store/invariantStore.js";

const SESSION = "11111111-1111-4111-8111-111111111111";

/** A provider that answers instantly and remembers what it was asked. */
class StubProvider {
  calls = [];

  async complete({ system, messages }) {
    this.calls.push({ system, messages });
    return {
      text: "ok",
      model: "stub",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }

  async countTokens({ messages }) {
    return { inputTokens: messages.length };
  }
}

function agentWith(options = {}) {
  const provider = options.provider ?? new StubProvider();
  const store = options.store ?? new MemoryStore();
  const agent = new Agent({
    provider,
    store,
    sessionId: SESSION,
    contextMessages: 4,
    ...options,
  });
  return { agent, provider, store };
}

// ---- strategies ------------------------------------------------------------

test("a strategy may take its own bookkeeping out of the reply before it is stored", async () => {
  // `memory` asks the answering model to close an answered question on a fenced
  // line at the end of the message — the only way to read the reply without
  // paying for a second call. Those lines are addressed to the store, so the
  // transcript must never contain one.
  class Fenced {
    calls = 0;
    async complete() {
      this.calls++;
      return {
        text: 'Passed as a parameter.\n<memory-close>{"key":"open.start","answer":"a parameter"}</memory-close>',
        model: "stub",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }
    async countTokens() { return { inputTokens: 1 }; }
  }

  const stripping = {
    id: "stripping",
    label: "Stripping",
    contextMessages: 4,
    emptyState: () => ({}),
    panel: () => ({ kind: "none" }),
    buildPayload: async ({ systemPrompt, history }) => ({
      system: systemPrompt,
      messages: history.map(({ role, content }) => ({ role, content })),
      state: {},
      meta: {},
    }),
    afterTurn: async ({ reply }) => ({ state: {}, usage: null, ms: 0, reply: reply.split("<memory-close>")[0].trim() }),
  };

  const { agent } = agentWith({ provider: new Fenced(), strategy: stripping });
  const { text } = await agent.run("how is the start node given?");

  assert.equal(text, "Passed as a parameter.");
  assert.equal(agent.transcript.at(-1).content, "Passed as a parameter.");
  assert.doesNotMatch(agent.transcript.at(-1).content, /memory-close/);
});

test("a strategy that fails after the turn does not cost the reply", async () => {
  const breaking = {
    id: "breaking",
    label: "Breaking",
    contextMessages: 4,
    emptyState: () => ({}),
    panel: () => ({ kind: "none" }),
    buildPayload: async ({ systemPrompt, history }) => ({
      system: systemPrompt,
      messages: history.map(({ role, content }) => ({ role, content })),
      state: {},
      meta: {},
    }),
    afterTurn: async () => { throw new Error("afterTurn is down"); },
  };

  const { agent } = agentWith({ strategy: breaking });
  const { text } = await agent.run("still there?");
  assert.equal(text, "ok");
  assert.equal(agent.transcript.at(-1).content, "ok");
});


test("all five strategies answer a turn, and each reports its own overhead", async () => {
  const seen = [];

  for (const id of ["sliding", "summary", "facts", "memory", "full"]) {
    // The offline provider answers every prompt shape this app sends, so each
    // strategy can be driven end to end without a key. The profile store is
    // handed in rather than defaulted, so a test run never writes to the real
    // long-term memory in `data/memory/`.
    const { agent } = agentWith({
      provider: new FakeProvider({ delayMs: 0 }),
      strategy: id,
      strategyOptions: { profileStore: new MemoryProfileStore(), invariantStore: new MemoryInvariantStore() },
    });
    let meta;
    for (const word of ["one", "two", "three", "four"]) ({ meta } = await agent.run(word));

    assert.equal(meta.strategy.id, id);
    assert.ok(meta.strategy.label, `${id} has no label`);
    assert.ok(meta.strategy.note, `${id} said nothing about what it did`);
    assert.equal(typeof meta.tokens.input, "number", "the conversation's own counts are unchanged");
    // `meta.strategy` is this turn's bill; `usage` is the running one, and it
    // is kept apart from the conversation's own totals on purpose.
    seen.push({ id, calls: agent.usage.overheadCalls, tokens: agent.usage.overheadInputTokens });
    assert.equal(agent.usage.turnCount, 4);
  }

  const byId = Object.fromEntries(seen.map((s) => [s.id, s]));
  assert.equal(byId.sliding.calls, 0, "the cost floor pays for nothing");
  assert.equal(byId.full.calls, 0, "neither does the ceiling");
  assert.ok(byId.summary.tokens > 0, "summarization folded and did not report it");
  assert.ok(byId.facts.tokens > 0, "extraction ran and did not report it");
  // Facts extracts on every user message; summarization folds once per
  // half-window. Over four turns at a window of four that is four calls to one.
  assert.equal(byId.facts.calls, 4);
  assert.equal(byId.summary.calls, 1);
  // The layered one runs both schedules, so it pays both bills: four
  // extractions and the one fold.
  assert.equal(byId.memory.calls, 5);
});

test("an unknown strategy is refused the way an unknown provider would be", () => {
  assert.throws(() => agentWith({ strategy: "telepathy" }), /unknown context strategy/i);
  assert.throws(() => agentWith({ strategy: {} }), /buildPayload/);
});

test("switching strategy mid-conversation parks the old state rather than resetting it", async () => {
  const { agent } = agentWith({ provider: new FakeProvider({ delayMs: 0 }), strategy: "summary" });
  for (const word of ["one", "two", "three", "four"]) await agent.run(word);

  const folded = agent.panel();
  assert.equal(folded.kind, "summary");
  assert.ok(folded.text, "nothing was folded in");

  agent.strategy = "facts";
  const { meta } = await agent.run("five");
  assert.equal(meta.strategy.panel.kind, "facts");
  assert.equal(agent.panel().kind, "facts");

  // Switching back finds the summary exactly where it was left, not a blank.
  // The window is widened first so nothing folds on this turn — what is being
  // checked is that the old state survived, not that it kept growing.
  agent.strategy = "summary";
  agent.contextMessages = 20;
  const back = await agent.run("six");
  assert.equal(back.meta.strategy.panel.text, folded.text);
  assert.equal(back.meta.strategy.panel.covers, folded.covers);
});

test("a strategy that throws costs the turn its context, not the turn", async () => {
  const broken = {
    id: "summary",
    label: "Broken",
    contextMessages: 4,
    emptyState: () => ({}),
    panel: () => ({ kind: "none" }),
    async buildPayload() {
      throw new Error("strategy exploded");
    },
    async afterTurn({ state }) {
      return { state, usage: null, ms: 0 };
    },
  };

  const { agent, provider } = agentWith({ strategy: broken });
  const { text, meta } = await agent.run("hello");
  assert.equal(text, "ok");
  assert.equal(meta.strategy.degraded, true);
  assert.equal(provider.calls.at(-1).system, personas.helpful);
});

// ---- branching -------------------------------------------------------------

test("a fork replays the trunk and then diverges", async () => {
  const { agent } = agentWith({ strategy: "sliding", contextMessages: 10 });
  for (const word of ["one", "two"]) await agent.run(word);
  const forkPoint = agent.transcript.at(-1).id;

  const branch = await agent.fork({ fromMessageId: forkPoint, name: "what if" });
  await agent.activateBranch(branch.id);
  await agent.run("three on the fork");

  assert.deepEqual(
    agent.history(branch.id).map((m) => m.content),
    ["one", "ok", "two", "ok", "three on the fork", "ok"]
  );
  // The trunk never saw it.
  assert.deepEqual(agent.history("main").map((m) => m.content), ["one", "ok", "two", "ok"]);
  assert.equal(agent.branches.length, 2);
});

test("branches do not leak facts or summaries into each other", async () => {
  const provider = new FakeProvider({ delayMs: 0 });
  const { agent } = agentWith({ provider, strategy: "facts", contextMessages: 10 });

  for (const word of ["the port is 8477", "the database is Postgres 14"]) await agent.run(word);
  const forkPoint = agent.transcript.at(-1).id;
  const branch = await agent.fork({ fromMessageId: forkPoint, name: "alternative" });

  // Three turns down the fork…
  await agent.activateBranch(branch.id);
  for (const word of ["actually use MySQL", "and drop the cache", "and rename the service"]) {
    await agent.run(word);
  }
  const forkFacts = agent.panel(branch.id).facts.map((f) => f.value);

  // …and three more back on the trunk.
  await agent.activateBranch("main");
  for (const word of ["keep Postgres", "add a read replica", "and keep the cache"]) {
    await agent.run(word);
  }
  const trunkFacts = agent.panel("main").facts.map((f) => f.value);

  assert.ok(forkFacts.includes("actually use MySQL"));
  assert.ok(trunkFacts.includes("keep Postgres"));
  assert.ok(!trunkFacts.includes("actually use MySQL"), "the fork's facts reached the trunk");
  assert.ok(!forkFacts.includes("keep Postgres"), "the trunk's facts reached the fork");
  // Both inherited what was established before the fork.
  for (const facts of [forkFacts, trunkFacts]) assert.ok(facts.includes("the port is 8477"));

  // Switching back and forth changes nothing: the state belongs to the branch.
  await agent.activateBranch(branch.id);
  assert.deepEqual(agent.panel(branch.id).facts.map((f) => f.value), forkFacts);
});

test("main and the active branch cannot be deleted", async () => {
  const { agent } = agentWith({ strategy: "sliding" });
  await agent.run("one");
  const branch = await agent.fork({ fromMessageId: agent.transcript[0].id, name: "side" });

  await assert.rejects(() => agent.removeBranch("main"), /main branch cannot be deleted/);
  await agent.activateBranch(branch.id);
  await assert.rejects(() => agent.removeBranch(branch.id), /Switch away/);

  await agent.activateBranch("main");
  await agent.removeBranch(branch.id);
  assert.equal(agent.branches.length, 1);
});

test("a branch survives a reload, with its own strategy and its own state", async () => {
  const store = new MemoryStore();
  const provider = new FakeProvider({ delayMs: 0 });
  const first = new Agent({ provider, store, sessionId: SESSION, contextMessages: 10, strategy: "facts" });
  await first.run("the port is 8477");
  const branch = await first.fork({ fromMessageId: first.transcript[0].id, name: "side" });

  const resumed = await Agent.load({ provider, store, sessionId: SESSION });
  assert.equal(resumed.branchStrategy("main"), "facts");
  assert.deepEqual(
    resumed.panel("main").facts.map((f) => f.value),
    first.panel("main").facts.map((f) => f.value)
  );
  assert.ok(resumed.branches.some((b) => b.id === branch.id));
});

// ---- what earlier versions wrote -------------------------------------------

test("a Day 8 conversation — a flat array and nothing else — still loads", async () => {
  const store = new MemoryStore();
  await store.save(SESSION, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);

  const agent = await Agent.load({ provider: new StubProvider(), store, sessionId: SESSION });
  assert.deepEqual(agent.transcript.map((m) => m.content), ["hi", "hello"]);
  assert.equal(agent.branches.length, 1);
  assert.equal(agent.usage.totalInputTokens, 0);
  assert.equal(agent.usage.overheadCalls, 0);
});

test("a Day 9 file on disk keeps its summary, moved into the branch that owns it", async () => {
  // Exactly what the previous version wrote: a flat array with no ids, the
  // summary at the top level, and usage with the summarizer's three fields.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "first-agent-"));
  await fs.writeFile(
    path.join(dir, SESSION + ".json"),
    JSON.stringify({
      id: SESSION,
      title: "one",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      usage: {
        totalInputTokens: 812,
        totalOutputTokens: 145,
        totalCostUsd: 0.0015,
        turnCount: 2,
        summarizerInputTokens: 100,
        summarizerOutputTokens: 40,
        summarizerCostUsd: 0.0003,
      },
      summary: "## Facts about the user\n- the port is 8477",
      summarizedThrough: 2,
      summaryUpdatedAt: "2026-01-01T00:00:30.000Z",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "ok", tokens: { input: 400, output: 70 } },
        { role: "user", content: "two" },
        { role: "assistant", content: "ok", tokens: { input: 412, output: 75 } },
      ],
    }),
    "utf8"
  );

  const store = new JsonFileStore({ dir });
  const agent = await Agent.load({ provider: new StubProvider(), store, sessionId: SESSION });

  // The flat array became one chain, which is what it always was.
  assert.deepEqual(agent.transcript.map((m) => m.content), ["one", "ok", "two", "ok"]);
  assert.equal(agent.branches.length, 1);
  assert.equal(agent.branchStrategy("main"), "summary");

  // The summary is where the strategy that owns it looks for it.
  const panel = agent.panel("main");
  assert.equal(panel.kind, "summary");
  assert.match(panel.text, /port is 8477/);
  assert.equal(panel.covers, 2);

  // Day 9's `summarizer*` usage keys are the same numbers under this version's
  // names, not zeros.
  assert.equal(agent.usage.overheadInputTokens, 100);
  assert.equal(agent.usage.overheadCostUsd, 0.0003);
  assert.equal(agent.usage.totalInputTokens, 812);

  // And it carries on from there rather than starting over.
  await agent.run("three");
  assert.equal(agent.transcript.length, 6);
  await fs.rm(dir, { recursive: true, force: true });
});
