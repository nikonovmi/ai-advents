import assert from "node:assert/strict";
import test from "node:test";

import { Agent } from "../agent.js";
import { MemoryStore } from "../store/memoryStore.js";
import { getBranchHistory } from "../store/branches.js";
import { MemoryInvariantStore } from "../store/invariantStore.js";
import { MemoryProfileStore, emptyProfile } from "../store/profileStore.js";
import { exchangeStarts } from "./boundaries.js";
import { MemoryExtractor, MemoryStrategy, ROUTES, applyOps, routeFor } from "./memory.js";
import { stageOf } from "./taskState.js";

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

/** A briefer whose output is recognisable, so a test can see it reach the wire. */
class StubBriefer {
  calls = [];
  /** What planning left unanswered, as the real one now reports it. */
  open = [];
  /** Overridable, for the briefs whose *prose* is the thing under test. */
  text = null;
  #fail;

  constructor({ fail = false } = {}) {
    this.#fail = fail;
  }

  async write({ entries, messages }) {
    this.calls.push({ entries, messages });
    if (this.#fail) throw new Error("briefer is down");
    return {
      text: this.text ?? ["THE BRIEF", ...entries.map((entry) => `${entry.key} — ${entry.value}`)].join("\n"),
      open: this.open ?? [],
      usage: { inputTokens: 200, outputTokens: 90 },
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

function strategyWith({
  ops = [],
  window = 10,
  profileStore = new MemoryProfileStore(),
  // Injected like the profile store, and for the same reason: a test that
  // fell through to the process-wide one would read whatever rules happen to
  // be in `data/invariants/` and pass or fail on somebody's demo fixtures.
  invariantStore = new MemoryInvariantStore(),
  ...rest
} = {}) {
  const extractor = new StubExtractor({ ops });
  const promoter = new StubPromoter();
  const briefer = new StubBriefer();
  const summarizer = new StubSummarizer();
  const strategy = new MemoryStrategy({
    invariantStore: new MemoryInvariantStore(),
    contextMessages: window,
    profileStore,
    invariantStore,
    extractor,
    promoter,
    briefer,
    summarizer,
    ...rest,
  });
  return { strategy, extractor, promoter, briefer, summarizer, profileStore, invariantStore };
}

/**
 * `→ execution`, which is two steps now: the click writes a brief, and
 * accepting it is what actually leaves planning. Every test that just wants to
 * be in execution goes through here, because that is the only way there.
 */
async function toExecution(strategy, { state, history, provider = new StubProvider(), text } = {}) {
  const written = await strategy.transition({ state, to: "execution", history, provider });
  if (!written.awaitingBrief) return written;
  return await strategy.answerBrief({ state: written.state, history, action: "accept", text });
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

test("a mangled op envelope is read through, whatever shape it arrives in", () => {
  // Three rounds of this arrived as three different useless panel rows, and
  // every time it was the unanswered questions — the one thing in here that
  // nothing else writes down. The envelope is what a model gets wrong; the
  // content of these is unambiguous.
  const applied = applyOps({ working: {}, profile: emptyProfile() }, [
    // The key in the verb's place, no key at all.
    { op: "open.graph_representation", value: "How is the graph provided?" },
    // A verb nobody knows.
    { op: "add", key: "open.graph_direction", value: "Directed or undirected?" },
    // No verb at all.
    { key: "open.dfs_output", value: "What should it return?" },
    // ...and a well-formed one, unchanged.
    { op: "set", key: "goal", value: "Implement a generic DFS" },
  ], { turn: 2 });

  assert.deepEqual(Object.keys(applied.working).sort(), [
    "goal",
    "open.dfs_output",
    "open.graph_direction",
    "open.graph_representation",
  ]);
  assert.equal(applied.working["open.dfs_output"].value, "What should it return?");
  assert.deepEqual(applied.discarded, []);
});

test("reading through the envelope never invents a verb the model may not use", () => {
  // `promote` is a real verb the model is not allowed to send, so it stays
  // refused rather than being quietly rewritten into something permitted.
  const promoting = applyOps({ working: { "decision.db": { value: "Postgres" } }, profile: emptyProfile() }, [
    { op: "promote", key: "decision.db", value: "Stays on Postgres" },
  ], { turn: 1, origin: "model" });
  assert.deepEqual(Object.keys(promoting.profile.entries), []);
  assert.equal(promoting.discarded[0].reason, "`promote` is not allowed here");

  // A delete carries no value, so nothing about it looks like a `set`.
  const deleting = applyOps({ working: { "open.region": { value: "Frankfurt?" } }, profile: emptyProfile() }, [
    { op: "delete", key: "open.region" },
  ], { turn: 1, unpairedCloses: true });
  assert.deepEqual(deleting.deleted, ["open.region"]);

  // And with no value there is nothing to store, so nothing is conjured.
  const empty = applyOps({ working: {}, profile: emptyProfile() }, [
    { op: "open.region" },
    { key: "open.region" },
  ], { turn: 1 });
  assert.deepEqual(empty.working, {});
  assert.equal(empty.discarded.length, 2);
});

test("a patch with the key in the op field is still a patch", () => {
  // Exactly what the extractor emitted: the key where the op should be, no
  // `key` at all. It reached the panel as "(no key) — unknown namespace",
  // which is true of a dozen different slips and useful for none of them —
  // and the ops it happened to were the unanswered questions, the one thing
  // in here nothing else writes down.
  const applied = applyOps({ working: {}, profile: emptyProfile() }, [
    { op: "open.graph_representation", value: "How is the graph provided?" },
    { op: "set", key: "goal", value: "Implement a generic DFS" },
  ], { turn: 2 });

  assert.equal(applied.working["open.graph_representation"].value, "How is the graph provided?");
  assert.equal(applied.working.goal.value, "Implement a generic DFS");
  assert.deepEqual(applied.discarded, []);
});

test("the forgiveness is narrow, and what it cannot save it describes", () => {
  const applied = applyOps({ working: {}, profile: emptyProfile() }, [
    // No value, so there is nothing to store and nothing to guess at.
    { op: "open.region" },
    // A namespace nobody recognises, in either field.
    { op: "remember", value: "something" },
    { op: "set", key: "random.thing", value: "nope" },
    // A real op name is never reinterpreted as a key.
    { op: "delete", key: "goal" },
  ], { turn: 1, unpairedCloses: true });

  assert.deepEqual(applied.working, {});
  const reasons = applied.discarded.map((row) => [row.key, row.reason]);
  assert.deepEqual(reasons[0], ["(no key)", "no key, and `open.region` is not an op"]);
  assert.deepEqual(reasons[1], ["(no key)", "no key, and `remember` is not an op"]);
  assert.deepEqual(reasons[2], ["random.thing", "unknown namespace"]);
  // The panel gets the op, which for a keyless row is all there is to show.
  assert.equal(applied.discarded[1].op, "remember");
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
  // A *known* verb the model may not send is refused and named — unlike a
  // mangled envelope, which `coerceOp` reads through. "Not allowed" and
  // "not a verb" are different mistakes and the panel has to say which.
  assert.equal(state.discarded.at(-1).reason, "`promote` is not allowed here");
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
    invariantStore: new MemoryInvariantStore(),
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

/**
 * *Finish task* is now `→ done`, and `done` is only reachable through the
 * stages in front of it. Walking them is exactly what the strip's buttons do,
 * one click each, so the helper is the button press.
 */
async function finish(strategy, { state, history, provider = new StubProvider() }) {
  let last = await toExecution(strategy, { state, history, provider });
  let current = last.state;
  if (!last.ok) return last;

  for (const to of ["validation", "done"]) {
    last = await strategy.transition({ state: current, to, history, provider });
    current = last.state;
    if (!last.ok) break;
  }
  return last;
}

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

  const finished = await finish(strategy, { state, history });

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
    invariantStore: new MemoryInvariantStore(),
    contextMessages: 10,
    profileStore: new MemoryProfileStore(),
    extractor: new StubExtractor(),
    promoter: new StubPromoter({ fail: true }),
    briefer: new StubBriefer(),
    summarizer: new StubSummarizer(),
  });

  const finished = await finish(broken, { state, history });
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
  const finished = await finish(strategy, { state, history });
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
  const finished = await finish(strategy, { state, history });
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
  const finished = await finish(strategy, { state, history });
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

test("the panel says how far memory has been read, because the answer is not 'now'", async () => {
  const { strategy } = strategyWith({
    ops: [
      // Turn one reads `[user]` — the assistant has not spoken yet, so
      // whatever it is about to ask cannot be in this patch.
      [{ op: "set", key: "goal", value: "Implement a generic DFS" }],
      // Turn two reads `[assistant, user]`, and the questions turn one's reply
      // asked land here — one turn after they were asked.
      [
        { op: "set", key: "open.graph_representation", value: "Adjacency list or matrix?" },
        { op: "set", key: "open.return_value", value: "Visit order or side effects?" },
      ],
    ],
  });

  const provider = new StubProvider();
  const first = await converse(strategy, ["build me a DFS"], { provider });
  const afterOne = strategy.panel(first.state, { turns: 1 });
  assert.deepEqual(afterOne.task.map((row) => row.key), ["goal"]);
  // The lag is not a failure and it is not nothing: it is stated, so "it asked
  // six questions and the task shows nothing open" is explained rather than
  // left to be worked out.
  assert.equal(afterOne.reads.through, 0);
  assert.equal(afterOne.reads.pending, true);

  const second = await converse(strategy, ["just get on with it"], {
    provider,
    from: { history: first.history, state: first.state },
  });
  const afterTwo = strategy.panel(second.state, { turns: 2 });
  assert.deepEqual(
    afterTwo.task.map((row) => row.key).filter((key) => key.startsWith("open.")),
    ["open.graph_representation", "open.return_value"]
  );
  assert.equal(afterTwo.reads.through, 1);
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
      invariantStore: new MemoryInvariantStore(),
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
      invariantStore: new MemoryInvariantStore(),
      contextMessages: 10,
      profileStore,
      extractor: new StubExtractor(),
      promoter: new StubPromoter(),
      briefer: new StubBriefer(),
      summarizer: new StubSummarizer(),
    }),
  });
  await second.run("hello again");

  const system = provider.calls.at(-1).system;
  assert.match(system, /<profile>[\s\S]*preference\.tooling: never suggest Kubernetes/);
  // The block is there — every conversation starts in `planning`, and that
  // stage's instruction is most of what shapes its first few turns — but it
  // holds the stage and nothing else. None of the previous conversation's keys
  // came along.
  assert.match(system, /<working>[\s\S]*stage: planning/);
  assert.doesNotMatch(system, /goal:/, "the new conversation inherited a task it never had");
  assert.doesNotMatch(system, /constraint\./);
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
    strategyOptions: { profileStore, invariantStore: new MemoryInvariantStore() },
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

  const finished = await finish(strategy, { state, history });
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

test("the extractor is told to file the questions the assistant asked", async () => {
  const { strategy, extractor } = strategyWith({
    ops: [
      [{ op: "set", key: "goal", value: "set up a coding agent with invariants" }],
      [{ op: "set", key: "open.invariants", value: "Which rules must the agent never violate?" }],
    ],
  });
  const first = await converse(strategy, ["I need invariants my coding agent cannot violate"]);
  const { state } = await converse(strategy, ["I'll go for the prompt-based approach"], {
    from: { history: first.history, state: first.state },
  });

  // The clarifying question rides in with the assistant's half of the
  // exchange, which is the only reason the extractor can file it at all.
  assert.equal(extractor.calls[1].exchange[0].role, "assistant");
  assert.equal(state.working["open.invariants"].value, "Which rules must the agent never violate?");

  // And the prompt says so out loud. The planning instruction tells the model
  // that answers the turn to surface unknowns as open questions — but that
  // model cannot write memory at all, so unless the extractor is told to pick
  // them up, "point clarification at open.*" is a sentence with nothing
  // behind it and the guard on leaving planning has nothing real to check.
  const system = new StubProvider();
  await new MemoryExtractor({ provider: system }).extract({ exchange: [{ role: "user", content: "hi" }] });
  const prompt = system.calls[0].system;
  assert.match(prompt, /question the assistant asked and the user did not answer is an `open\.\*`/);
  // ...and the old blanket rule no longer contradicts it.
  assert.match(prompt, /with the single exception of an unanswered/);
});

// ---- the task lifecycle -----------------------------------------------------

test("the stage rides in <working>, and the same question in two stages is not the same prompt", async () => {
  const { strategy } = strategyWith({
    ops: [[{ op: "set", key: "goal", value: "migrate billing off Heroku" }]],
  });
  const first = await converse(strategy, ["help me move billing off Heroku"]);
  const from = { history: first.history, state: first.state };

  // The same next message, asked of the same memory, from two stages. The
  // only difference between the two runs is which stage the state is in.
  const planning = await converse(strategy, ["what's the weather?"], { from });
  const moved = await toExecution(strategy, { ...from });
  const executing = await converse(strategy, ["what's the weather?"], {
    from: { history: first.history, state: moved.state },
  });

  assert.match(planning.turns[0].system, /<working>[\s\S]*stage: planning/);
  assert.match(planning.turns[0].system, /STAGE — planning/);
  assert.equal(planning.turns[0].meta.stage, "planning");

  assert.match(executing.turns[0].system, /<working>[\s\S]*stage: execution/);
  assert.match(executing.turns[0].system, /STAGE — execution/);
  assert.doesNotMatch(executing.turns[0].system, /STAGE — planning/);

  // The keys are identical; the instruction is not. That difference is the
  // whole of what makes the machine more than a diagram of itself.
  assert.match(planning.turns[0].system, /goal: migrate billing off Heroku/);
  assert.match(executing.turns[0].system, /goal: migrate billing off Heroku/);
  assert.notEqual(planning.turns[0].system, executing.turns[0].system);
});

test("a model op on a frozen goal is a proposal; a person's op is a write", async () => {
  const { strategy } = strategyWith({
    ops: [
      [{ op: "set", key: "goal", value: "migrate billing off Heroku" }],
      // The drift: the same goal, rewritten in the vocabulary of whatever was
      // said last. In planning it would simply overwrite.
      [{ op: "set", key: "goal", value: "get the Fly.io deploy green" }],
    ],
  });
  const first = await converse(strategy, ["move billing off Heroku"]);
  const moved = await toExecution(strategy, { state: first.state, history: first.history });

  const second = await converse(strategy, ["what about the deploy?"], {
    from: { history: first.history, state: moved.state },
  });

  // Not written. The task has been committed to, and the model has read one
  // exchange while the user chose the goal on purpose.
  assert.equal(second.state.working.goal.value, "migrate billing off Heroku");
  assert.match(second.turns[0].system, /goal: migrate billing off Heroku/);
  assert.match(second.turns[0].meta.note, /goal is frozen/);

  // Kept, though — as the same correction proposal a contradicted long-term
  // entry becomes, where the person who set the goal can see both sentences.
  const proposal = second.state.proposals.find((p) => p.key === "goal");
  assert.equal(proposal.kind, "correction");
  assert.equal(proposal.reason, "frozen");
  assert.equal(proposal.was, "migrate billing off Heroku");

  // The panel marks the row, so a refusal nobody can see is not mistaken for
  // an extractor that has quietly stopped working.
  const row = strategy.panel(second.state, { turns: 2 }).task.find((r) => r.key === "goal");
  assert.equal(row.frozen, true);

  // And a person answering that proposal writes it, to working memory rather
  // than to the profile: it is this task's goal, not a fact about the user.
  const answered = await strategy.answerProposal({
    state: second.state,
    id: proposal.id,
    action: "approve",
    turns: 2,
  });
  assert.equal(answered.state.working.goal.value, "get the Fly.io deploy green");
});

test("going back to planning thaws the goal", async () => {
  const { strategy } = strategyWith({
    ops: [
      [{ op: "set", key: "goal", value: "migrate billing off Heroku" }],
      [{ op: "set", key: "goal", value: "decide whether to migrate at all" }],
    ],
  });
  const first = await converse(strategy, ["move billing off Heroku"]);
  let moved = await toExecution(strategy, { state: first.state, history: first.history });
  assert.equal(moved.ok, true, moved.note);
  moved = await strategy.transition({ state: moved.state, to: "planning", history: first.history, provider: new StubProvider() });
  assert.equal(moved.ok, true, moved.note);
  const state = moved.state;

  const second = await converse(strategy, ["actually, should we?"], {
    from: { history: first.history, state },
  });
  // `execution → planning` is the edge you press when the goal is the thing
  // that was wrong, so the goal had better be writable on the other side.
  assert.equal(second.state.working.goal.value, "decide whether to migrate at all");
  assert.deepEqual(second.state.proposals, []);
});

test("→ done is the only way a task closes, and it closes exactly once", async () => {
  const { strategy, promoter, state, history, profileStore } = await aTask();
  const provider = new StubProvider();

  // Not from here. The promotion call has not happened and working memory is
  // untouched, because the edge does not exist.
  const skipped = await strategy.transition({ state, to: "done", history, provider });
  assert.equal(skipped.ok, false);
  assert.equal(promoter.calls.length, 0, "a refused edge ran the promotion call");
  assert.equal(Object.keys(skipped.state.working).length, 3);
  assert.equal(skipped.state.pastTasks.length, 0);

  const finished = await finish(strategy, { state, history, provider });
  assert.equal(finished.ok, true);
  assert.equal(promoter.calls.length, 1);
  assert.deepEqual(Object.keys(finished.state.working), []);
  assert.equal(finished.state.pastTasks.length, 1);
  // The archive keeps the route, not just the date: a task that went through
  // validation twice was a different piece of work from one that did not.
  assert.equal(finished.state.pastTasks[0].stage, "done");
  assert.deepEqual(
    finished.state.pastTasks[0].transitions.map((entry) => entry.to),
    ["execution", "validation", "done"]
  );

  // Terminal. Every further attempt is refused, so the promotion call cannot
  // run a second time on the same task — it is a property of the table rather
  // than a flag somebody has to remember to set.
  for (const to of ["done", "validation", "planning", "execution"]) {
    const again = await strategy.transition({ state: finished.state, to, history, provider });
    assert.equal(again.ok, false, `done → ${to} was allowed`);
  }
  assert.equal(promoter.calls.length, 1);

  // Resuming is a new task that references the old one.
  const next = strategy.startTask({ state: finished.state });
  assert.equal(next.ok, true);
  const lifecycle = strategy.panel(next.state, { turns: 2 }).lifecycle;
  assert.equal(lifecycle.stage, "planning");
  assert.deepEqual(lifecycle.log, []);
  assert.equal(lifecycle.previous, finished.state.task.id);
  // ...and the closed one is still in the archive, still not being sent.
  assert.equal(next.state.pastTasks.length, 1);
  assert.deepEqual(Object.keys((await profileStore.load("local")).entries), []);
});

test("a failed promotion call leaves the stage where it was", async () => {
  const { state, history } = await aTask();
  const broken = new MemoryStrategy({
    invariantStore: new MemoryInvariantStore(),
    contextMessages: 10,
    profileStore: new MemoryProfileStore(),
    extractor: new StubExtractor(),
    promoter: new StubPromoter({ fail: true }),
    briefer: new StubBriefer(),
    summarizer: new StubSummarizer(),
  });

  const finished = await finish(broken, { state, history });
  assert.equal(finished.ok, false);
  // Half a close — the stage says finished, working memory is still full, and
  // nothing was ever proposed — is the one outcome worth refusing, because
  // `done` cannot be left and so it cannot be retried either.
  assert.equal(stageOf(finished.state.task), "validation");
  assert.equal(Object.keys(finished.state.working).length, 3);
  assert.equal(finished.state.pastTasks.length, 0);
});

test("the model's step and actor are written; its stage is only ever a suggestion", async () => {
  const { strategy } = strategyWith({
    ops: [
      [
        { op: "set", key: "goal", value: "migrate billing off Heroku" },
        { op: "step", value: "writing the migration script" },
        { op: "awaiting", actor: "user", what: "confirm the March 14 date" },
        { op: "stage", to: "execution", reason: "the goal is settled" },
      ],
    ],
  });
  const { state, turns } = await converse(strategy, ["move billing off Heroku"]);
  const lifecycle = strategy.panel(state, { turns: 1 }).lifecycle;

  assert.equal(lifecycle.stage, "planning", "a model changed the stage");
  assert.equal(lifecycle.step, "writing the migration script");
  assert.deepEqual(lifecycle.expectedAction, { actor: "user", what: "confirm the March 14 date" });
  assert.deepEqual(lifecycle.suggestion.to, "execution");
  assert.match(turns[0].meta.note, /suggests → execution, waiting for a click/);

  // The suggestion rides beside the button for the edge it names, and that
  // button is a real edge out of the stage we are actually in.
  assert.deepEqual(lifecycle.edges.map((edge) => edge.to), ["execution"]);
  assert.equal(lifecycle.edges[0].allowed, true);

  // The block tells the model where it is. It is never asked.
  assert.match(turns[0].system, /step: writing the migration script/);
  assert.match(turns[0].system, /awaiting: the user — confirm the March 14 date/);
});

test("leaving planning writes a brief, and the brief is what replaces the conversation", async () => {
  const { strategy, briefer } = strategyWith({
    ops: [
      [
        { op: "set", key: "goal", value: "migrate billing off Heroku" },
        { op: "set", key: "constraint.database", value: "Postgres 14" },
      ],
    ],
  });
  const first = await converse(strategy, ["move billing off Heroku, we must stay on Postgres 14"]);

  // The click writes a brief and **does not move**. A task sitting in
  // execution with an unreviewed brief would be running on exactly the
  // messages the brief was meant to replace.
  const written = await strategy.transition({
    state: first.state,
    to: "execution",
    history: first.history,
    provider: new StubProvider(),
  });
  assert.equal(written.ok, true);
  assert.equal(written.awaitingBrief, true);
  assert.equal(written.state.brief.status, "pending");
  assert.equal(stageOf(written.state.task), "planning", "the stage moved before anyone read the brief");
  assert.deepEqual(written.state.task.transitions, []);

  // It was shown the store and the conversation — it has to be, since it is
  // the only thing carrying either of them forward.
  assert.deepEqual(briefer.calls[0].entries.map((e) => e.key), ["goal", "constraint.database"]);
  assert.equal(briefer.calls[0].messages.length, 2);

  // Nothing is on the wire yet: a pending brief changes no payload.
  const still = await strategy.buildPayload({
    history: [...first.history, { role: "user", content: "anything" }],
    systemPrompt: "persona",
    state: written.state,
    provider: new StubProvider(),
  });
  assert.doesNotMatch(still.system, /<brief>/);
  assert.equal(still.messages.length, 3, "a pending brief dropped messages");

  // Accepting it is what leaves planning — and the edit is what gets stored,
  // because this is the moment a person is allowed to disagree with what the
  // model understood.
  const accepted = await strategy.answerBrief({
    state: written.state,
    history: first.history,
    action: "accept",
    text: "THE BRIEF\nMove billing off Heroku. Postgres 14 is fixed by compliance.",
  });
  assert.equal(accepted.ok, true);
  assert.equal(stageOf(accepted.state.task), "execution");
  assert.equal(accepted.state.brief.status, "accepted");
  assert.equal(accepted.state.brief.edited, true);
  assert.equal(accepted.state.brief.through, first.history.length);

  // Now it is on the wire, and the planning conversation is not.
  const next = await converse(strategy, ["carry on"], {
    from: { history: first.history, state: accepted.state },
  });
  const built = next.turns[0];
  assert.match(built.system, /<brief>[\s\S]*Postgres 14 is fixed by compliance/);
  assert.match(built.system, /<working>[\s\S]*stage: execution/);
  assert.equal(built.meta.layers.brief, 1);
  assert.equal(built.meta.droppedMessages, first.history.length);
  assert.deepEqual(built.messages.map((m) => m.content), ["carry on"]);
  // The block is before the digest and after the keys — long form of the same
  // subject, next to the short form.
  assert.match(built.system, /<working>[\s\S]*<\/working>[\s\S]*<brief>/);
});

test("what the brief leaves open becomes keys, and the accept is the write", async () => {
  const { strategy, briefer } = strategyWith({
    ops: [[{ op: "set", key: "goal", value: "Implement a generic DFS" }]],
  });
  briefer.open = [
    { key: "open.graph_representation", question: "How is the graph provided?" },
    { key: "open.return_type", question: "What should DFS return?" },
    { key: "open.node_type", question: "Generic, or a specific node type?" },
  ];

  const provider = new StubProvider();
  const talk = await converse(strategy, ["build me a DFS"], { provider });
  const written = await strategy.transition({ state: talk.state, to: "execution", history: talk.history, provider });

  // A proposal, like everything else a model produces at an edge: the brief
  // has been saying this in prose all along, and prose is read once and gone.
  assert.equal(written.awaitingBrief, true);
  assert.equal(written.state.brief.open.length, 3);
  assert.ok(!Object.keys(written.state.working).some((key) => key.startsWith("open.")));

  // The accept is what writes them — and one was answered in the box, so it
  // is named as dropped. **What to leave out, never what to keep**: a caller
  // that says nothing records everything, which is the direction this has to
  // fail in.
  const accepted = await strategy.answerBrief({
    state: written.state,
    history: talk.history,
    action: "accept",
    drop: ["open.node_type"],
  });

  assert.equal(accepted.ok, true);
  assert.deepEqual(
    Object.keys(accepted.state.working).filter((key) => key.startsWith("open.")).sort(),
    ["open.graph_representation", "open.return_type"]
  );
  assert.equal(accepted.state.working["open.return_type"].value, "What should DFS return?");
  assert.match(accepted.note, /2 open questions recorded/);
  assert.match(accepted.note, /1 you dropped/);

  // ...which is the whole point: the questions are now in a form the machine
  // can read, so the edge that walks away from them says so. Before this they
  // existed only in the brief's prose and `→ done` went through in silence.
  const panel = strategy.panel(accepted.state, { turns: Infinity });
  assert.equal(panel.task.filter((row) => row.namespace === "open").length, 2);

  const checking = await strategy.transition({ state: accepted.state, to: "validation", history: talk.history, provider });
  const done = strategy
    .panel(checking.state, { turns: Infinity })
    .lifecycle.edges.find((edge) => edge.to === "done");
  assert.match(done.warning ?? "", /2 questions are still unanswered/);
  assert.match(done.warning, /open\.graph_representation/);
});

test("the brief cannot say one thing in prose and another in keys", async () => {
  const { strategy, briefer } = strategyWith({
    ops: [[{ op: "set", key: "goal", value: "Implement a generic DFS" }]],
  });
  // The brief says three questions are open and hands back no keys for them.
  // One model, one call, two halves that drift — and it used to resolve
  // silently in favour of the half nothing downstream can read: the prose read
  // fine and the task simply never held them.
  briefer.text = [
    "The task — Implement a generic DFS in Kotlin.",
    "",
    "Constraints — Kotlin only; no recursion.",
    "",
    "Still open — Adjacency list or matrix? What should it return? Generic node type or Int?",
  ].join("\n");
  briefer.open = [];

  const provider = new StubProvider();
  const talk = await converse(strategy, ["build me a DFS"], { provider });
  const written = await strategy.transition({ state: talk.state, to: "execution", history: talk.history, provider });

  assert.equal(written.state.brief.open.length, 3, "the prose section was not read");
  // Read out of prose, so planning certainly did not record them — and they
  // sit in the editor behind a × like everything else it did not record.
  assert.ok(written.state.brief.open.every((row) => row.recorded === false));

  const accepted = await strategy.answerBrief({ state: written.state, history: talk.history, action: "accept" });
  assert.equal(
    Object.keys(accepted.state.working).filter((key) => key.startsWith("open.")).length,
    3
  );
  // ...and the prose is untouched: the person still reads the brief they were
  // shown, headings and all.
  assert.match(accepted.state.brief.text, /Still open/);
});

test("a brief with no open section at all is left alone", async () => {
  const { strategy, briefer } = strategyWith({
    ops: [[{ op: "set", key: "goal", value: "Ship it" }]],
  });
  briefer.text = "The task — Ship the thing.\n\nConstraints — None stated.";
  briefer.open = [];

  const provider = new StubProvider();
  const talk = await converse(strategy, ["ship it"], { provider });
  const written = await strategy.transition({ state: talk.state, to: "execution", history: talk.history, provider });
  assert.deepEqual(written.state.brief.open, []);
});

test("a question planning never recorded is marked, not trusted", async () => {
  const { strategy, briefer } = strategyWith({
    ops: [[
      { op: "set", key: "goal", value: "Implement a generic DFS" },
      { op: "set", key: "open.graph_representation", value: "How is the graph provided?" },
    ]],
  });
  briefer.open = [
    // One the extractor wrote down during planning...
    { key: "open.graph_representation", question: "How is the graph provided?" },
    // ...and two the brief thought of on its own. A `Still open` heading is a
    // box, and a model asked to fill one writes the questions it *would* ask.
    // They read to the person accepting the brief as something they ignored,
    // and are then recorded against their task as unanswered forever.
    { key: "open.bounds", question: "What if the starting index is out of bounds?" },
    { key: "open.null_input", question: "Should it handle null input?" },
  ];

  const provider = new StubProvider();
  const talk = await converse(strategy, ["build me a DFS"], { provider });
  const written = await strategy.transition({ state: talk.state, to: "execution", history: talk.history, provider });

  const marked = new Map(written.state.brief.open.map((row) => [row.key, row.recorded]));
  assert.equal(marked.get("open.graph_representation"), true);
  assert.equal(marked.get("open.bounds"), false);
  assert.equal(marked.get("open.null_input"), false);

  // Marked, never resolved. Code cannot tell a real question from a plausible
  // one, so it says which ones planning wrote down and leaves the rest to a
  // person — who can drop them, and whose choice is still what writes.
  const accepted = await strategy.answerBrief({
    state: written.state,
    history: talk.history,
    action: "accept",
    drop: ["open.bounds", "open.null_input"],
  });
  assert.deepEqual(
    Object.keys(accepted.state.working).filter((key) => key.startsWith("open.")),
    ["open.graph_representation"]
  );
});

test("a caller that says nothing about the open questions records all of them", async () => {
  const { strategy, briefer } = strategyWith({
    ops: [[{ op: "set", key: "goal", value: "Implement a generic DFS" }]],
  });
  briefer.open = [
    { key: "open.graph_representation", question: "How is the graph provided?" },
    { key: "open.return_type", question: "What should DFS return?" },
  ];

  const provider = new StubProvider();
  const talk = await converse(strategy, ["build me a DFS"], { provider });
  const written = await strategy.transition({ state: talk.state, to: "execution", history: talk.history, provider });

  // No list, a stale one, an empty one: all of them mean *record everything*.
  // Asking the caller to name what to keep meant any mismatch threw the record
  // away silently, which is indistinguishable from the feature being broken.
  for (const answer of [{}, { drop: [] }, { drop: ["open.nothing_like_this"] }]) {
    const accepted = await strategy.answerBrief({
      state: written.state,
      history: talk.history,
      action: "accept",
      ...answer,
    });
    assert.deepEqual(
      Object.keys(accepted.state.working).filter((key) => key.startsWith("open.")).sort(),
      ["open.graph_representation", "open.return_type"],
      `answering with ${JSON.stringify(answer)} lost the record`
    );
  }
});

test("a brief with nothing left open records nothing and warns about nothing", async () => {
  const { strategy, briefer } = strategyWith({
    ops: [[{ op: "set", key: "goal", value: "Ship the thing" }]],
  });
  briefer.open = [];

  const provider = new StubProvider();
  const talk = await converse(strategy, ["ship it"], { provider });
  const written = await strategy.transition({ state: talk.state, to: "execution", history: talk.history, provider });
  const accepted = await strategy.answerBrief({ state: written.state, history: talk.history, action: "accept" });

  assert.ok(!Object.keys(accepted.state.working).some((key) => key.startsWith("open.")));
  assert.equal(accepted.warning, null);
  assert.ok(!/open question/.test(accepted.note));
});

test("a discarded brief leaves planning exactly as it was", async () => {
  const { strategy } = strategyWith({
    ops: [[{ op: "set", key: "goal", value: "migrate billing off Heroku" }]],
  });
  const first = await converse(strategy, ["move billing off Heroku"]);
  const written = await strategy.transition({
    state: first.state,
    to: "execution",
    history: first.history,
    provider: new StubProvider(),
  });

  const kept = await strategy.answerBrief({ state: written.state, history: first.history, action: "discard" });
  assert.equal(kept.state.brief, null);
  assert.equal(stageOf(kept.state.task), "planning");
  assert.deepEqual(kept.state.task.transitions, []);
  // ...and the goal is still writable, because the task never committed.
  assert.deepEqual(strategy.panel(kept.state, { turns: 1 }).lifecycle.frozen, []);

  // Answering a brief that is not there is a mistake, not a silent no-op.
  await assert.rejects(
    () => strategy.answerBrief({ state: kept.state, history: first.history, action: "accept" }),
    /no brief waiting/i
  );
});

test("a failed brief leaves the task in planning with nothing pending", async () => {
  const profileStore = new MemoryProfileStore();
  const strategy = new MemoryStrategy({
    invariantStore: new MemoryInvariantStore(),
    contextMessages: 10,
    profileStore,
    extractor: new StubExtractor({ ops: [[{ op: "set", key: "goal", value: "ship it" }]] }),
    promoter: new StubPromoter(),
    briefer: new StubBriefer({ fail: true }),
    summarizer: new StubSummarizer(),
  });
  const first = await converse(strategy, ["ship it"]);

  const written = await strategy.transition({
    state: first.state,
    to: "execution",
    history: first.history,
    provider: new StubProvider(),
  });
  // Failure degrades to *nothing happened*. Moving anyway would drop the
  // planning messages and put nothing in their place, which is worse than
  // either half on its own.
  assert.equal(written.ok, false);
  assert.equal(written.state.brief, null);
  assert.equal(stageOf(written.state.task), "planning");
  assert.match(written.note, /try again/);
});

test("the closed task keeps its brief, and the next one does not inherit it", async () => {
  const { strategy, state, history } = await aTask();
  const finished = await finish(strategy, { state, history });

  // Cleared with the keys, and for the same reason: it describes work that is
  // over. Left on the wire it would go on telling every later turn what this
  // finished task was about.
  assert.equal(finished.state.brief, null);
  const panel = strategy.panel(finished.state, { turns: 2 });
  assert.match(panel.pastTasks[0].brief, /THE BRIEF/);

  const next = strategy.startTask({ state: finished.state });
  assert.equal(next.state.brief, null);
  const built = await strategy.buildPayload({
    history: [...history, { role: "user", content: "something new" }],
    systemPrompt: "persona",
    state: next.state,
    provider: new StubProvider(),
  });
  assert.doesNotMatch(built.system, /<brief>/);
});

test("the messages the brief replaced do not come back when the task closes", async () => {
  const { strategy, state, history } = await aTask();
  const finished = await finish(strategy, { state, history });

  // The brief itself is gone — it describes finished work — but the floor it
  // set is not. Tying the floor to the object's lifetime put a whole planning
  // conversation back on the wire the moment the task closed, with the thing
  // that had replaced it already cleared.
  assert.equal(finished.state.brief, null);
  assert.equal(finished.state.briefThrough, history.length);

  const after = [...history, { role: "user", content: "what now?" }];
  const built = await strategy.buildPayload({
    history: after,
    systemPrompt: "persona",
    state: finished.state,
    provider: new StubProvider(),
  });
  assert.equal(built.meta.droppedMessages, history.length);
  assert.deepEqual(built.messages.map((m) => m.content), ["what now?"]);
  // Gone, and not replaced by anything either: the task is over.
  assert.doesNotMatch(built.system, /<brief>/);

  // ...and a successor task does not resurrect them either.
  const next = strategy.startTask({ state: finished.state });
  const later = await strategy.buildPayload({
    history: after,
    systemPrompt: "persona",
    state: next.state,
    provider: new StubProvider(),
  });
  assert.equal(later.meta.droppedMessages, history.length);
});

test("a fork cannot inherit a stage its own branch never reached", async () => {
  const { strategy } = strategyWith({
    ops: [
      [{ op: "set", key: "goal", value: "migrate billing off Heroku" }],
      [],
      [{ op: "step", value: "writing the migration script" }],
    ],
  });
  const first = await converse(strategy, ["move billing off Heroku"]);
  const second = await converse(strategy, ["and the constraints are fixed"], {
    from: { history: first.history, state: first.state },
  });

  // Two exchanges in, the parent commits to the goal and gets on with it.
  const moved = await toExecution(strategy, { state: second.state, history: second.history });
  const parent = await converse(strategy, ["carry on then"], {
    from: { history: second.history, state: moved.state },
  });
  assert.equal(strategy.panel(parent.state, { turns: 3 }).lifecycle.stage, "execution");

  // A branch forked back at the **first** exchange carries a copy of all of
  // that: the transition stamped after turn 2, and the step line from turn 3.
  const forked = structuredClone(parent.state);
  const built = await strategy.buildPayload({
    history: [
      { role: "user", content: "move billing off Heroku" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "actually, hold on" },
    ],
    systemPrompt: "persona",
    state: forked,
    provider: new StubProvider(),
  });

  // None of it came along. A fork that inherited a `validation` its own branch
  // never reached does not read as a storage bug from the outside — it reads
  // as the agent insisting on work nobody here ever asked for, with every
  // stage line telling the model something false about where it is.
  assert.match(built.system, /stage: planning/);
  assert.doesNotMatch(built.system, /stage: execution/);
  assert.doesNotMatch(built.system, /writing the migration script/);
  assert.equal(built.meta.stage, "planning");
  assert.deepEqual(built.state.task.transitions, []);
  // ...and with the goal thawed again, because this branch never froze it.
  assert.deepEqual(strategy.panel(built.state, { turns: 2 }).lifecycle.frozen, []);

  // What the parent established *before* the fork still comes along, exactly
  // as working memory does. The rule is "not from further down another
  // branch", not "nothing at all".
  assert.match(built.system, /goal: migrate billing off Heroku/);
});

test("a mid-flight task survives a restart, and the resume line is a render", async () => {
  const profileStore = new MemoryProfileStore();
  const provider = new StubProvider();
  const store = new MemoryStore();
  const options = {
    provider,
    store,
    sessionId: SESSION,
    strategy: "memory",
    strategyOptions: { profileStore, invariantStore: new MemoryInvariantStore() },
  };

  const agent = new Agent({
    ...options,
    strategy: new MemoryStrategy({
      invariantStore: new MemoryInvariantStore(),
      contextMessages: 10,
      profileStore,
      extractor: new StubExtractor({
        ops: [
          [
            { op: "set", key: "goal", value: "migrate billing off Heroku" },
            { op: "set", key: "constraint.database", value: "Postgres 14" },
          ],
        ],
      }),
      promoter: new StubPromoter(),
      briefer: new StubBriefer(),
      summarizer: new StubSummarizer(),
    }),
  });
  await agent.run("move billing off Heroku");

  // The click, exactly as the route does it: read the record, hand the state
  // to a strategy that holds no conversation, write the record back.
  const strategy = new MemoryStrategy({ profileStore, invariantStore: new MemoryInvariantStore() });
  const record = await store.load(SESSION);
  const moved = await toExecution(strategy, {
    state: record.branches.main.strategyState.memory,
    history: getBranchHistory(record, "main"),
    provider,
  });
  assert.equal(moved.ok, true, moved.note);
  await writeState(store, moved.state);

  // The cached Agent is holding the state as it was a moment ago, so the route
  // drops it. Left in place it would write that back over this on the next
  // turn, and the stage would silently revert.
  const after = await Agent.load({
    ...options,
    strategy: new MemoryStrategy({
      invariantStore: new MemoryInvariantStore(),
      contextMessages: 10,
      profileStore,
      extractor: new StubExtractor({ ops: [[{ op: "step", value: "writing the migration script" }]] }),
      promoter: new StubPromoter(),
      briefer: new StubBriefer(),
      summarizer: new StubSummarizer(),
    }),
  });
  await after.run("what next?");

  // A brand new Agent, as `npm start` would build one — nothing in memory,
  // everything off the store.
  const resumed = await Agent.load({
    ...options,
    strategy: new MemoryStrategy({
      invariantStore: new MemoryInvariantStore(),
      contextMessages: 10,
      profileStore,
      extractor: new StubExtractor(),
      promoter: new StubPromoter(),
      briefer: new StubBriefer(),
      summarizer: new StubSummarizer(),
    }),
  });

  const lifecycle = resumed.panel().lifecycle;
  assert.equal(lifecycle.stage, "execution");
  assert.equal(lifecycle.step, "writing the migration script");
  assert.equal(lifecycle.expectedAction.actor, "agent");
  // Everything the banner says comes out of this object, so composing it is a
  // render rather than a model call — and it is identical either side of the
  // restart.
  assert.deepEqual(lifecycle.log.map((entry) => `${entry.from}→${entry.to}`), ["planning→execution"]);
  assert.equal(lifecycle.log[0].turn, 1, "the divider would be drawn in the wrong place");
  assert.deepEqual(lifecycle.frozen, ["goal"]);

  // ...and the next turn continues the work rather than asking what it was.
  const { meta } = await resumed.run("carry on");
  assert.equal(meta.strategy.panel.lifecycle.stage, "execution");
  assert.match(provider.calls.at(-1).system, /stage: execution/);
  assert.match(provider.calls.at(-1).system, /goal: migrate billing off Heroku/);
});

/** The other half of what a route does: put the changed state back. */
async function writeState(store, state) {
  const saved = await store.load(SESSION);
  saved.branches.main.strategyState = { ...saved.branches.main.strategyState, memory: state };
  await store.save(SESSION, saved.messages, saved.usage, {
    branches: saved.branches,
    activeBranchId: saved.activeBranchId,
  });
}

/** `describe()` is private; this reads its output off an applied patch. */
function describeOf(applied) {
  const parts = [];
  if (applied.set.length) parts.push("set");
  const declared = applied.contested.filter((row) => row.reason === "declared").length;
  if (declared) parts.push(`${declared} held back by what you declared`);
  return parts.join(", ");
}
