import assert from "node:assert/strict";
import test from "node:test";

import { Agent } from "../agent.js";
import { MemoryStore } from "../store/memoryStore.js";
import { MemoryProfileStore, emptyProfile } from "../store/profileStore.js";
import { exchangeStarts } from "./boundaries.js";
import { MemoryStrategy, ROUTES, applyOps, routeFor } from "./memory.js";

const SESSION = "22222222-2222-4222-8222-222222222222";

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

/** An extractor that returns a scripted patch and records what it was shown. */
class StubExtractor {
  calls = [];
  #scripted;
  #fail;

  constructor({ ops = [], fail = false } = {}) {
    this.#scripted = ops;
    this.#fail = fail;
  }

  async extract({ stored, exchange }) {
    const index = this.calls.length;
    this.calls.push({ stored, exchange });
    if (this.#fail) throw new Error("extractor is down");
    return {
      ops: Array.isArray(this.#scripted[index]) ? this.#scripted[index] : [],
      usage: { inputTokens: 60, outputTokens: 12 },
      model: "stub",
      ms: 1,
    };
  }
}

/** A promoter that rephrases by shouting, so a test can see it happened. */
class StubPromoter {
  calls = [];
  #fail;

  constructor({ fail = false } = {}) {
    this.#fail = fail;
  }

  async propose({ entries, context }) {
    this.calls.push({ entries, context });
    if (this.#fail) throw new Error("promoter is down");
    return {
      proposals: entries.map((entry) => ({
        key: entry.key,
        value: `Standing alone: ${entry.value}`,
      })),
      usage: { inputTokens: 80, outputTokens: 30 },
      model: "stub",
      ms: 1,
    };
  }
}

class StubSummarizer {
  calls = [];

  async summarize({ previousSummary, messages }) {
    const index = this.calls.length;
    this.calls.push({ previousSummary, messages });
    return {
      text: `digest ${index + 1}`,
      usage: { inputTokens: 100, outputTokens: 40 },
      model: "stub",
      ms: 1,
    };
  }
}

function strategyWith({ ops = [], window = 10, profileStore = new MemoryProfileStore(), ...rest } = {}) {
  const extractor = new StubExtractor({ ops });
  const promoter = new StubPromoter();
  const summarizer = new StubSummarizer();
  const strategy = new MemoryStrategy({
    contextMessages: window,
    profileStore,
    extractor,
    promoter,
    summarizer,
    ...rest,
  });
  return { strategy, extractor, promoter, summarizer, profileStore };
}

/** Drive a strategy over a scripted conversation, as the Agent would. */
async function converse(strategy, words, { provider = new StubProvider(), from } = {}) {
  const history = from ? [...from.history] : [];
  let state = from ? from.state : strategy.emptyState();
  const turns = [];

  for (const word of words) {
    history.push({ role: "user", content: word });
    const built = await strategy.buildPayload({ history, systemPrompt: "persona", state, provider });
    history.push({ role: "assistant", content: "ok" });
    state = built.state;
    turns.push(built);
  }

  return { history, state, turns };
}

// ---- the routing table ------------------------------------------------------

test("every namespace resolves to exactly one layer, and an unknown one lands nowhere", () => {
  for (const [namespace, route] of Object.entries(ROUTES)) {
    const resolved = routeFor(namespace);
    assert.ok(resolved, `${namespace} resolved to nothing`);
    assert.equal(resolved.namespace, namespace);
    assert.equal(resolved.layer, route.layer);
    assert.ok(["working", "longterm"].includes(resolved.layer), `${namespace} is in no known layer`);
    // A dotted key resolves by its namespace and by nothing else, so the same
    // namespace can never land in two layers depending on the suffix.
    assert.equal(routeFor(`${namespace}.one.two`).layer, route.layer);
  }

  // Layer assignment is a lookup, never a judgement: an unrecognised namespace
  // is discarded rather than guessed at.
  for (const key of ["random.thing", "notes", "goal.a.b.c", "", "…", "Goal Thing"]) {
    assert.equal(routeFor(key), null, `${key} was given a layer`);
  }

  const applied = applyOps({ working: {}, profile: emptyProfile() }, [
    { op: "set", key: "random.thing", value: "nowhere" },
    { op: "set", key: "goal", value: "somewhere" },
  ], { turn: 1 });

  assert.deepEqual(Object.keys(applied.working), ["goal"]);
  assert.deepEqual(Object.keys(applied.profile.entries), []);
  assert.equal(applied.discarded.length, 1);
  assert.equal(applied.discarded[0].key, "random.thing");
  assert.equal(applied.discarded[0].reason, "unknown namespace");
});

test("the extractor proposes keys; the table decides the layer", async () => {
  const { strategy, profileStore } = strategyWith({
    ops: [
      [
        { op: "set", key: "goal", value: "migrate billing off Heroku" },
        { op: "set", key: "constraint.database", value: "Postgres 14" },
        { op: "set", key: "preference.tooling", value: "never suggest Kubernetes" },
        { op: "set", key: "vibes.today", value: "good" },
      ],
    ],
  });

  const { turns, state } = await converse(strategy, ["everything at once"]);

  // Working memory took three of them; the profile took the preference.
  assert.deepEqual(Object.keys(state.working).sort(), ["constraint.database", "goal"]);
  const profile = await profileStore.load("local");
  assert.deepEqual(Object.keys(profile.entries), ["preference.tooling"]);

  // And the one nobody could route is on the record as having been proposed.
  assert.deepEqual(state.discarded.map((row) => row.key), ["vibes.today"]);
  assert.match(turns[0].meta.note, /proposed, not stored/);

  // Three blocks, in the system prompt, in order — and never in the messages.
  assert.match(turns[0].system, /persona[\s\S]*<profile>[\s\S]*<working>/);
  assert.match(turns[0].system, /preference\.tooling: never suggest Kubernetes/);
  assert.match(turns[0].system, /goal: migrate billing off Heroku/);
  assert.doesNotMatch(turns[0].system, /vibes/);
  for (const message of turns[0].messages) assert.doesNotMatch(message.content, /<profile>|<working>/);
});

test("the extractor is shown what is stored, with its values", async () => {
  const { strategy, extractor } = strategyWith({
    ops: [[{ op: "set", key: "goal", value: "decide whether to hire this candidate" }], []],
  });
  await converse(strategy, ["should I hire them?", "they struggled with algorithms"]);

  // Names alone would make "do not restate what has not changed" unfollowable:
  // a model that cannot see what `goal` currently says will rewrite it in the
  // vocabulary of whatever was said last, every single turn.
  assert.deepEqual(extractor.calls[0].stored, []);
  assert.deepEqual(extractor.calls[1].stored, [
    { key: "goal", value: "decide whether to hire this candidate" },
  ]);
  // And never the whole conversation — a regenerative prompt is what makes a
  // model silently drop what it did not restate.
  for (const call of extractor.calls) assert.ok(call.exchange.length <= 2);
});

test("a fact about the user has somewhere to go, and the task's facts stay in the task", async () => {
  const { strategy, profileStore } = strategyWith({
    ops: [
      [
        { op: "set", key: "profile.role", value: "Senior Android developer" },
        { op: "set", key: "decision.candidate", value: "the candidate has a solid Android background" },
      ],
    ],
  });

  const { turns, state } = await converse(strategy, ["I'm a senior android developer, interviewing someone"]);

  // Who the user is outlives every task; what they worked out about a
  // candidate does not. Before `profile.*` existed the first of those had
  // nowhere to go at all, so the only thing that survived a task was a fact
  // about somebody else.
  assert.deepEqual(Object.keys((await profileStore.load("local")).entries), ["profile.role"]);
  assert.deepEqual(Object.keys(state.working), ["decision.candidate"]);
  assert.match(turns[0].system, /<profile>[\s\S]*profile\.role: Senior Android developer/);
  assert.match(turns[0].system, /<working>[\s\S]*decision\.candidate:/);
});

test("a task that contradicts long-term stops sending the stale half and offers a correction", async () => {
  const profileStore = new MemoryProfileStore();
  await profileStore.save("local", {
    user: "local",
    nextId: 2,
    entries: {
      "decision.hire": {
        id: "e1",
        key: "decision.hire",
        value: "Hired the candidate as a Senior Android Developer.",
        updatedAt: null,
        source: "promoted",
      },
    },
  });

  const { strategy } = strategyWith({
    profileStore,
    ops: [[{ op: "set", key: "decision.hire", value: "Fired the candidate" }], []],
  });
  const { turns, state } = await converse(strategy, ["we are firing him", "write a goodbye message"]);

  // One key, one block: the payload states it once, from the task in hand.
  assert.match(turns[0].system, /<working>[\s\S]*decision\.hire: Fired the candidate/);
  assert.doesNotMatch(turns[0].system, /Hired the candidate/);
  assert.deepEqual(turns[0].meta.layers.shadowed, ["decision.hire"]);

  // Long-term is untouched until a human says so...
  assert.match((await profileStore.load("local")).entries["decision.hire"].value, /^Hired/);
  // ...and it is offered once, not once per turn for the rest of the chat.
  const pending = state.proposals.filter((p) => p.status === "pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "correction");
  assert.equal(pending[0].was, "Hired the candidate as a Senior Android Developer.");
  assert.equal(strategy.panel(state, { turns: 2 }).profile[0].contested, true);

  await strategy.answerProposal({ state, id: pending[0].id, action: "approve", turns: 2 });
  const corrected = (await profileStore.load("local")).entries["decision.hire"];
  assert.equal(corrected.value, "Fired the candidate");
  // The same entry, corrected — not a second one beside the first.
  assert.equal(corrected.id, "e1");
  assert.equal(Object.keys((await profileStore.load("local")).entries).length, 1);
});

test("the extractor may write long-term, but may not erase it", async () => {
  const profileStore = new MemoryProfileStore();
  await profileStore.save("local", {
    user: "local",
    nextId: 2,
    entries: {
      "profile.role": { id: "e1", key: "profile.role", value: "senior Android developer", updatedAt: null, source: "extracted" },
    },
  });

  const { strategy, state } = await (async () => {
    const parts = strategyWith({
      profileStore,
      ops: [[{ op: "delete", key: "profile.role" }, { op: "set", key: "preference.sql", value: "always show the SQL" }]],
    });
    const run = await converse(parts.strategy, ["never mind about me"]);
    return { ...parts, ...run };
  })();

  // The write went through; the erase did not. Working memory is rebuilt every
  // task, long-term is not, so a delete there is permanent — and permanent is
  // the person's call.
  const entries = (await profileStore.load("local")).entries;
  assert.deepEqual(Object.keys(entries).sort(), ["preference.sql", "profile.role"]);
  assert.equal(state.discarded.at(-1).reason, "long-term deletes are yours to make");

  // The panel can say which of them the user wrote down and which arrived on
  // its own, which is the only way to audit a store that never expires. Both
  // of these arrived on their own — the profile written before provenance
  // existed migrates to `learned`, because nothing in it was ever declared.
  const panel = strategy.panel(state, { turns: 1 });
  assert.deepEqual(panel.profile.map((row) => row.source), ["learned", "learned"]);
  assert.deepEqual(panel.profile.map((row) => row.declared), [false, false]);

  // A person pressing *forget* may do what the model may not.
  await strategy.applyPanelOps({ state, ops: [{ op: "delete", key: "profile.role", from: "profile" }], turns: 1 });
  assert.deepEqual(Object.keys((await profileStore.load("local")).entries), ["preference.sql"]);
});

test("a bare key may correct what is already there, but may not open a new slot", async () => {
  const profileStore = new MemoryProfileStore();
  await profileStore.save("local", {
    user: "local",
    nextId: 2,
    // Written before the sub-key rule existed — and now stale.
    entries: {
      profile: { id: "e1", key: "profile", value: "Currently lives in Eberswalde", updatedAt: null, source: "extracted" },
    },
  });

  const { strategy, state } = await (async () => {
    const parts = strategyWith({
      profileStore,
      ops: [
        [{ op: "set", key: "profile", value: "Lives in Berlin, Prenzlauer Berg" }],
        [{ op: "set", key: "preference", value: "likes short answers" }],
        [{ op: "set", key: "preference", value: "likes short answers" }],
      ],
    });
    const run = await converse(parts.strategy, ["I have moved", "and keep it brief", "I said brief"]);
    return { ...parts, ...run };
  })();

  // The correction lands: refusing it would freeze a false fact in a store
  // that never expires, and the model — told to reuse the stored key — would
  // propose the same refused key on every remaining turn.
  const entries = (await profileStore.load("local")).entries;
  assert.equal(entries.profile.value, "Lives in Berlin, Prenzlauer Berg");
  assert.equal(entries.profile.id, "e1");

  // A bare key that would *create* a slot is still refused: one slot for
  // everything about a person is a layer, not a key.
  assert.ok(!("preference" in entries));
  const panel = strategy.panel(state, { turns: 3 });
  assert.equal(panel.discarded.length, 1, "the same refusal was listed once per turn");
  assert.match(panel.discarded[0].reason, /needs a sub-key/);
  assert.equal(panel.discarded[0].value, "likes short answers", "a refusal that cannot say what it dropped is not reviewable");
});

test("closing an open question must record its answer", async () => {
  const { strategy, state } = await (async () => {
    const parts = strategyWith({
      ops: [
        [{ op: "set", key: "open.dfs", value: "Was the DFS struggle a real signal?" }],
        // The shape that lost the fact: the question resolved, and the only
        // place the fact was written down went with it.
        [{ op: "delete", key: "open.dfs" }],
        // The shape that keeps it.
        [
          { op: "delete", key: "open.dfs" },
          { op: "set", key: "finding.dfs", value: "Struggled to code DFS, understood the concept" },
        ],
      ],
    });
    const run = await converse(parts.strategy, ["he struggled", "the team was impressed", "so it is fine"]);
    return { ...parts, ...run };
  })();

  // The lone delete was refused and said so; the paired one went through.
  assert.equal(state.discarded[0].reason, "an answered question must be replaced, not just removed");
  assert.ok(!("open.dfs" in state.working));
  assert.equal(state.working["finding.dfs"].value, "Struggled to code DFS, understood the concept");

  // A person may still close a question without answering it.
  const byHand = await strategy.applyPanelOps({
    state: { ...state, working: { ...state.working, "open.other": { value: "?", updatedAt: null, turn: 1, previous: [] } } },
    ops: [{ op: "delete", key: "open.other" }],
    turns: 3,
  });
  assert.ok(!("open.other" in byHand.state.working));
});

test("a model may set and delete; it may not promote", async () => {
  const { strategy, profileStore } = strategyWith({
    ops: [
      [{ op: "set", key: "decision.database", value: "Postgres 14 it is" }],
      [{ op: "promote", key: "decision.database" }],
    ],
  });

  const { state } = await converse(strategy, ["one", "two"]);
  const profile = await profileStore.load("local");

  assert.equal(state.working["decision.database"].value, "Postgres 14 it is");
  assert.deepEqual(Object.keys(profile.entries), [], "the model promoted itself into long-term");
  assert.equal(state.discarded.at(-1).reason, "operation not allowed here");
});

test("a reversal overwrites the key and keeps what it replaced", () => {
  const first = applyOps({ working: {}, profile: emptyProfile() }, [
    { op: "set", key: "decision.hosting", value: "Kubernetes is fine" },
  ], { turn: 1 });
  const second = applyOps({ working: first.working, profile: first.profile }, [
    { op: "set", key: "decision.hosting", value: "never Kubernetes" },
  ], { turn: 6 });

  assert.equal(second.working["decision.hosting"].value, "never Kubernetes");
  assert.deepEqual(second.working["decision.hosting"].previous, ["Kubernetes is fine"]);

  // A set that changes nothing is not a change, and must not re-stamp the
  // timestamp that drives eviction.
  const third = applyOps({ working: second.working, profile: second.profile }, [
    { op: "set", key: "decision.hosting", value: "never Kubernetes" },
  ], { turn: 7 });
  assert.deepEqual(third.set, []);
  assert.equal(third.working["decision.hosting"].turn, 6);
});

// ---- the two schedules ------------------------------------------------------

test("extraction runs every turn and the fold runs at the mark, billed apart", async () => {
  const { strategy, extractor, summarizer } = strategyWith({ window: 4 });
  const { state, turns } = await converse(strategy, ["one", "two", "three", "four", "five"]);

  assert.equal(extractor.calls.length, 5, "extraction did not run on every user turn");
  assert.equal(summarizer.calls.length, 1, "the fold did not wait for the high-water mark");

  // The two bills are kept apart: one number per schedule, so "widen the
  // window" and "narrow it" are decisions with evidence behind them.
  assert.equal(state.usage.overheadWorking.calls, 5);
  assert.equal(state.usage.overheadSummary.calls, 1);
  assert.ok(state.usage.overheadWorking.inputTokens > 0);
  assert.ok(state.usage.overheadSummary.inputTokens > 0);

  // The turn that folded paid for both calls at once.
  const folding = turns.find((turn) => turn.meta.note.includes("folded"));
  assert.equal(folding.meta.overheadCalls, 2);
  assert.match(folding.system, /<conversation_summary>[\s\S]*digest 1/);

  // The digest's edge and the verbatim region's edge are the same index, so no
  // message is ever in neither zone.
  for (const [index, built] of turns.entries()) {
    assert.equal(built.meta.droppedMessages + built.messages.length, index * 2 + 1);
    assert.equal(built.messages[0].role, "user");
  }
});

test("extraction failure keeps the memory and answers the turn anyway", async () => {
  const failing = new MemoryStrategy({
    contextMessages: 10,
    profileStore: new MemoryProfileStore(),
    extractor: new StubExtractor({ fail: true }),
    promoter: new StubPromoter(),
    summarizer: new StubSummarizer(),
  });

  const built = await failing.buildPayload({
    history: [
      { role: "user", content: "we are shipping it" },
      { role: "assistant", content: "noted" },
      { role: "user", content: "hello" },
    ],
    systemPrompt: "persona",
    state: {
      ...failing.emptyState(),
      working: { goal: { value: "ship it", updatedAt: null, turn: 1, previous: [] } },
    },
    provider: new StubProvider(),
  });

  assert.match(built.system, /goal: ship it/);
  assert.equal(built.meta.note, "extraction failed — memory kept as it was");
  assert.equal(built.messages.length, 3);
});

// ---- the task boundary ------------------------------------------------------

/** Take a task to the point where the button would be pressed. */
async function aTask(overrides = {}) {
  const parts = strategyWith({
    ops: [
      [
        { op: "set", key: "goal", value: "migrate billing off Heroku" },
        { op: "set", key: "constraint.database", value: "Postgres 14" },
      ],
      [{ op: "set", key: "decision.hosting", value: "Fly.io, not Kubernetes" }],
    ],
    ...overrides,
  });
  const run = await converse(parts.strategy, ["the plan", "the hosting"]);
  return { ...parts, ...run };
}

test("finishing a task proposes, clears, and keeps the closed record", async () => {
  const { strategy, promoter, state, history, profileStore } = await aTask();

  const finished = await strategy.finishTask({ state, history, provider: new StubProvider() });

  // Only the promotable namespaces are offered — a goal or a constraint was
  // about this task, a decision can outlive it.
  assert.deepEqual(promoter.calls[0].entries.map((entry) => entry.key), ["decision.hosting"]);
  assert.match(promoter.calls[0].context, /constraint\.database: Postgres 14/);
  assert.equal(finished.proposals.length, 1);
  assert.equal(finished.proposals[0].status, "pending");
  assert.match(finished.proposals[0].value, /^Standing alone: /);

  // Cleared, not deleted.
  assert.deepEqual(Object.keys(finished.state.working), []);
  assert.equal(finished.state.pastTasks.length, 1);
  assert.equal(finished.state.pastTasks[0].entries.length, 3);

  // And nothing reached long-term on the strength of a proposal alone.
  assert.deepEqual(Object.keys((await profileStore.load("local")).entries), []);
  assert.equal(strategy.panel(finished.state, { turns: 2 }).proposals[0].status, "pending");
});

test("a failed promotion call leaves the task open rather than clearing it", async () => {
  const { state, history } = await aTask();
  // The same closed task, handed to a strategy whose promoter falls over.
  const broken = new MemoryStrategy({
    contextMessages: 10,
    profileStore: new MemoryProfileStore(),
    extractor: new StubExtractor(),
    promoter: new StubPromoter({ fail: true }),
    summarizer: new StubSummarizer(),
  });

  const finished = await broken.finishTask({ state, history, provider: new StubProvider() });
  assert.equal(finished.ok, false);
  assert.deepEqual(Object.keys(finished.state.working).sort(), [
    "constraint.database",
    "decision.hosting",
    "goal",
  ]);
  assert.equal(finished.state.pastTasks.length, 0);
});

test("a proposal reaches long-term only when a human says so, and only as edited", async () => {
  const { strategy, state, history, profileStore } = await aTask();
  const finished = await strategy.finishTask({ state, history, provider: new StubProvider() });
  const [proposal] = finished.proposals;

  const rejected = await strategy.answerProposal({
    state: finished.state,
    id: proposal.id,
    action: "reject",
    turns: 2,
  });
  assert.deepEqual(Object.keys((await profileStore.load("local")).entries), []);
  assert.equal(rejected.state.proposals[0].status, "rejected");
  await assert.rejects(
    () => strategy.answerProposal({ state: rejected.state, id: proposal.id, action: "approve", turns: 2 }),
    /already been answered/
  );

  const approved = await strategy.answerProposal({
    state: finished.state,
    id: proposal.id,
    action: "approve",
    value: "Runs everything on Fly.io; ruled Kubernetes out for a three-person team.",
    turns: 2,
  });

  const profile = await profileStore.load("local");
  assert.equal(
    profile.entries["decision.hosting"].value,
    "Runs everything on Fly.io; ruled Kubernetes out for a three-person team."
  );
  assert.equal(approved.state.pastTasks[0].promoted, 1);
});

test("the second task sees the promoted decision and not the cleared constraints", async () => {
  const { strategy, state, history, profileStore } = await aTask();
  const finished = await strategy.finishTask({ state, history, provider: new StubProvider() });
  const approved = await strategy.answerProposal({
    state: finished.state,
    id: finished.proposals[0].id,
    action: "approve",
    turns: 2,
  });

  // A third turn, on the same branch, with the task boundary behind it.
  const next = await converse(strategy, ["something else entirely"], {
    from: { history, state: approved.state },
  });
  const [built] = next.turns;

  assert.match(built.system, /<profile>[\s\S]*Standing alone: Fly\.io, not Kubernetes/);
  assert.doesNotMatch(built.system, /Postgres 14/, "a cleared constraint was still being sent");
  assert.doesNotMatch(built.system, /migrate billing off Heroku/);
  // The closed task is still there — kept, simply not sent.
  assert.equal(built.state.pastTasks[0].entries.length, 3);
  assert.equal(Object.keys((await profileStore.load("local")).entries).length, 1);
});

test("without the button, working memory degrades to facts with an LRU budget", async () => {
  const ops = [];
  for (let i = 0; i < 6; i++) ops.push([{ op: "set", key: `constraint.c${i}`, value: `value ${i}` }]);
  const { strategy, state } = await (async () => {
    const parts = strategyWith({ ops, maxWorking: 3 });
    const run = await converse(parts.strategy, ["1", "2", "3", "4", "5", "6"]);
    return { ...parts, ...run };
  })();

  assert.equal(Object.keys(state.working).length, 3);
  assert.deepEqual(Object.keys(state.working).sort(), ["constraint.c3", "constraint.c4", "constraint.c5"]);
  assert.equal(strategy.panel(state, { turns: 6 }).task.length, 3);
});

// ---- stamping ---------------------------------------------------------------

test("a fork cannot read what its parent promoted after the fork", async () => {
  const { strategy, state, history, profileStore } = await aTask();
  const finished = await strategy.finishTask({ state, history, provider: new StubProvider() });
  const approved = await strategy.answerProposal({
    state: finished.state,
    id: finished.proposals[0].id,
    action: "approve",
    turns: 2,
  });

  // A branch forked at the first exchange carries a copy of this state — and
  // with it the stamp saying the entry was promoted two exchanges in.
  const forked = structuredClone(approved.state);
  const built = await strategy.buildPayload({
    history: [
      { role: "user", content: "the plan" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "a different second turn" },
    ],
    systemPrompt: "persona",
    state: forked,
    provider: new StubProvider(),
  });

  assert.doesNotMatch(built.system, /Standing alone/, "a promotion leaked into a branch that predates it");
  assert.doesNotMatch(built.system, /<profile>/);
  // The profile store still has it: it was hidden from this branch, not deleted.
  assert.equal(Object.keys((await profileStore.load("local")).entries).length, 1);
  // And the panel tells the same story as the payload.
  assert.equal(strategy.panel(forked, { turns: 1 }).profile.length, 0);
  assert.equal(strategy.panel(forked, { turns: 2 }).profile.length, 1);
});

test("working memory established after the fork point does not come along either", async () => {
  const { strategy } = strategyWith({});
  const inherited = {
    ...strategy.emptyState(),
    working: {
      "constraint.port": { value: "8477", updatedAt: null, turn: 1, previous: [] },
      "decision.database": { value: "MySQL after all", updatedAt: null, turn: 4, previous: [] },
    },
  };

  const built = await strategy.buildPayload({
    history: [
      { role: "user", content: "the port is 8477" },
      { role: "assistant", content: "noted" },
      { role: "user", content: "go on" },
    ],
    systemPrompt: "persona",
    state: inherited,
    provider: new StubProvider(),
  });

  assert.match(built.system, /constraint\.port: 8477/);
  assert.doesNotMatch(built.system, /MySQL/);
});

// ---- the panel and its buttons ---------------------------------------------

test("the panel's buttons are the same applyOps path the extractor uses", async () => {
  const { strategy, state, profileStore } = await aTask();

  const promoted = await strategy.applyPanelOps({
    state,
    ops: [{ op: "promote", key: "decision.hosting" }],
    turns: 2,
  });
  assert.equal(
    (await profileStore.load("local")).entries["decision.hosting"].value,
    "Fly.io, not Kubernetes"
  );

  const forgotten = await strategy.applyPanelOps({
    state: promoted.state,
    ops: [
      { op: "delete", key: "goal", from: "working" },
      { op: "delete", key: "decision.hosting", from: "profile" },
    ],
    turns: 2,
  });

  assert.ok(!("goal" in forgotten.state.working));
  assert.deepEqual(Object.keys((await profileStore.load("local")).entries), []);

  const panel = strategy.panel(forgotten.state, { turns: 2 });
  assert.equal(panel.kind, "memory");
  assert.deepEqual(panel.task.map((row) => row.key), ["constraint.database", "decision.hosting"]);
  assert.equal(panel.task.find((row) => row.key === "decision.hosting").promotable, true);
  assert.equal(panel.task.find((row) => row.key === "constraint.database").promotable, false);
  assert.deepEqual(panel.profile, []);
});

test("the panel attributes each turn's blocks, for the counter under the reply", async () => {
  const { strategy, state } = await aTask();
  const panel = strategy.panel(state, { turns: 2 });

  assert.equal(panel.attribution.length, 2);
  assert.deepEqual(panel.attribution.map((row) => row.turn), [1, 2]);
  assert.ok(panel.attribution[1].working > panel.attribution[0].working, "the block did not grow");
  assert.equal(panel.attribution[0].profile, 0);
  // A branch that is only one exchange long does not get turn two's numbers.
  assert.equal(strategy.panel(state, { turns: 1 }).attribution.length, 1);
});

// ---- the two scenarios the layering exists for ------------------------------

test("the profile survives a restart and a brand new conversation", async () => {
  const profileStore = new MemoryProfileStore();
  const store = new MemoryStore();
  const provider = new StubProvider();

  const first = new Agent({
    provider,
    store,
    sessionId: SESSION,
    contextMessages: 10,
    strategy: new MemoryStrategy({
      contextMessages: 10,
      profileStore,
      extractor: new StubExtractor({ ops: [[{ op: "set", key: "preference.tooling", value: "never suggest Kubernetes" }]] }),
      promoter: new StubPromoter(),
      summarizer: new StubSummarizer(),
    }),
  });
  await first.run("I never want to hear about Kubernetes again");

  // A different conversation, a different agent, a different store record —
  // everything short-term is gone, and the profile is not.
  const second = new Agent({
    provider,
    store: new MemoryStore(),
    sessionId: "33333333-3333-4333-8333-333333333333",
    contextMessages: 10,
    strategy: new MemoryStrategy({
      contextMessages: 10,
      profileStore,
      extractor: new StubExtractor(),
      promoter: new StubPromoter(),
      summarizer: new StubSummarizer(),
    }),
  });
  await second.run("hello again");

  const system = provider.calls.at(-1).system;
  assert.match(system, /<profile>[\s\S]*preference\.tooling: never suggest Kubernetes/);
  assert.doesNotMatch(system, /<working>/, "the new conversation inherited a task it never had");
  assert.deepEqual(second.panel().profile.map((row) => row.key), ["preference.tooling"]);
});

test("the Agent learns no file path, and a branch keeps its own memory", async () => {
  const profileStore = new MemoryProfileStore();
  const agent = new Agent({
    provider: new StubProvider(),
    store: new MemoryStore(),
    sessionId: SESSION,
    contextMessages: 10,
    strategy: "memory",
    strategyOptions: { profileStore },
  });

  const { meta } = await agent.run("hello");
  assert.equal(meta.strategy.id, "memory");
  assert.equal(meta.strategy.panel.kind, "memory");
  // Injected exactly the way the provider and the conversation store are: the
  // Agent was handed a strategy, not a directory.
  assert.equal(agent.strategy.profileStore, profileStore);
});

// ---- the durable namespaces -------------------------------------------------

test("style, format and standing rules are durable, and Finish task does not touch them", async () => {
  // Every new route is long-term and never-expiring, by the table rather than
  // by anyone's judgement. This is the assertion that would have failed on the
  // day these facts were landing in `constraint.*` and dying with the task.
  for (const key of ["preference.style", "preference.format", "rule.emdash", "rule"]) {
    const route = routeFor(key);
    assert.ok(route, `${key} resolved to nothing`);
    assert.equal(route.layer, "longterm", `${key} is not durable`);
    assert.equal(route.evict, "never", `${key} expires`);
  }

  const { strategy, profileStore } = strategyWith({
    ops: [
      [
        { op: "set", key: "preference.style", value: "Terse. No preamble." },
        { op: "set", key: "preference.format", value: "Bullets, code first" },
        { op: "set", key: "rule.emdash", value: "Never use em-dashes" },
        { op: "set", key: "goal", value: "pick a queue" },
        // Same sentiment, task-scoped namespace — this one *should* die with
        // the task, and the pair is the whole distinction the router draws.
        { op: "set", key: "constraint.length", value: "the plan must fit two pages" },
      ],
    ],
  });

  const { state, history, turns } = await converse(strategy, ["how I like to be answered"]);
  const durable = ["preference.format", "preference.style", "rule.emdash"];
  assert.deepEqual(Object.keys((await profileStore.load("local")).entries).sort(), durable);
  assert.deepEqual(Object.keys(state.working).sort(), ["constraint.length", "goal"]);
  assert.match(turns[0].system, /<profile>[\s\S]*rule\.emdash: Never use em-dashes/);
  // The block says out loud that these lines are instructions. Without it a
  // model reads "prefers bullets" as biography and answers in prose anyway.
  assert.match(turns[0].system, /standing instructions about how to answer/);

  const finished = await strategy.finishTask({ state, history, provider: new StubProvider() });
  assert.deepEqual(Object.keys(finished.state.working), [], "the task was not cleared");
  assert.deepEqual(Object.keys((await profileStore.load("local")).entries).sort(), durable);

  // And the next turn, on the far side of the boundary, still carries them.
  const next = await converse(strategy, ["something completely different"], {
    from: { history, state: finished.state },
  });
  assert.match(next.turns[0].system, /preference\.style: Terse\. No preamble\./);
  assert.match(next.turns[0].system, /rule\.emdash: Never use em-dashes/);
  assert.doesNotMatch(next.turns[0].system, /two pages/, "a task-scoped constraint outlived its task");
});

test("the profile form may only write durable keys", () => {
  const applied = applyOps({ working: {}, profile: emptyProfile() }, [
    { op: "set", key: "preference.style", value: "Terse" },
    { op: "set", key: "constraint.length", value: "two pages" },
  ], { turn: 1, allow: ["set", "delete", "promote"], origin: "person", source: "declared" });

  assert.deepEqual(Object.keys(applied.profile.entries), ["preference.style"]);
  assert.deepEqual(Object.keys(applied.working), []);
  assert.match(applied.discarded[0].reason, /only long-term entries can be declared/);
});

// ---- declared vs learned ----------------------------------------------------

/** A profile with one declared entry and one learned one. */
function declaredProfile() {
  return {
    user: "local",
    nextId: 3,
    entries: {
      "preference.style": {
        id: "e1",
        key: "preference.style",
        value: "Terse. Never any code.",
        updatedAt: null,
        source: "declared",
      },
      "preference.tooling": {
        id: "e2",
        key: "preference.tooling",
        value: "never suggest Kubernetes",
        updatedAt: null,
        source: "learned",
      },
    },
  };
}

test("a model may not overwrite what you declared; a person may", async () => {
  const profile = declaredProfile();

  // (a) A model-originated op onto a declared key writes nothing and leaves a
  // correction behind instead: *you declared X, the conversation suggests Y*.
  const byModel = applyOps({ working: {}, profile }, [
    { op: "set", key: "preference.style", value: "Chatty, with plenty of examples" },
  ], { turn: 3, origin: "model" });

  assert.deepEqual(byModel.set, [], "a model wrote over a declared entry");
  assert.equal(byModel.profile.entries["preference.style"].value, "Terse. Never any code.");
  assert.equal(byModel.profileTouched, false);
  assert.deepEqual(byModel.contested, [{
    key: "preference.style",
    value: "Chatty, with plenty of examples",
    was: "Terse. Never any code.",
    reason: "declared",
  }]);
  assert.match(describeOf(byModel), /held back by what you declared/);

  // Learned-over-learned still overwrites exactly as it always did — the rule
  // is about who wrote the entry, not about long-term being read-only.
  const learned = applyOps({ working: {}, profile }, [
    { op: "set", key: "preference.tooling", value: "Kubernetes is fine now" },
  ], { turn: 3, origin: "model" });
  assert.deepEqual(learned.set, ["preference.tooling"]);
  assert.equal(learned.profile.entries["preference.tooling"].value, "Kubernetes is fine now");
  assert.equal(learned.profile.entries["preference.tooling"].source, "learned");

  // (b) A person-originated op onto the same declared key writes.
  const byPerson = applyOps({ working: {}, profile }, [
    { op: "set", key: "preference.style", value: "Chatty, with plenty of examples" },
  ], { turn: 3, origin: "person", allow: ["set", "delete", "promote"], source: "declared" });
  assert.deepEqual(byPerson.set, ["preference.style"]);
  assert.equal(byPerson.profile.entries["preference.style"].value, "Chatty, with plenty of examples");
  // Same entry, edited — not a second one beside the first.
  assert.equal(byPerson.profile.entries["preference.style"].id, "e1");
  assert.deepEqual(byPerson.contested, []);

  // Approving the correction is the other person-originated path, and it keeps
  // the provenance: you are still the one deciding what the entry says.
  const store = new MemoryProfileStore();
  await store.save("local", declaredProfile());
  const { strategy } = strategyWith({
    profileStore: store,
    ops: [[{ op: "set", key: "preference.style", value: "Chatty, with plenty of examples" }]],
  });
  const { state } = await converse(strategy, ["actually give me lots of examples"]);

  const [proposal] = state.proposals.filter((p) => p.status === "pending");
  assert.equal(proposal.kind, "correction");
  assert.equal(proposal.reason, "declared");
  assert.equal(proposal.was, "Terse. Never any code.");
  assert.equal((await store.load("local")).entries["preference.style"].value, "Terse. Never any code.");

  const panel = strategy.panel(state, { turns: 1 });
  const row = panel.profile.find((entry) => entry.key === "preference.style");
  assert.equal(row.declared, true);
  assert.equal(row.proposal.value, "Chatty, with plenty of examples");

  await strategy.answerProposal({ state, id: proposal.id, action: "approve", turns: 1 });
  const after = (await store.load("local")).entries["preference.style"];
  assert.equal(after.value, "Chatty, with plenty of examples");
  assert.equal(after.source, "declared", "approving a correction demoted a declared entry");
});

test("a declared entry is never shadowed by the task, and says so instead", async () => {
  const store = new MemoryProfileStore();
  await store.save("local", declaredProfile());

  const { strategy } = strategyWith({
    profileStore: store,
    // A task-scoped key that collides with both long-term entries at once: one
    // declared, one learned. Routing sends both to working, as it always does.
    ops: [[
      { op: "set", key: "preference.style", value: "long and chatty for this one" },
      { op: "set", key: "preference.tooling", value: "use Kubernetes here" },
    ]],
  });

  // The extractor cannot write either of those to long-term — one is declared,
  // and the other it *can*, so this drives the working-memory collision by
  // hand, which is the shape `applyOps` guards.
  const seeded = {
    ...strategy.emptyState(),
    working: {
      "preference.style": { value: "long and chatty for this one", updatedAt: null, turn: 0, previous: [] },
      "preference.tooling": { value: "use Kubernetes here", updatedAt: null, turn: 0, previous: [] },
    },
  };
  const built = await strategy.buildPayload({
    history: [{ role: "user", content: "for this one, go long" }],
    systemPrompt: "persona",
    state: seeded,
    provider: new StubProvider(),
  });

  // Rule 1: the learned entry is shadowed — one key, one block, and the task
  // is the more recent of the two.
  assert.deepEqual(built.meta.layers.shadowed, ["preference.tooling"]);
  assert.doesNotMatch(built.system, /never suggest Kubernetes/);

  // Rule 2: the declared entry is sent anyway. A preference the user wrote
  // down is not silently overridden by something inferred from one exchange.
  assert.deepEqual(built.meta.layers.declared, ["preference.style"]);
  assert.match(built.system, /<profile>[\s\S]*preference\.style: Terse\. Never any code\./);

  // ...and the disagreement is raised rather than swallowed.
  const correction = built.state.proposals.find(
    (p) => p.key === "preference.style" && p.status === "pending"
  );
  assert.equal(correction.kind, "correction");
  assert.equal(correction.reason, "declared");
  assert.equal(correction.was, "Terse. Never any code.");
  assert.equal(correction.value, "long and chatty for this one");

  // Working memory itself is untouched by either rule: both rows are still
  // there, and both are still on the wire from `<working>`.
  assert.match(built.system, /<working>[\s\S]*preference\.style: long and chatty for this one/);
  assert.match(built.system, /<working>[\s\S]*preference\.tooling: use Kubernetes here/);

  const row = strategy.panel(built.state, { turns: 1 }).profile.find((p) => p.key === "preference.style");
  assert.equal(row.contested, true);
  assert.equal(row.sent, true, "a declared row was reported as not being sent");
});

// ---- what the profile costs -------------------------------------------------

test("the profile's per-turn cost is a number beside the two call bills", async () => {
  const store = new MemoryProfileStore();
  await store.save("local", declaredProfile());
  const { strategy } = strategyWith({ profileStore: store, window: 4 });
  const { state } = await converse(strategy, ["one", "two", "three", "four"]);

  const { overheadProfile, overheadWorking, overheadSummary } = state.usage;
  // It is counted on every turn, including the ones where no call was made —
  // that is the claim: the profile is paid for whether or not it was used.
  assert.equal(overheadProfile.turns, 4);
  assert.equal(overheadProfile.calls, 0, "a block that was never a request is claiming calls");
  assert.ok(overheadProfile.inputTokens > 0);
  assert.equal(overheadProfile.estimated, true, "an estimate must say so");
  // And it is a third bucket, not a share of either of the other two.
  assert.equal(overheadWorking.calls, 4);
  assert.equal(overheadSummary.calls, 1);
});

/** `describe()` is private; this reads its output off an applied patch. */
function describeOf(applied) {
  const parts = [];
  if (applied.set.length) parts.push("set");
  const declared = applied.contested.filter((row) => row.reason === "declared").length;
  if (declared) parts.push(`${declared} held back by what you declared`);
  return parts.join(", ");
}
