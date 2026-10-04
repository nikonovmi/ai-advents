import assert from "node:assert/strict";
import test from "node:test";

import { MemoryProfileStore } from "../store/profileStore.js";
import {
  exchangeStarts,
  foldTo,
  snapToUserMessage,
  takeLastExchanges,
  windowStart,
} from "./boundaries.js";
import { DEFAULT_STRATEGY, createStrategy } from "./index.js";
import { MemoryStrategy, summaryBlock } from "./memory.js";
import { MemoryInvariantStore } from "../store/invariantStore.js";

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
});

// ---- the rules the strategy has to keep ------------------------------------

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

  async summarize({ previousSummary, messages }) {
    const index = this.calls.length;
    this.calls.push({ previousSummary, messages });
    return {
      text: `summary ${index + 1}`,
      usage: { inputTokens: 100, outputTokens: 40 },
      model: "stub",
      ms: 1,
    };
  }
}

/** An extractor that returns nothing and records what it was shown. */
class StubExtractor {
  calls = [];

  async extract({ keys, stored, exchange }) {
    this.calls.push({ keys: keys ?? stored, exchange });
    return {
      ops: [],
      usage: { inputTokens: 60, outputTokens: 12 },
      model: "stub",
      ms: 1,
    };
  }
}

/** Wired with stubs so it touches neither a network nor a disk. */
function strategyFor(window) {
  return new MemoryStrategy({
    invariantStore: new MemoryInvariantStore(),
    contextMessages: window,
    profileStore: new MemoryProfileStore(),
    extractor: new StubExtractor(),
    summarizer: new StubSummarizer(),
  });
}

test("the payload opens on a user message, at both parities", async () => {
  const provider = new StubProvider();

  for (const length of [10, 11]) {
    const history = alternating(length);
    for (let window = 1; window <= 7; window++) {
      const strategy = strategyFor(window);
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
});

test("the strategy does not mutate the history it is given", async () => {
  const provider = new StubProvider();
  const history = alternating(11);
  const before = structuredClone(history);

  await strategyFor(4).buildPayload({
    history,
    systemPrompt: "persona",
    state: strategyFor(4).emptyState(),
    provider,
  });
  assert.deepEqual(history, before);
});

test("there is one strategy, it builds, and anything else is refused", () => {
  assert.equal(DEFAULT_STRATEGY, "memory");

  const strategy = createStrategy(DEFAULT_STRATEGY);
  assert.equal(strategy.id, DEFAULT_STRATEGY);
  assert.ok(strategy.label);
  assert.ok(strategy.description);

  // No argument means the only one there is, rather than a throw.
  assert.equal(createStrategy().id, DEFAULT_STRATEGY);
  assert.throws(() => createStrategy("telepathy"), /Unknown context strategy/);
  assert.throws(() => createStrategy("summary"), /Unknown context strategy/);
});
