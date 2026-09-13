import assert from "node:assert/strict";
import test from "node:test";

import { Agent, foldTo, personas, summaryBlock, windowStart } from "./agent.js";
import { MemoryStore } from "./store/memoryStore.js";

const SESSION = "11111111-1111-4111-8111-111111111111";

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
  // Whatever the window, the first message sent is the question, never an
  // answer to a question that is no longer there.
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
});

test("folding moves the edge to an exchange boundary and never past the last one", () => {
  const history = alternating(12); // six complete exchanges

  // Fold the oldest three of six: the edge lands on u4, at index 6.
  assert.equal(foldTo(history, 0, 3), 6);
  assert.equal(history[6].role, "user");
  // …and again, from there: the oldest three of the remaining three would be
  // all of them, so it stops one short and leaves an exchange to answer with.
  assert.equal(foldTo(history, 6, 3), 10);

  // The turn being answered is never folded away, whatever is asked for.
  assert.equal(foldTo(history, 0, 99), 10);
  assert.equal(foldTo(history, 0, 0), 0);
});

test("summaryBlock omits the header entirely when there is no summary", () => {
  assert.equal(summaryBlock(null), "");
  assert.equal(summaryBlock("   "), "");
  assert.match(summaryBlock("## Facts\n- x"), /<conversation_summary>[\s\S]*## Facts/);
});

// ---- compression -----------------------------------------------------------

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

/** A window of 4 exchanges, so the fold size works out at 2. */
function agentWith(summarizer, options = {}) {
  const provider = new StubProvider();
  const agent = new Agent({
    provider,
    store: new MemoryStore(),
    sessionId: SESSION,
    contextMessages: 4,
    summarizer,
    ...options,
  });
  return { agent, provider };
}

test("the fold size is half the window unless told otherwise", () => {
  const { agent } = agentWith(new StubSummarizer());
  assert.equal(agent.foldSize, 2);
  agent.contextMessages = 9;
  assert.equal(agent.foldSize, 4);
  agent.summarizeEvery = 3;
  assert.equal(agent.foldSize, 3);
});

test("compression fires at the high-water mark, not when messages fall out", async () => {
  const summarizer = new StubSummarizer();
  const { agent, provider } = agentWith(summarizer);

  await agent.run("one");
  await agent.run("two");
  await agent.run("three");
  assert.equal(summarizer.calls.length, 0, "three exchanges is under the mark of four");
  assert.equal(agent.droppedCount, 0, "and nothing has been dropped to wait around");

  // The fourth user message reaches the mark, so the oldest two exchanges fold
  // in before this turn is answered.
  const { meta } = await agent.run("four");
  assert.equal(summarizer.calls.length, 1);
  assert.deepEqual(
    summarizer.calls[0].messages.map((m) => m.content),
    ["one", "ok", "two", "ok"]
  );
  assert.equal(meta.tokens.compression.foldedExchanges, 2);
  assert.deepEqual(
    provider.calls.at(-1).messages.map((m) => m.content),
    ["three", "ok", "four"]
  );
});

test("the summary edge and the verbatim edge always touch", async () => {
  const summarizer = new StubSummarizer();
  const { agent, provider } = agentWith(summarizer);

  for (const word of ["one", "two", "three", "four", "five", "six", "seven", "eight"]) {
    const { meta } = await agent.run(word);
    // The whole point of folding at the mark: every stored message is either
    // in the summary or on the wire, and never in neither.
    assert.equal(
      meta.window.droppedCount,
      meta.window.summarizedThrough,
      `turn "${word}" left ${meta.window.droppedCount - meta.window.summarizedThrough} messages invisible`
    );
    // `storedMessages` counts the reply too, which was not in the payload.
    const sent = provider.calls.at(-1).messages.length;
    assert.equal(sent, meta.window.storedMessages - meta.window.summarizedThrough - 1);
  }
});

test("compression is incremental — each call sees only the newly folded exchanges", async () => {
  const summarizer = new StubSummarizer();
  const { agent } = agentWith(summarizer);

  for (const word of ["one", "two", "three", "four", "five", "six"]) await agent.run(word);

  assert.equal(summarizer.calls.length, 2);
  assert.equal(summarizer.calls[0].previousSummary, null);
  assert.deepEqual(
    summarizer.calls[0].messages.map((m) => m.content),
    ["one", "ok", "two", "ok"]
  );
  // The second call folds into the first rather than starting over: the whole
  // point of tracking how far the summary reaches.
  assert.equal(summarizer.calls[1].previousSummary, "summary 1");
  assert.deepEqual(
    summarizer.calls[1].messages.map((m) => m.content),
    ["three", "ok", "four", "ok"]
  );
  assert.equal(agent.summary, "summary 2");
  assert.equal(agent.summarizedThrough, 8);
});

test("the summary is injected into the system prompt, never into the messages", async () => {
  const summarizer = new StubSummarizer();
  const { agent, provider } = agentWith(summarizer);

  let meta;
  for (const word of ["one", "two", "three", "four", "five", "six"]) {
    ({ meta } = await agent.run(word));
  }

  const call = provider.calls.at(-1);
  assert.match(call.system, /<conversation_summary>[\s\S]*summary 2/);
  for (const message of call.messages) {
    assert.doesNotMatch(message.content, /conversation_summary/);
  }
  // Zone 2 is everything since the fold: one whole exchange, plus the question.
  assert.deepEqual(
    call.messages.map((m) => m.content),
    ["five", "ok", "six"]
  );
  assert.equal(meta.tokens.compression.summarizedMessages, 8);
  assert.equal(meta.tokens.compression.compressedThisTurn, true);
  assert.equal(meta.tokens.compression.summarizerTokens, 140);
});

test("compression failure is non-fatal and the fold is retried", async () => {
  const summarizer = new StubSummarizer({ failOn: [1] });
  const { agent } = agentWith(summarizer);

  for (const word of ["one", "two", "three", "four"]) await agent.run(word);
  assert.equal(agent.summary, "summary 1");
  assert.equal(agent.summarizedThrough, 4);

  // The next fold throws. The turn must still be answered.
  await agent.run("five");
  const { text, meta } = await agent.run("six");
  assert.equal(text, "ok");
  assert.equal(agent.summary, "summary 1", "the previous summary is kept");
  assert.equal(agent.summarizedThrough, 4, "the edge does not advance");
  assert.equal(meta.tokens.compression.compressedThisTurn, false);

  // Nothing was lost: the exchanges that failed to fold are still being sent
  // verbatim, so the model can still see them while the retry waits.
  assert.equal(agent.droppedCount, agent.summarizedThrough);

  await agent.run("seven");
  assert.deepEqual(
    summarizer.calls.at(-1).messages.map((m) => m.content),
    ["three", "ok", "four", "ok"]
  );
});

test("compressionEnabled false behaves exactly like plain cropping", async () => {
  const provider = new StubProvider();
  const summarizer = new StubSummarizer();
  const agent = new Agent({
    provider,
    store: new MemoryStore(),
    sessionId: SESSION,
    contextMessages: 4,
    compressionEnabled: false,
    summarizer,
  });

  for (const word of ["one", "two", "three", "four", "five", "six"]) await agent.run(word);

  assert.equal(summarizer.calls.length, 0, "nothing is summarised");
  assert.equal(agent.summary, null);
  for (const call of provider.calls) {
    assert.equal(call.system, personas.helpful, "no summary block is sent");
  }
});

test("the summary survives a reload from the store", async () => {
  const store = new MemoryStore();
  const provider = new StubProvider();
  const summarizer = new StubSummarizer();
  const options = { contextMessages: 4, summarizer };

  const first = new Agent({ provider, store, sessionId: SESSION, ...options });
  for (const word of ["one", "two", "three", "four"]) await first.run(word);
  assert.equal(first.summary, "summary 1");

  const resumed = await Agent.load({ provider, store, sessionId: SESSION, ...options });
  assert.equal(resumed.summary, "summary 1");
  assert.equal(resumed.summarizedThrough, 4);
});

test("a record written before compression existed still loads", async () => {
  const store = new MemoryStore();
  // Exactly the shape the previous version wrote: no summary keys at all, and
  // a usage object missing the three summarizer fields.
  await store.save(SESSION, [{ role: "user", content: "hi" }], {
    totalInputTokens: 12,
    totalOutputTokens: 3,
    totalCostUsd: 0.001,
    turnCount: 1,
  });

  const agent = await Agent.load({
    provider: new StubProvider(),
    store,
    sessionId: SESSION,
  });
  assert.equal(agent.summary, null);
  assert.equal(agent.summarizedThrough, 0);
  assert.equal(agent.usage.totalInputTokens, 12);
  assert.equal(agent.usage.summarizerInputTokens, 0);
  assert.equal(agent.usage.summarizerCostUsd, 0);
});
