import assert from "node:assert/strict";
import test from "node:test";

import {
  exchangeStarts,
  foldTo,
  snapToUserMessage,
  takeLastExchanges,
  windowStart,
} from "./boundaries.js";
import { FactsStrategy, applyOps, factsBlock } from "./facts.js";
import { FullHistoryStrategy } from "./fullHistory.js";
import { createStrategy, STRATEGY_IDS } from "./index.js";
import { SlidingWindowStrategy } from "./slidingWindow.js";
import { SummarizationStrategy, summaryBlock } from "./summarization.js";

/** `[u, a, u, a, …]` of the requested length. */
function alternating(length) {
  return Array.from({ length }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `m${i}`,
  }));
}

// ---- the two boundary rules ------------------------------------------------

test("the window opens on a user message at both parities", () => {
  // An even-length history ends on an assistant reply, an odd-length one on a
  // user message still waiting for it. Cropping by message count lands on an
  // assistant turn in about half of these combinations, and the API rejects
  // every one of those payloads.
  for (const length of [10, 11]) {
    const history = alternating(length);
    for (let turns = 1; turns <= 7; turns++) {
      const start = windowStart(history, turns);
      assert.equal(
        history[start].role,
        "user",
        `history of ${length} with a window of ${turns} opened on an assistant turn`
      );
    }
  }
});

test("a turn pair is never split across the boundary", () => {
  // One question, answered in two parts — the shape that pushes a naive
  // boundary onto the second half of a reply.
  const history = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1 part one" },
    { role: "assistant", content: "a1 part two" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "q3" },
    { role: "assistant", content: "a3" },
  ];

  assert.equal(windowStart(history, 2), 3);
  assert.equal(windowStart(history, 3), 0);
  for (let turns = 1; turns <= 5; turns++) {
    assert.equal(history[windowStart(history, turns)].role, "user");
  }
});

test("a history that opens with an assistant turn still produces a valid window", () => {
  const history = [
    { role: "assistant", content: "unprompted hello" },
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
  ];
  assert.equal(windowStart(history, 5), 1);
  // An edge of zero has nowhere earlier to snap back to, so it walks forward
  // rather than handing the API a payload it will refuse.
  assert.equal(snapToUserMessage(history, 0), 1);
  assert.equal(snapToUserMessage(history, 2), 1);
  assert.equal(snapToUserMessage(history, 3), 3);
});

test("takeLastExchanges hands back wire-shaped messages and where they started", () => {
  const history = alternating(6).map((m, i) => ({ ...m, id: `m${i}`, tokens: { sent: i } }));
  const { start, messages } = takeLastExchanges(history, 2);
  assert.equal(start, 2);
  assert.deepEqual(Object.keys(messages[0]), ["role", "content"]);
  assert.equal(messages.length, 4);
});

test("folding moves the edge to an exchange boundary and never past the last one", () => {
  const history = alternating(12); // six complete exchanges

  assert.equal(foldTo(history, 0, 3), 6);
  assert.equal(history[6].role, "user");
  assert.equal(foldTo(history, 6, 3), 10);

  // The turn being answered is never folded away, whatever is asked for.
  assert.equal(foldTo(history, 0, 99), 10);
  assert.equal(foldTo(history, 0, 0), 0);
  assert.deepEqual(exchangeStarts(history, 6), [6, 8, 10]);
});

test("an auxiliary block omits its header entirely when there is nothing in it", () => {
  assert.equal(summaryBlock(null), "");
  assert.equal(summaryBlock("   "), "");
  assert.match(summaryBlock("## Facts\n- x"), /<conversation_summary>[\s\S]*## Facts/);

  assert.equal(factsBlock({}), "");
  assert.equal(factsBlock(undefined), "");
  assert.match(factsBlock({ "goal.x": { value: "ship it" } }), /<known_facts>[\s\S]*goal\.x: ship it/);
});

// ---- every strategy, same rules --------------------------------------------

/** A provider that answers instantly and remembers what it was asked. */
class StubProvider {
  calls = [];

  async complete({ system, messages }) {
    this.calls.push({ system, messages });
    return {
      text: "[]",
      model: "stub",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }

  async countTokens({ messages }) {
    return { inputTokens: messages.length };
  }
}

/** A summarizer that records its arguments instead of calling a model. */
class StubSummarizer {
  calls = [];
  #fail;

  constructor({ failOn = [] } = {}) {
    this.#fail = new Set(failOn);
  }

  async summarize({ previousSummary, messages }) {
    const index = this.calls.length;
    this.calls.push({ previousSummary, messages });
    if (this.#fail.has(index)) throw new Error("summarizer is down");
    return {
      text: `summary ${index + 1}`,
      usage: { inputTokens: 100, outputTokens: 40 },
      model: "stub",
      ms: 1,
    };
  }
}

/** An extractor that returns a scripted patch and records what it was shown. */
class StubExtractor {
  calls = [];
  #scripted;
  #fail;

  constructor({ ops = [], fail = false } = {}) {
    this.#scripted = ops;
    this.#fail = fail;
  }

  async extract({ keys, exchange }) {
    const index = this.calls.length;
    this.calls.push({ keys, exchange });
    if (this.#fail) throw new Error("extractor is down");
    return {
      ops: Array.isArray(this.#scripted[index]) ? this.#scripted[index] : [],
      usage: { inputTokens: 60, outputTokens: 12 },
      model: "stub",
      ms: 1,
    };
  }
}

/** One of each, wired with stubs so none of them touches a network. */
function everyStrategy(window) {
  return [
    new SlidingWindowStrategy({ contextMessages: window }),
    new SummarizationStrategy({ contextMessages: window, summarizer: new StubSummarizer() }),
    new FactsStrategy({ contextMessages: window, extractor: new StubExtractor() }),
    new FullHistoryStrategy({ contextMessages: window }),
  ];
}

test("every strategy's payload opens on a user message, at both parities", async () => {
  const provider = new StubProvider();

  for (const length of [10, 11]) {
    const history = alternating(length);
    for (let window = 1; window <= 7; window++) {
      for (const strategy of everyStrategy(window)) {
        const built = await strategy.buildPayload({
          history,
          systemPrompt: "persona",
          state: strategy.emptyState(),
          provider,
        });
        assert.ok(built.messages.length, `${strategy.id} sent nothing`);
        assert.equal(
          built.messages[0].role,
          "user",
          `${strategy.id} opened on an assistant turn (history ${length}, window ${window})`
        );
        // And nothing but `{ role, content }` reaches a provider.
        for (const message of built.messages) {
          assert.deepEqual(Object.keys(message).sort(), ["content", "role"]);
        }
      }
    }
  }
});

test("no strategy mutates the history it is given", async () => {
  const provider = new StubProvider();
  const history = alternating(11);
  const before = structuredClone(history);

  for (const strategy of everyStrategy(4)) {
    await strategy.buildPayload({
      history,
      systemPrompt: "persona",
      state: strategy.emptyState(),
      provider,
    });
  }
  assert.deepEqual(history, before);
});

test("the registry knows exactly four strategies and builds each one", () => {
  assert.deepEqual(STRATEGY_IDS, ["sliding", "summary", "facts", "full"]);
  for (const id of STRATEGY_IDS) {
    const strategy = createStrategy(id);
    assert.equal(strategy.id, id);
    assert.ok(strategy.label);
    assert.ok(strategy.description);
  }
  assert.throws(() => createStrategy("telepathy"), /Unknown context strategy/);
});

// ---- summarization ---------------------------------------------------------

/** Drive a strategy over a scripted conversation, as the Agent would. */
async function converse(strategy, words, { provider = new StubProvider(), from } = {}) {
  const history = from ? [...from.history] : [];
  let state = from ? from.state : strategy.emptyState();
  const turns = [];

  for (const word of words) {
    history.push({ role: "user", content: word });
    const built = await strategy.buildPayload({
      history,
      systemPrompt: "persona",
      state,
      provider,
    });
    history.push({ role: "assistant", content: "ok" });
    const after = await strategy.afterTurn({
      history,
      state: built.state,
      provider,
      userMessage: word,
      reply: "ok",
    });
    state = after.state;
    turns.push(built);
  }

  return { history, state, turns };
}

test("summarization fires at the high-water mark and folds half the window", async () => {
  const summarizer = new StubSummarizer();
  const strategy = new SummarizationStrategy({ contextMessages: 4, summarizer });

  const { turns } = await converse(strategy, ["one", "two", "three", "four"]);

  assert.equal(summarizer.calls.length, 1, "three exchanges is under the mark of four");
  assert.deepEqual(
    summarizer.calls[0].messages.map((m) => m.content),
    ["one", "ok", "two", "ok"]
  );
  assert.equal(turns.at(-1).meta.foldedExchanges, 2);
  assert.deepEqual(turns.at(-1).messages.map((m) => m.content), ["three", "ok", "four"]);
  assert.match(turns.at(-1).meta.note, /folded 2 exchanges/);
});

test("the summary edge and the verbatim edge always touch", async () => {
  const strategy = new SummarizationStrategy({ contextMessages: 4, summarizer: new StubSummarizer() });
  const { turns, history } = await converse(
    strategy,
    ["one", "two", "three", "four", "five", "six", "seven", "eight"]
  );

  let sent = 0;
  for (const [i, built] of turns.entries()) {
    // Every stored message is either in the summary or on the wire, and never
    // in neither: the messages sent plus the messages folded in account for
    // the whole history as it stood on that turn.
    sent = built.messages.length;
    assert.equal(
      built.meta.droppedMessages + sent,
      i * 2 + 1,
      `turn ${i + 1} left messages in neither zone`
    );
  }
  assert.equal(history.length, 16);
});

test("summarization is incremental — each call sees only the newly folded exchanges", async () => {
  const summarizer = new StubSummarizer();
  const strategy = new SummarizationStrategy({ contextMessages: 4, summarizer });
  const { state, turns } = await converse(strategy, ["one", "two", "three", "four", "five", "six"]);

  assert.equal(summarizer.calls.length, 2);
  assert.equal(summarizer.calls[0].previousSummary, null);
  assert.equal(summarizer.calls[1].previousSummary, "summary 1");
  assert.deepEqual(
    summarizer.calls[1].messages.map((m) => m.content),
    ["three", "ok", "four", "ok"]
  );
  assert.equal(state.summary, "summary 2");
  assert.equal(state.summarizedThrough, 8);

  // The summary is in the system prompt and nowhere else.
  const last = turns.at(-1);
  assert.match(last.system, /<conversation_summary>[\s\S]*summary 2/);
  for (const message of last.messages) assert.doesNotMatch(message.content, /conversation_summary/);
  assert.deepEqual(last.messages.map((m) => m.content), ["five", "ok", "six"]);
});

test("summarization failure is non-fatal and the fold is retried", async () => {
  const summarizer = new StubSummarizer({ failOn: [1] });
  const strategy = new SummarizationStrategy({ contextMessages: 4, summarizer });
  const { state, turns, history } = await converse(
    strategy,
    ["one", "two", "three", "four", "five", "six"]
  );

  assert.equal(state.summary, "summary 1", "the previous summary is kept");
  assert.equal(state.summarizedThrough, 4, "the edge does not advance");
  assert.equal(turns.at(-1).meta.foldedThisTurn, false);
  // Nothing was lost: the exchanges that failed to fold are still verbatim.
  assert.equal(turns.at(-1).meta.droppedMessages, 4);

  // The next turn retries the fold that failed, over exactly the same
  // exchanges — nothing was lost, it was only postponed.
  const resumed = await converse(strategy, ["seven"], { from: { history, state } });
  assert.deepEqual(
    summarizer.calls.at(-1).messages.map((m) => m.content),
    ["three", "ok", "four", "ok"]
  );
  assert.equal(resumed.state.summarizedThrough, 8);
});

test("a summary edge copied from a longer branch is clamped, not trusted", async () => {
  const strategy = new SummarizationStrategy({ contextMessages: 10, summarizer: new StubSummarizer() });
  const history = alternating(4);
  const built = await strategy.buildPayload({
    history,
    systemPrompt: "persona",
    // An edge from a parent branch that had twenty messages on it.
    state: { summary: "inherited", summarizedThrough: 20, summaryUpdatedAt: null },
    provider: new StubProvider(),
  });
  assert.equal(built.messages.length, 0 + history.length - built.meta.droppedMessages);
  assert.ok(built.meta.droppedMessages <= history.length);
});

// ---- facts -----------------------------------------------------------------

test("the extractor is only ever shown the keys and the latest exchange", async () => {
  const extractor = new StubExtractor({
    ops: [[{ op: "set", key: "goal", value: "migrate billing off Heroku by Q1" }], [], []],
  });
  const strategy = new FactsStrategy({ contextMessages: 10, extractor });
  await converse(strategy, ["first", "second", "third"]);

  // Never the whole conversation: a regenerative prompt is what makes a model
  // silently drop the facts it did not restate.
  for (const call of extractor.calls) {
    assert.ok(call.exchange.length <= 2, "the extractor saw more than one exchange");
  }
  assert.deepEqual(extractor.calls[0].keys, []);
  assert.deepEqual(extractor.calls[1].keys, ["goal"]);
  assert.deepEqual(extractor.calls[1].exchange.map((m) => m.content), ["ok", "second"]);
});

test("a fact block reaches the system prompt and never the messages", async () => {
  const extractor = new StubExtractor({
    ops: [[{ op: "set", key: "constraint.database", value: "Postgres 14, port 8477" }]],
  });
  const strategy = new FactsStrategy({ contextMessages: 10, extractor });
  const { turns } = await converse(strategy, ["the database is Postgres 14 on port 8477"]);

  assert.match(turns[0].system, /<known_facts>[\s\S]*constraint\.database: Postgres 14, port 8477/);
  for (const message of turns[0].messages) assert.doesNotMatch(message.content, /known_facts/);
  assert.equal(turns[0].meta.note, "1 fact set");
  assert.equal(turns[0].meta.overheadCalls, 1);
});

test("a reversal overwrites the fact and keeps what it replaced", () => {
  let facts = applyOps({}, [{ op: "set", key: "preference.tooling", value: "Kubernetes is fine" }], { turn: 1 }).facts;
  facts = applyOps(facts, [{ op: "set", key: "preference.tooling", value: "never suggest Kubernetes" }], { turn: 6 }).facts;

  assert.equal(facts["preference.tooling"].value, "never suggest Kubernetes");
  assert.deepEqual(facts["preference.tooling"].previous, ["Kubernetes is fine"]);
  assert.equal(facts["preference.tooling"].turn, 6);

  // Only the last three superseded values are worth keeping.
  for (const value of ["a", "b", "c", "d"]) {
    facts = applyOps(facts, [{ op: "set", key: "preference.tooling", value }], { turn: 7 }).facts;
  }
  // The three values immediately before the current one, oldest first.
  assert.equal(facts["preference.tooling"].value, "d");
  assert.deepEqual(facts["preference.tooling"].previous, ["a", "b", "c"]);
});

test("malformed operations are discarded one at a time, not in a batch", () => {
  const { facts, set, discarded } = applyOps(
    { "goal.keep": { value: "already here", updatedAt: "2026-01-01", turn: 1, previous: [] } },
    [
      { op: "set", key: "constraint.port", value: "8477" },
      { op: "set", key: "Random.Key", value: "wrong namespace" },
      { op: "set", key: "goal.blank", value: "   " },
      { op: "nudge", key: "goal.keep", value: "unknown verb" },
      "not an object",
      { op: "delete", key: "goal.keep" },
    ],
    { turn: 3 }
  );

  assert.deepEqual(set, ["constraint.port"]);
  assert.equal(discarded, 4);
  assert.equal(facts["constraint.port"].value, "8477");
  assert.ok(!("goal.keep" in facts), "an explicit delete still applies");
});

test("the store is capped and evicts the least recently updated", () => {
  let facts = {};
  for (let i = 0; i < 5; i++) {
    facts = applyOps(facts, [{ op: "set", key: `goal.g${i}`, value: `v${i}` }], {
      turn: i,
      maxFacts: 3,
    }).facts;
    // Distinct timestamps: the eviction order is by update time.
    for (const key of Object.keys(facts)) {
      facts[key] = { ...facts[key], updatedAt: `2026-01-0${Number(key.slice(-1)) + 1}` };
    }
  }
  assert.deepEqual(Object.keys(facts).sort(), ["goal.g2", "goal.g3", "goal.g4"]);
});

test("a set that changes nothing is not a change", () => {
  const first = applyOps({}, [{ op: "set", key: "goal", value: "ship it" }], { turn: 1 });
  const again = applyOps(first.facts, [{ op: "set", key: "goal", value: "ship it" }], { turn: 2 });
  assert.deepEqual(again.set, []);
  assert.equal(again.facts.goal.turn, 1, "the timestamp that drives eviction was not touched");
});

test("extraction failure keeps the facts and answers the turn anyway", async () => {
  const strategy = new FactsStrategy({
    contextMessages: 10,
    extractor: new StubExtractor({ fail: true }),
  });
  const built = await strategy.buildPayload({
    history: [
      { role: "user", content: "we are shipping it" },
      { role: "assistant", content: "noted" },
      { role: "user", content: "hello" },
    ],
    systemPrompt: "persona",
    state: { facts: { goal: { value: "ship it", updatedAt: null, turn: 1, previous: [] } } },
    provider: new StubProvider(),
  });

  assert.match(built.system, /goal: ship it/);
  assert.equal(built.meta.note, "extraction failed — existing facts kept");
  assert.deepEqual(built.messages.map((m) => m.content), ["we are shipping it", "noted", "hello"]);
});

test("facts established after the fork point do not come along with the fork", async () => {
  const extractor = new StubExtractor();
  const strategy = new FactsStrategy({ contextMessages: 10, extractor });

  // A state copied from a branch that went on for four more turns. Only what
  // was true at the fork point belongs to the branch that forked there.
  const inherited = {
    facts: {
      "constraint.port": { value: "8477", updatedAt: null, turn: 1, previous: [] },
      "decision.database": { value: "MySQL after all", updatedAt: null, turn: 4, previous: [] },
    },
  };

  const built = await strategy.buildPayload({
    // Two exchanges on this branch, and a third being asked now.
    history: [
      { role: "user", content: "the port is 8477" },
      { role: "assistant", content: "noted" },
      { role: "user", content: "and the plan?" },
      { role: "assistant", content: "noted" },
      { role: "user", content: "go on" },
    ],
    systemPrompt: "persona",
    state: inherited,
    provider: new StubProvider(),
  });

  assert.match(built.system, /constraint\.port: 8477/);
  assert.doesNotMatch(built.system, /MySQL/, "a fact from four turns down the parent leaked in");
  assert.equal(strategy.panel(inherited, { turns: 2 }).facts.length, 1);
  // Asked about the branch it actually came from, both are still there.
  assert.equal(strategy.panel(inherited, { turns: 6 }).facts.length, 2);
});

test("the panel groups facts by namespace and shows what a key used to say", () => {
  const strategy = new FactsStrategy();
  const facts = applyOps(
    applyOps({}, [{ op: "set", key: "preference.tooling", value: "Kubernetes is fine" }], { turn: 1 }).facts,
    [
      { op: "set", key: "preference.tooling", value: "never suggest Kubernetes" },
      { op: "set", key: "goal", value: "migrate off Heroku" },
    ],
    { turn: 6 }
  ).facts;

  const panel = strategy.panel({ facts, turn: 6 });
  assert.equal(panel.kind, "facts");
  assert.deepEqual(panel.facts.map((f) => f.key), ["goal", "preference.tooling"]);
  assert.deepEqual(panel.facts[1].previous, ["Kubernetes is fine"]);
  assert.equal(panel.facts[0].namespace, "goal");
});

// ---- the two that do nothing ------------------------------------------------

test("sliding and full report no overhead and keep no state", async () => {
  const provider = new StubProvider();
  const history = alternating(11);

  const sliding = await new SlidingWindowStrategy({ contextMessages: 2 }).buildPayload({
    history,
    systemPrompt: "persona",
    state: {},
    provider,
  });
  assert.equal(sliding.system, "persona");
  assert.equal(sliding.meta.overheadCalls, 0);
  // Two exchanges out of an odd-length history: a question, its answer, and
  // the question still waiting for one.
  assert.equal(sliding.messages.length, 3);
  assert.deepEqual(sliding.state, {});

  const full = await new FullHistoryStrategy().buildPayload({
    history,
    systemPrompt: "persona",
    state: {},
    provider,
  });
  assert.equal(full.messages.length, 11);
  assert.equal(full.meta.overheadTokens, 0);
  assert.equal(provider.calls.length, 0, "neither of them called a model");
});
