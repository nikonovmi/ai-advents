import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Agent } from "./agent.js";
import { agentFor } from "./agents.js";
import { FakeProvider } from "./llm/anthropic.js";
import { forkFrom } from "./store/conversationStore.js";
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


test("the strategy answers a turn, and reports its own overhead", async () => {
  // The offline provider answers every prompt shape this app sends, so the
  // strategy can be driven end to end without a key. The profile store is
  // handed in rather than defaulted, so a test run never writes to the real
  // long-term memory in `data/memory/`.
  const { agent } = agentWith({
    provider: new FakeProvider({ delayMs: 0 }),
    strategyOptions: { profileStore: new MemoryProfileStore(), invariantStore: new MemoryInvariantStore() },
  });
  let meta;
  for (const word of ["one", "two", "three", "four"]) ({ meta } = await agent.run(word));

  assert.equal(meta.strategy.id, "memory");
  assert.ok(meta.strategy.label, "the strategy has no label");
  assert.ok(meta.strategy.note, "the strategy said nothing about what it did");
  assert.equal(typeof meta.tokens.input, "number", "the conversation's own counts are unchanged");
  assert.equal(agent.usage.turnCount, 4);

  // `meta.strategy` is this turn's bill; `usage` is the running one, and it is
  // kept apart from the conversation's own totals on purpose. Extraction runs
  // on every user message and the fold once per half-window, so over four turns
  // at a window of four that is four calls plus one.
  assert.ok(agent.usage.overheadInputTokens > 0, "it ran and did not report it");
  assert.equal(agent.usage.overheadCalls, 5);
});

/**
 * The page hangs its fork button on these two ids and uses them to address the
 * rows it has just drawn. Renaming the field they arrive under is a silent
 * break: the turn is answered and saved, and only the browser falls over — which
 * it then reports as a network failure. Hence a test on the field name itself.
 */
test("a turn names the two messages it produced, by id", async () => {
  const { agent } = agentWith();
  const { meta } = await agent.run("hello");

  const [user, reply] = agent.transcript;
  assert.deepEqual(meta.turn, { userMessageId: user.id, replyMessageId: reply.id });
  assert.equal(user.role, "user");
  assert.equal(reply.role, "assistant");

  // And the ids keep going up across turns rather than restarting.
  const second = await agent.run("again");
  assert.equal(second.meta.turn.userMessageId, agent.transcript[2].id);
  assert.notEqual(second.meta.turn.userMessageId, meta.turn.userMessageId);
});

test("an unknown strategy is refused the way an unknown provider would be", () => {
  assert.throws(() => agentWith({ strategy: "telepathy" }), /unknown context strategy/i);
  assert.throws(() => agentWith({ strategy: {} }), /buildPayload/);
});

test("a strategy that throws costs the turn its context, not the turn", async () => {
  const broken = {
    id: "memory",
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
  assert.equal(provider.calls.at(-1).system, agentFor("first-agent").systemPrompt);
});

// ---- forking ---------------------------------------------------------------

const FORK = "22222222-2222-4222-8222-222222222222";

/**
 * A fork, exactly as the route does it: read the record, split it at a message,
 * and write the halves out under a new id. The Agent is not involved, because
 * a fork is a second conversation and an Agent is one conversation.
 */
async function forkInto(store, sessionId, forkId, fromMessageId) {
  const record = await store.load(sessionId);
  const fork = forkFrom(record, fromMessageId);
  await store.save(forkId, fork.messages, undefined, {
    memory: fork.memory,
    forkedFrom: fork.forkedFrom,
    project: record.project,
  });
}

test("a fork replays the conversation up to the message and then diverges", async () => {
  const store = new MemoryStore();
  const provider = new StubProvider();
  const options = { provider, store, contextMessages: 10, strategyOptions: { profileStore: new MemoryProfileStore(), invariantStore: new MemoryInvariantStore() }, };

  const trunk = new Agent({ ...options, sessionId: SESSION });
  for (const word of ["one", "two"]) await trunk.run(word);
  const forkPoint = trunk.transcript.at(-1).id;

  await forkInto(store, SESSION, FORK, forkPoint);
  const fork = await Agent.load({ ...options, sessionId: FORK });
  await fork.run("three on the fork");

  assert.deepEqual(
    fork.transcript.map((m) => m.content),
    ["one", "ok", "two", "ok", "three on the fork", "ok"]
  );
  assert.deepEqual(fork.forkedFrom, { conversationId: SESSION, messageId: forkPoint });

  // The trunk never saw it, and is not reloaded to find out.
  const reloaded = await Agent.load({ ...options, sessionId: SESSION });
  assert.deepEqual(reloaded.transcript.map((m) => m.content), ["one", "ok", "two", "ok"]);
});

test("a fork is taken at a message, not at the end", async () => {
  const store = new MemoryStore();
  const provider = new StubProvider();
  const options = { provider, store, contextMessages: 10, strategyOptions: { profileStore: new MemoryProfileStore(), invariantStore: new MemoryInvariantStore() }, };

  const trunk = new Agent({ ...options, sessionId: SESSION });
  for (const word of ["one", "two", "three"]) await trunk.run(word);
  const middle = trunk.transcript[1].id;

  await forkInto(store, SESSION, FORK, middle);
  const fork = await Agent.load({ ...options, sessionId: FORK });
  assert.deepEqual(fork.transcript.map((m) => m.content), ["one", "ok"]);
});

test("forking an unknown message is refused rather than silently emptying the fork", async () => {
  const store = new MemoryStore();
  const agent = new Agent({ provider: new StubProvider(), store, sessionId: SESSION });
  await agent.run("one");

  const record = await store.load(SESSION);
  assert.throws(() => forkFrom(record, "m99"), /No such message/);
});

test("two conversations do not leak what they learned into each other", async () => {
  const store = new MemoryStore();
  const provider = new FakeProvider({ delayMs: 0 });
  const options = { provider, store, contextMessages: 10, strategyOptions: { profileStore: new MemoryProfileStore(), invariantStore: new MemoryInvariantStore() }, };

  const trunk = new Agent({ ...options, sessionId: SESSION });
  for (const word of ["the port is 8477", "the database is Postgres 14"]) await trunk.run(word);
  const forkPoint = trunk.transcript.at(-1).id;
  await forkInto(store, SESSION, FORK, forkPoint);

  // Three turns down the fork…
  const fork = await Agent.load({ ...options, sessionId: FORK });
  for (const word of ["actually use MySQL", "and drop the cache", "and rename the service"]) {
    await fork.run(word);
  }
  const forkRows = fork.panel().task.map((row) => row.value);

  // …and three more on the trunk, which is a different Agent on a different id.
  for (const word of ["keep Postgres", "add a read replica", "and keep the cache"]) {
    await trunk.run(word);
  }
  const trunkRows = trunk.panel().task.map((row) => row.value);

  assert.ok(forkRows.includes("actually use MySQL"));
  assert.ok(trunkRows.includes("keep Postgres"));
  assert.ok(!trunkRows.includes("actually use MySQL"), "the fork's memory reached the trunk");
  assert.ok(!forkRows.includes("keep Postgres"), "the trunk's memory reached the fork");
  // Both inherited what was established before the fork.
  for (const rows of [forkRows, trunkRows]) assert.ok(rows.includes("the port is 8477"));

  // And the copy survives a reload rather than being a live view of the parent.
  const reopened = await Agent.load({ ...options, sessionId: FORK });
  assert.deepEqual(reopened.panel().task.map((row) => row.value), forkRows);
});

test("a conversation survives a reload, with its own memory state", async () => {
  const store = new MemoryStore();
  const provider = new FakeProvider({ delayMs: 0 });
  const options = { provider, store, sessionId: SESSION, contextMessages: 10, strategyOptions: { profileStore: new MemoryProfileStore(), invariantStore: new MemoryInvariantStore() }, };

  const first = new Agent(options);
  await first.run("the port is 8477");

  const resumed = await Agent.load(options);
  assert.deepEqual(
    resumed.panel().task.map((row) => row.value),
    first.panel().task.map((row) => row.value)
  );
  assert.deepEqual(resumed.transcript.map((m) => m.content), first.transcript.map((m) => m.content));
});

test("a Day 8 conversation — a flat array and nothing else — still loads", async () => {
  const store = new MemoryStore();
  await store.save(SESSION, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);

  const agent = await Agent.load({ provider: new StubProvider(), store, sessionId: SESSION });
  assert.deepEqual(agent.transcript.map((m) => m.content), ["hi", "hello"]);
  assert.equal(agent.usage.totalInputTokens, 0);
  assert.equal(agent.usage.overheadCalls, 0);
});

test("a Day 9 file on disk still loads, and its usage keys are read under this version's names", async () => {
  // Exactly what that version wrote: a flat array with no ids, a summary at the
  // top level, and usage with the summarizer's three fields. The summary itself
  // has nowhere to go any more — the strategy that owned it is gone — but the
  // conversation and its bill must still come back.
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

  // The flat array is still a flat conversation, which is what it always was.
  assert.deepEqual(agent.transcript.map((m) => m.content), ["one", "ok", "two", "ok"]);

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
