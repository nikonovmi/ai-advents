import assert from "node:assert/strict";
import test from "node:test";

import { MemoryInvariantStore, subjectOf } from "../store/invariantStore.js";
import { MemoryProfileStore, emptyProfile } from "../store/profileStore.js";
import { invariantsBlock } from "./invariants.js";
import { MemoryStrategy, ROUTES, applyOps, routeFor } from "./memory.js";
import { STAGE_PROMPTS, splitTaskOps, applyTaskOps, emptyTask, stageOf } from "./taskState.js";

/**
 * **Invariants: the rules a project does not break.**
 *
 * The tests below are one claim each. Three of them are the
 * ones worth having:
 *
 *   - the extractor cannot write the namespace, at any stage, by any door;
 *   - nothing lands on a subject a rule owns without a human seeing it;
 *   - the block is on the wire in every stage, including `done`.
 *
 * Everything else here holds those three up.
 */

/** A provider that answers instantly and remembers what it was asked. */
class StubProvider {
  calls = [];

  async complete({ system, messages }) {
    this.calls.push({ system, messages });
    return { text: "[]", model: "stub", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };
  }

  async countTokens({ messages }) {
    return { inputTokens: messages.length };
  }
}

class StubExtractor {
  calls = [];
  #scripted;

  constructor({ ops = [] } = {}) {
    this.#scripted = ops;
  }

  async extract(params) {
    const index = this.calls.length;
    this.calls.push(params);
    return {
      ops: Array.isArray(this.#scripted[index]) ? this.#scripted[index] : [],
      usage: { inputTokens: 60, outputTokens: 12 },
      model: "stub",
      ms: 1,
    };
  }
}

/** A promoter that offers back exactly what a test tells it to. */
class StubPromoter {
  calls = [];
  #scripted;

  constructor({ proposals = null } = {}) {
    this.#scripted = proposals;
  }

  async propose({ entries, context }) {
    this.calls.push({ entries, context });
    return {
      proposals: this.#scripted ?? entries.map((entry) => ({ key: entry.key, value: `Standing alone: ${entry.value}` })),
      usage: { inputTokens: 80, outputTokens: 30 },
      model: "stub",
      ms: 1,
    };
  }
}

class StubBriefer {
  calls = [];
  open = [];

  async write({ entries, messages, invariants }) {
    this.calls.push({ entries, messages, invariants });
    return { text: "THE BRIEF", open: this.open, usage: { inputTokens: 200, outputTokens: 90 }, model: "stub", ms: 1 };
  }
}

/** A proposer that hands back whatever rows a test scripted, verbatim. */
class StubProposer {
  calls = [];
  #scripted;
  #fail;

  constructor({ rows = [], fail = false } = {}) {
    this.#scripted = rows;
    this.#fail = fail;
  }

  async propose(params) {
    this.calls.push(params);
    if (this.#fail) throw new Error("proposer is down");
    return { rows: this.#scripted, usage: { inputTokens: 40, outputTokens: 30 }, model: "stub", ms: 1 };
  }
}

class StubSummarizer {
  async summarize() {
    return { text: "digest", usage: { inputTokens: 100, outputTokens: 40 }, model: "stub", ms: 1 };
  }
}

function strategyWith({ ops = [], rows = [], proposals = null, ...rest } = {}) {
  const extractor = new StubExtractor({ ops });
  const proposer = new StubProposer({ rows });
  const promoter = new StubPromoter({ proposals });
  const invariantStore = new MemoryInvariantStore();
  const profileStore = new MemoryProfileStore();
  const strategy = new MemoryStrategy({
    contextMessages: 10,
    profileStore,
    invariantStore,
    project: "demo",
    extractor,
    proposer,
    promoter,
    briefer: new StubBriefer(),
    summarizer: new StubSummarizer(),
    ...rest,
  });
  return { strategy, extractor, proposer, promoter, profileStore, invariantStore };
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

/** The one door into the namespace: a person, through `/memory/ops`. */
function authored(key, text, check) {
  return { op: "set", key, value: text, check };
}

const POSTGRES = authored("invariant.database", "Stays on Postgres.", "any proposal introducing another engine");
const NO_ORM = authored("invariant.orm", "No ORM; SQL is written by hand.", "any proposal importing an ORM");

// ---- the namespace ----------------------------------------------------------

test("invariant is long-term, person-only, and kept with the project", () => {
  const route = routeFor("invariant.database");
  assert.equal(route.namespace, "invariant");
  assert.equal(route.layer, "longterm");
  assert.equal(route.evict, "never");
  assert.equal(route.personOnly, true);
  assert.equal(route.project, true);

  // It is the only namespace with either flag. If a second one ever acquires
  // them, the rules here have to be decided for it too rather than inherited.
  const personOnly = Object.keys(ROUTES).filter((namespace) => ROUTES[namespace].personOnly);
  assert.deepEqual(personOnly, ["invariant"]);

  // `rule` stayed where it was, and that is the resolution of the overlap:
  // `rule` is how the user likes to be worked with, `invariant` is what the
  // project cannot do. The extractor may still write the first.
  assert.equal(routeFor("rule.emdash").personOnly, false);
  assert.equal(routeFor("rule.emdash").layer, "longterm");

  // A bare `invariant` has no subject, so it owns nothing and collides with
  // nothing — and it is refused for the same reason a bare `profile` is.
  assert.equal(subjectOf("invariant.database"), "database");
  assert.equal(subjectOf("goal"), "");
});

// ---- person-only: the extractor may never write it -----------------------------------

test("the extractor cannot write an invariant, at any stage, including at → done", async () => {
  const { strategy, profileStore, invariantStore } = strategyWith({
    ops: [
      // Every shape the model could reach for, in the stage where each would
      // be most plausible.
      [{ op: "set", key: "invariant.database", value: "Stays on MySQL" }],
      [{ op: "set", key: "goal", value: "Move billing off Heroku" }],
      [{ op: "set", key: "invariant.orm", value: "Prisma everywhere" }],
      [{ op: "delete", key: "invariant.database" }],
      [{ op: "set", key: "decision.engine", value: "Sticking with Postgres" }],
    ],
    // ...and the last door: the task-boundary promotion, whose sentences a
    // *human* clicks yes on. A model drafted them, so they may not land here.
    proposals: [{ key: "invariant.deploy", value: "Deploys go through CI only" }],
  });

  const provider = new StubProvider();
  const first = await converse(strategy, ["one", "two", "three", "four"], { provider });
  assert.deepEqual(Object.keys((await invariantStore.load("demo")).entries), []);
  assert.deepEqual(Object.keys((await profileStore.load("local")).entries), []);

  // The refusal is said out loud rather than swallowed: a model proposal that
  // went nowhere and a turn where nothing was proposed are different events.
  const panel = strategy.panel(first.state, { turns: Infinity });
  const reasons = panel.discarded.map((row) => row.reason);
  assert.ok(
    reasons.some((reason) => /yours to write/.test(reason)),
    `expected a person-only refusal, got ${JSON.stringify(reasons)}`
  );

  // Now the whole lifecycle, ending in `done` — the door that is easiest to
  // leave open, because a human does click a button on the way through it.
  const written = await strategy.transition({ state: first.state, to: "execution", history: first.history, provider });
  const accepted = await strategy.answerBrief({ state: written.state, history: first.history, action: "accept" });
  const fifth = await converse(strategy, ["five"], { provider, from: { history: first.history, state: accepted.state } });
  const checked = await strategy.transition({ state: fifth.state, to: "validation", history: fifth.history, provider });
  const closed = await strategy.transition({ state: checked.state, to: "done", history: fifth.history, provider });

  assert.equal(stageOf(closed.state.task), "done");
  // The promotion offer is never even made: an invariant is written, not
  // promoted, so nobody is invited to approve something that cannot land.
  assert.deepEqual(closed.proposals.filter((p) => p.key.startsWith("invariant.")), []);
  assert.deepEqual(Object.keys((await invariantStore.load("demo")).entries), []);
});

test("a promote onto an invariant key is refused even when a person sends it", () => {
  const applied = applyOps(
    { working: { "invariant.orm": { value: "No ORM" } }, profile: emptyProfile() },
    [{ op: "promote", key: "invariant.orm", value: "No ORM; SQL by hand" }],
    { allow: ["promote"], origin: "person" }
  );

  assert.deepEqual(applied.promoted, []);
  assert.deepEqual(Object.keys(applied.invariants.entries), []);
  assert.match(applied.discarded[0].reason, /drafted by a model/);
});

// ---- authoring: typed prose in, structured proposals out ---------------------------

test("the propose route returns amend, not add, when the subject already has a rule", async () => {
  const { strategy, proposer } = strategyWith({
    rows: [
      { action: "add", key: "invariant.database", subject: "database", text: "Stays on Postgres 14.", check: "another engine", reason: null, suggest: null },
      { action: "add", key: "invariant.orm", subject: "orm", text: "No ORM.", check: "an ORM import", reason: null, suggest: null },
    ],
  });
  const provider = new StubProvider();

  // One rule is already stored, and the model — told or not — came back with
  // `add` for it. The row is corrected in code, because a rule decided in code
  // is a rule that holds on the run where the model was having an off day.
  const seeded = await strategy.applyPanelOps({ state: strategy.emptyState(), ops: [POSTGRES] });
  const proposed = await strategy.proposeInvariants({ state: seeded.state, text: "postgres 14, and no ORM", provider });

  const database = proposed.rows.find((row) => row.key === "invariant.database");
  assert.equal(database.action, "amend");
  assert.equal(database.current, "Stays on Postgres.");
  assert.ok(database.supersedes, "an amendment names the entry it replaces");

  const orm = proposed.rows.find((row) => row.key === "invariant.orm");
  assert.equal(orm.action, "add");
  assert.equal(orm.supersedes, null);

  // Read-only: the call writes nothing, and that is what keeps the namespace
  // person-only while still letting rules be authored by typing a sentence.
  assert.deepEqual(Object.keys((await strategy.invariantStore.load("demo")).entries), ["invariant.database"]);
  assert.equal(proposer.calls.length, 1);
  // It is shown the rules and the long-term entries, which is what lets it
  // tell an amendment from an addition at all.
  assert.equal(proposer.calls[0].invariants.length, 1);
});

test("a rule with no usable check comes back as a reject, with somewhere else to put it", async () => {
  const { strategy } = strategyWith({
    rows: [
      // The model did as it was told for the first, and did not for the
      // second — which is the case the coercion exists for.
      { action: "reject", key: "invariant.style", subject: "style", text: "", check: "", reason: "this is a preference, not an invariant", suggest: { key: "preference.style", value: "Likes clean code" } },
      { action: "add", key: "invariant.quality", subject: "quality", text: "Code should be good.", check: "", reason: null, suggest: null },
    ],
  });
  const proposed = await strategy.proposeInvariants({
    state: strategy.emptyState(),
    text: "keep the code clean, and make it good",
    provider: new StubProvider(),
  });

  assert.equal(proposed.rows[0].action, "reject");
  assert.equal(proposed.rows[0].suggest.key, "preference.style");

  const coerced = proposed.rows[1];
  assert.equal(coerced.action, "reject", "an invariant with no check is not an invariant");
  assert.match(coerced.reason, /preference, not an invariant/);
  assert.equal(coerced.suggest.key, "preference.quality");

  // Nothing with a missing check can reach the store even if it is accepted.
  const applied = await strategy.applyPanelOps({
    state: strategy.emptyState(),
    ops: [{ op: "set", key: "invariant.quality", value: "Code should be good." }],
  });
  assert.deepEqual(Object.keys((await strategy.invariantStore.load("demo")).entries), []);
  assert.match(applied.state.discarded.at(-1).reason, /needs a check/);
});

test("a failed propose call writes nothing and says so", async () => {
  const broken = new MemoryStrategy({
    profileStore: new MemoryProfileStore(),
    invariantStore: new MemoryInvariantStore(),
    project: "demo",
    proposer: new StubProposer({ fail: true }),
    extractor: new StubExtractor(),
    promoter: new StubPromoter(),
    briefer: new StubBriefer(),
    summarizer: new StubSummarizer(),
  });

  const result = await broken.proposeInvariants({
    state: broken.emptyState(),
    text: "never move off postgres",
    provider: new StubProvider(),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(Object.keys((await broken.invariantStore.load("demo")).entries), []);
});

// ---- the block ----------------------------------------------------------

test("<invariants> is in every stage including done, and absent when there are none", async () => {
  const { strategy } = strategyWith();
  const provider = new StubProvider();

  // Empty: omitted entirely, like every other block.
  const nothing = await converse(strategy, ["hello"], { provider });
  assert.ok(!nothing.turns[0].system.includes("<invariants>"));

  const seeded = await strategy.applyPanelOps({ state: nothing.state, ops: [POSTGRES, NO_ORM] });
  let state = seeded.state;
  let history = nothing.history;
  const seen = {};

  for (const stage of ["planning", "execution", "validation", "done"]) {
    if (stage === "execution") {
      const written = await strategy.transition({ state, to: "execution", history, provider });
      const accepted = await strategy.answerBrief({ state: written.state, history, action: "accept" });
      state = accepted.state;
    } else if (stage !== "planning") {
      const moved = await strategy.transition({ state, to: stage, history, provider });
      assert.equal(moved.ok, true, `could not reach ${stage}: ${moved.note}`);
      state = moved.state;
    }
    if (stage === "planning") {
      // A goal, so the guard out of planning has something to let through.
      const applied = await strategy.applyPanelOps({ state, ops: [{ op: "set", key: "goal", value: "Move billing off Heroku" }] });
      state = applied.state;
    }

    const turn = await converse(strategy, [`in ${stage}`], { provider, from: { history, state } });
    history = turn.history;
    state = turn.state;
    seen[stage] = turn.turns[0].system;

    assert.ok(turn.turns[0].system.includes("<invariants>"), `${stage} is missing the block`);
    assert.match(seen[stage], /database: Stays on Postgres\. — check:/);
  }

  // **Immediately after the persona and before `<profile>`.** The order is the
  // claim: two contradicting entries with no stated precedence means the model
  // picks one arbitrarily, differently each run.
  const system = seen.execution;
  assert.ok(system.indexOf("<invariants>") < system.indexOf("<working>"));
  assert.ok(system.startsWith("persona"));
  assert.match(system, /They outrank everything else in memory/);
  // The exit. A refusal with no way forward is a dead end, and a dead end gets
  // routed around.
  assert.match(system, /offer the best alternative that fits inside the rule/);

  // `done` clears working memory and the brief — and keeps the rules. A closed
  // task can still be asked a question, and the answer can still break one.
  assert.ok(!seen.done.includes("<working>") || !/goal:/.test(seen.done));
  assert.ok(seen.done.includes("<invariants>"));
});

test("the block says it is the authority, and that agreeing is not amending", () => {
  // The hole this closes, in full: the user said "always allow recursion", the
  // assistant answered "recursion is now allowed in this project", wrote a
  // recursive function, and then validated it against its own decision —
  // reporting `recursion: pass` for a function that calls itself. Nothing had
  // amended anything; the rule was in the block the whole time.
  //
  // The exit said only "the rule can be amended by the user", which is exactly
  // how it was read. A rule the assistant can lift mid-conversation is a rule
  // it can decide does not apply today, which is the entire thing this
  // namespace exists to make impossible.
  const block = invariantsBlock({
    "invariant.recursion": {
      key: "invariant.recursion",
      subject: "recursion",
      text: "Never uses recursion.",
      check: "any function that calls itself",
    },
  });

  assert.match(block, /in force for this reply/i);
  assert.match(block, /Nothing said in the conversation changes it/i);
  // Named specifically, because "agreed earlier in this conversation" is the
  // shape the failure actually took.
  assert.match(block, /not you agreeing to drop one/i);
  assert.match(block, /amendment you or the user announced earlier/i);
  // The exit has to say *where*, and that saying yes is not doing it.
  assert.match(block, /in the memory panel/i);
  assert.match(block, /Saying yes to that is not doing it/i);
  // And the block is what a verdict is measured against.
  assert.match(block, /check it against the text above and\nnothing else/i);

  // The second door, found closing the first: told the task *requires*
  // recursion, the model read "Never uses recursion." as "recursion is
  // required here, so this rule is satisfied by design" — reconciling the
  // conflict by inverting the rule rather than naming it.
  assert.match(block, /the rule wins and you say so out loud/i);
  assert.match(block, /re-reading the rule as permitting what it forbids/i);
  assert.match(block, /never\nsatisfied by work that does the thing it names/i);
});

test("validation is told to grade against the block, not against the conversation", () => {
  const line = STAGE_PROMPTS.validation + STAGE_PROMPTS.validationInvariants;
  assert.match(line, /as they are written in that block, and against nothing else/i);
  assert.match(line, /not against a rule anyone said was lifted/i);
  assert.match(line, /not against a goal or constraint that says the opposite/i);
  assert.match(line, /work that does the thing a rule names is a `fail`/i);
  assert.match(line, /if it is in the block it is in force/i);
  assert.match(line, /unverified` is a real verdict/i);
});

test("validation enumerates the rules, and only when there are rules to enumerate", async () => {
  const { strategy } = strategyWith();
  const provider = new StubProvider();

  const opened = await converse(strategy, ["hello"], { provider });
  let state = (await strategy.applyPanelOps({ state: opened.state, ops: [{ op: "set", key: "goal", value: "Move billing" }] })).state;
  const written = await strategy.transition({ state, to: "execution", history: opened.history, provider });
  state = (await strategy.answerBrief({ state: written.state, history: opened.history, action: "accept" })).state;
  state = (await strategy.transition({ state, to: "validation", history: opened.history, provider })).state;

  const bare = await converse(strategy, ["check it"], { provider, from: { history: opened.history, state } });
  assert.ok(!/unverified is a real verdict/i.test(bare.turns[0].system), "nothing pays for a layer it is not using");

  const seeded = await strategy.applyPanelOps({ state: bare.state, ops: [POSTGRES] });
  const withRules = await converse(strategy, ["check it again"], {
    provider,
    from: { history: bare.history, state: seeded.state },
  });
  assert.match(withRules.turns[0].system, /pass \| fail \| unverified/);
  assert.match(withRules.turns[0].system, /never report it as a pass/);
});

test("the block is omitted for a project with no rules, whatever another project holds", async () => {
  const store = new MemoryInvariantStore();
  const { strategy } = strategyWith({ invariantStore: store });
  const provider = new StubProvider();

  const seeded = await strategy.applyPanelOps({ state: strategy.emptyState(), ops: [POSTGRES] });
  assert.match(invariantsBlock((await store.load("demo")).entries), /Stays on Postgres/);

  // The same human, a second codebase. This is the reason the rules are keyed
  // by project rather than folded into the profile.
  strategy.useProject("other");
  const elsewhere = await converse(strategy, ["hello"], { provider, from: { history: [], state: seeded.state } });
  assert.ok(!elsewhere.turns[0].system.includes("<invariants>"));
});

// ---- write-time enforcement ---------------------------------------------

test("a write on an owned subject lands in the task and is refused in long-term", async () => {
  const { strategy, profileStore } = strategyWith({
    ops: [
      [],
      [
        // Three working keys on owned subjects, one of them a plain
        // restatement of the rule, and one long-term key.
        { op: "set", key: "constraint.database", value: "Move to MySQL 8" },
        { op: "set", key: "constraint.orm", value: "No ORM; SQL by hand" },
        { op: "set", key: "decision.orm", value: "Hand-written SQL, as always" },
        { op: "set", key: "preference.orm", value: "Likes Prisma" },
        { op: "set", key: "finding.latency", value: "p99 is 400ms" },
      ],
    ],
  });
  const provider = new StubProvider();

  const opened = await converse(strategy, ["hello"], { provider });
  const seeded = await strategy.applyPanelOps({ state: opened.state, ops: [POSTGRES, NO_ORM] });
  const next = await converse(strategy, ["let us use mysql and prisma"], {
    provider,
    from: { history: opened.history, state: seeded.state },
  });

  // **Working memory takes them.** A task governed by rules restates them
  // constantly, and asking about each restatement is a question with nothing
  // in it — which is how people learn to click through questions.
  assert.equal(next.state.working["constraint.database"].value, "Move to MySQL 8");
  assert.equal(next.state.working["constraint.orm"].value, "No ORM; SQL by hand");
  assert.equal(next.state.working["decision.orm"].value, "Hand-written SQL, as always");
  assert.equal(next.state.working["finding.latency"].value, "p99 is 400ms");

  // **Long-term does not.** That is the layer the property was ever about.
  assert.ok(!("preference.orm" in (await profileStore.load("local")).entries));

  const panel = strategy.panel(next.state, { turns: Infinity });
  const refused = panel.proposals.filter((p) => p.reason === "invariant");
  assert.deepEqual(refused.map((p) => p.key), ["preference.orm"]);
  assert.equal(refused[0].invariant, "invariant.orm");
  assert.equal(refused[0].check, "any proposal importing an ORM");

  // Nothing is hidden: a row on an owned subject says which rule outranks it,
  // on the row, which is where the real contradiction becomes visible too.
  const rows = new Map(panel.task.map((row) => [row.key, row.governedBy]));
  assert.equal(rows.get("constraint.database"), "invariant.database");
  assert.equal(rows.get("decision.orm"), "invariant.orm");
  assert.equal(rows.get("finding.latency"), null, "a subject no rule owns is an ordinary row");
});

test("approving a refused write lets exactly that one through, and no others", async () => {
  const { strategy, profileStore } = strategyWith({
    ops: [[], [{ op: "set", key: "preference.database", value: "Runs Postgres 14 on port 8477" }]],
  });
  const provider = new StubProvider();

  const opened = await converse(strategy, ["hello"], { provider });
  const seeded = await strategy.applyPanelOps({ state: opened.state, ops: [POSTGRES] });
  const next = await converse(strategy, ["port 8477"], { provider, from: { history: opened.history, state: seeded.state } });

  const proposal = strategy.panel(next.state, { turns: Infinity }).proposals.find((p) => p.reason === "invariant");
  const answered = await strategy.answerProposal({ state: next.state, id: proposal.id, action: "approve", turns: 2 });
  assert.equal((await profileStore.load("local")).entries["preference.database"].value, "Runs Postgres 14 on port 8477");

  // The wave-through is for that key and that answer only: the check is back
  // in force for anything else on the subject.
  const again = applyOps(
    { working: {}, profile: await profileStore.load("local"), invariants: await strategy.invariantStore.load("demo") },
    [{ op: "set", key: "preference.database", value: "MySQL after all" }],
    { origin: "model" }
  );
  assert.equal(again.profile.entries["preference.database"].value, "Runs Postgres 14 on port 8477");
  assert.equal(again.contested[0].reason, "invariant");
});

test("accepting a new invariant sweeps long-term and proposes one row per collision", async () => {
  const { strategy, profileStore } = strategyWith();

  // Two entries on `database`, established long before anybody wrote a rule
  // about it — one in long-term, one in the task in hand.
  await profileStore.save("local", {
    ...emptyProfile("local"),
    nextId: 2,
    entries: {
      "preference.database": { id: "e1", key: "preference.database", value: "Prefers MySQL for new services", updatedAt: null, source: "declared" },
    },
  });
  const withTask = await strategy.applyPanelOps({
    state: strategy.emptyState(),
    ops: [{ op: "set", key: "constraint.database", value: "Running on MySQL 8 today" }],
  });

  const accepted = await strategy.applyPanelOps({ state: withTask.state, ops: [POSTGRES], turns: 3 });
  const panel = strategy.panel(accepted.state, { turns: Infinity });
  const swept = panel.proposals.filter((p) => p.kind === "collision");

  // **Long-term only**, matching the check itself. The working key on the same
  // subject dies with the task either way, so it is marked rather than asked
  // about — the same reason the check stopped refusing it on the way in.
  assert.deepEqual(swept.map((p) => p.key), ["preference.database"]);
  assert.equal(swept[0].invariant, "invariant.database");
  assert.match(accepted.note, /waiting for you below/);
  assert.equal(
    panel.task.find((row) => row.key === "constraint.database").governedBy,
    "invariant.database"
  );

  // Reported, never resolved: nothing was deleted by the sweep itself.
  assert.equal(accepted.state.working["constraint.database"].value, "Running on MySQL 8 today");
  assert.ok("preference.database" in (await profileStore.load("local")).entries);

  // Approving a collision row is "the rule wins"; rejecting it keeps the
  // entry, because you looked and decided the two were compatible.
  const forgotten = await strategy.answerProposal({
    state: accepted.state,
    id: swept[0].id,
    action: "approve",
    turns: 3,
  });
  assert.ok(!("preference.database" in (await profileStore.load("local")).entries));

  assert.equal(forgotten.state.working["constraint.database"].value, "Running on MySQL 8 today");
});

test("amending a rule does not sweep again, and keeps every sentence it has had", async () => {
  const { strategy, invariantStore } = strategyWith();

  const first = await strategy.applyPanelOps({ state: strategy.emptyState(), ops: [POSTGRES] });
  const withEntry = await strategy.applyPanelOps({
    state: first.state,
    // Waved through, as a person answering the check would be.
    ops: [{ op: "set", key: "preference.database", value: "Prefers Postgres" }],
    acknowledged: ["preference.database"],
  });

  const amended = await strategy.applyPanelOps({
    state: withEntry.state,
    ops: [authored("invariant.database", "Stays on Postgres 14 or later.", "any proposal introducing another engine, or a downgrade")],
    turns: 4,
  });

  // An amended rule was already in force, so everything beside it has already
  // been through the check on the way in. Sweeping again would be nagging.
  assert.deepEqual(strategy.panel(amended.state, { turns: Infinity }).proposals.filter((p) => p.kind === "collision"), []);

  const stored = (await invariantStore.load("demo")).entries["invariant.database"];
  assert.equal(stored.text, "Stays on Postgres 14 or later.");
  assert.ok(stored.supersedes, "the supersession is recorded");
  assert.deepEqual(stored.previous.map((old) => old.text), ["Stays on Postgres."]);

  // ...and the panel can show it, which is the whole of the amendment path: an
  // invariant that
  // changed without a trace is worse than not having one.
  const row = strategy.panel(amended.state, { turns: Infinity }).invariants[0];
  assert.equal(row.amended, true);
  assert.deepEqual(row.previous.map((old) => old.text), ["Stays on Postgres."]);
});

test("withdrawing a rule is person-only too, and leaves the wording behind", async () => {
  const { strategy, invariantStore } = strategyWith();
  const seeded = await strategy.applyPanelOps({ state: strategy.emptyState(), ops: [NO_ORM] });

  // A model op does not get there, whatever else is in the patch.
  const byModel = applyOps(
    { working: {}, profile: emptyProfile(), invariants: await invariantStore.load("demo") },
    [{ op: "delete", key: "invariant.orm" }],
    { origin: "model", longtermDeletes: true }
  );
  assert.ok("invariant.orm" in byModel.invariants.entries);

  const withdrawn = await strategy.applyPanelOps({ state: seeded.state, ops: [{ op: "delete", key: "invariant.orm" }] });
  const record = await invariantStore.load("demo");
  assert.deepEqual(Object.keys(record.entries), []);
  assert.equal(record.retired[0].text, "No ORM; SQL is written by hand.");
  assert.equal(strategy.panel(withdrawn.state, { turns: Infinity }).invariants.length, 0);
});

test("the extraction prompt is told the rules, and never shown the namespace", async () => {
  const { strategy, extractor } = strategyWith();
  const provider = new StubProvider();

  const opened = await converse(strategy, ["hello"], { provider });
  const seeded = await strategy.applyPanelOps({ state: opened.state, ops: [POSTGRES] });
  await converse(strategy, ["what about mysql"], { provider, from: { history: opened.history, state: seeded.state } });

  const last = extractor.calls.at(-1);
  assert.equal(last.invariants.length, 1);
  assert.equal(last.invariants[0].text, "Stays on Postgres.");

  // The filter is a filter, not the gate — but a namespace the extractor is
  // never told about is one it almost never reaches for.
  const { MemoryExtractor } = await import("./memory.js");
  const seen = [];
  const extractorProvider = {
    async complete({ system, messages }) {
      seen.push({ system, messages });
      return { text: "[]", model: "stub", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  await new MemoryExtractor({ provider: extractorProvider }).extract({
    stored: [],
    exchange: [{ role: "user", content: "hi" }],
    invariants: [{ key: "invariant.database", text: "Stays on Postgres.", check: "another engine" }],
  });
  assert.match(seen[0].system, /never propose an `invariant\.\*` key/);
  assert.ok(
    !/must begin with one of:\n\s*.*invariant/.test(seen[0].system),
    "the namespace list a model is given must not offer `invariant`"
  );
  assert.match(seen[0].messages[0].content, /PROJECT INVARIANTS/);
});

// ---- answer-time refusal ------------------------------------------------

test("the refusal op is split out as a task op and never reaches applyOps", () => {
  const patch = [
    { op: "refused", invariant: "orm", request: "add Prisma for the migration", alternative: "hand-written SQL migration in scripts/migrate/" },
    { op: "step", value: "writing the migration script" },
    { op: "set", key: "finding.rows", value: "1.2M rows in billing_events" },
  ];

  const { taskOps, memoryOps } = splitTaskOps(patch);
  assert.deepEqual(memoryOps.map((op) => op.key), ["finding.rows"]);
  assert.deepEqual(taskOps.map((op) => op.op), ["refused", "step"]);

  // It carries no key, so even if it did reach the write path it would be
  // discarded — but it must not reach it at all.
  const applied = applyOps({ working: {}, profile: emptyProfile() }, memoryOps, { origin: "model" });
  assert.deepEqual(applied.set, ["finding.rows"]);
  assert.deepEqual(applied.discarded, []);

  const task = applyTaskOps(emptyTask(), taskOps, { turn: 4 });
  assert.equal(task.task.refusals.length, 1);
  assert.deepEqual(
    { ...task.task.refusals[0], at: null },
    {
      invariant: "orm",
      request: "add Prisma for the migration",
      alternative: "hand-written SQL migration in scripts/migrate/",
      turn: 4,
      at: null,
    }
  );
  // Written, not gating: nothing about the stage moved.
  assert.equal(stageOf(task.task), "planning");
  assert.equal(task.suggested, null);
});

test("a refusal is drawn on the rule it cites, and a missing alternative stays visible", async () => {
  const { strategy } = strategyWith({
    ops: [
      [],
      [
        { op: "refused", invariant: "orm", request: "add Prisma for the migration", alternative: "hand-written SQL in scripts/migrate/" },
        { op: "refused", invariant: "database", request: "move to DynamoDB" },
        // Cites nothing this project has. Kept rather than dropped.
        { op: "refused", invariant: "deploy", request: "push straight to prod" },
      ],
    ],
  });
  const provider = new StubProvider();

  const opened = await converse(strategy, ["hello"], { provider });
  const seeded = await strategy.applyPanelOps({ state: opened.state, ops: [POSTGRES, NO_ORM] });
  const next = await converse(strategy, ["add prisma"], { provider, from: { history: opened.history, state: seeded.state } });

  const panel = strategy.panel(next.state, { turns: Infinity });
  const orm = panel.invariants.find((row) => row.key === "invariant.orm");
  assert.equal(orm.refusals.length, 1);
  assert.equal(orm.refusals[0].alternative, "hand-written SQL in scripts/migrate/");

  // **A dead end is a bad refusal**, so its absence is data the panel keeps
  // rather than a field that quietly reads as empty.
  const database = panel.invariants.find((row) => row.key === "invariant.database");
  assert.equal(database.refusals[0].alternative, null);

  assert.deepEqual(panel.orphanRefusals.map((row) => row.invariant), ["deploy"]);
});

test("an empty chat draws the rules and the profile it is about to be sent", async (t) => {
  const { strategy, invariantStore, profileStore } = strategyWith();
  await strategy.applyPanelOps({ state: strategy.emptyState(), ops: [POSTGRES] });
  await profileStore.save("local", {
    ...emptyProfile("local"),
    nextId: 2,
    entries: {
      "preference.format": { id: "e1", key: "preference.format", value: "Bullets, code first", updatedAt: null, source: "declared" },
    },
  });

  const live = { invariants: await invariantStore.load("demo"), profile: await profileStore.load("local") };
  const fresh = strategy.emptyState();

  // A branch that has taken no turns has no snapshot, so drawing from state
  // alone says *there are no rules and nothing is known about you* — which in
  // an empty chat is indistinguishable from the truth and is not it.
  const blind = strategy.panel(fresh, { turns: 0 });
  assert.deepEqual(blind.invariants, []);
  assert.deepEqual(blind.profile, []);

  const informed = strategy.panel(fresh, { turns: 0, ...live, user: "local", project: "demo" });
  assert.deepEqual(informed.invariants.map((row) => row.subject), ["database"]);
  assert.deepEqual(informed.profile.map((row) => row.key), ["preference.format"]);
  assert.equal(informed.user, "local");
  assert.equal(informed.project, "demo");
});

test("once a branch has sent something, its own snapshot is what the panel draws", async (t) => {
  const { strategy, invariantStore, profileStore } = strategyWith();
  const provider = new StubProvider();

  await profileStore.save("local", {
    ...emptyProfile("local"),
    nextId: 2,
    entries: {
      "profile.role": { id: "e1", key: "profile.role", value: "Android developer", updatedAt: null, source: "learned" },
    },
  });
  const turn = await converse(strategy, ["hello"], { provider });

  // Something else wrote to the profile after this branch's last turn. The
  // panel goes on showing what the branch was actually told: a fork must not
  // start claiming it saw things it never did.
  await profileStore.save("local", {
    ...emptyProfile("local"),
    nextId: 3,
    entries: {
      "profile.role": { id: "e1", key: "profile.role", value: "Android developer", updatedAt: null, source: "learned" },
      "profile.city": { id: "e2", key: "profile.city", value: "Berlin", updatedAt: null, source: "learned" },
    },
  });

  const drawn = strategy.panel(turn.state, {
    turns: 1,
    profile: await profileStore.load("local"),
    invariants: await invariantStore.load("demo"),
  });
  assert.deepEqual(drawn.profile.map((row) => row.key), ["profile.role"]);
});

// ---- the stage edges ----------------------------------------------------

test("the Briefer is handed the rules, so a goal that needs one broken is said in the brief", async () => {
  const briefer = new StubBriefer();
  const { strategy } = strategyWith({ briefer });
  const provider = new StubProvider();

  const opened = await converse(strategy, ["hello"], { provider });
  const seeded = await strategy.applyPanelOps({
    state: opened.state,
    ops: [POSTGRES, { op: "set", key: "goal", value: "Move billing off Heroku" }],
  });
  await strategy.transition({ state: seeded.state, to: "execution", history: opened.history, provider });

  assert.equal(briefer.calls.length, 1);
  assert.deepEqual(
    briefer.calls[0].invariants.map((entry) => entry.text),
    ["Stays on Postgres."]
  );
});

test("no new model call rides on a turn — the one that exists fires on the button", async () => {
  const { strategy, proposer } = strategyWith({ rows: [] });
  const provider = new StubProvider();

  const opened = await converse(strategy, ["hello"], { provider });
  const seeded = await strategy.applyPanelOps({ state: opened.state, ops: [POSTGRES, NO_ORM] });
  const later = await converse(strategy, ["one", "two", "three"], {
    provider,
    from: { history: opened.history, state: seeded.state },
  });

  assert.equal(proposer.calls.length, 0, "nothing about invariants costs a call on the turn path");
  // ...and the turn's own bill is unchanged in shape: extraction, and nothing
  // else new. The block is input tokens in a request that was happening anyway.
  assert.equal(later.turns.at(-1).meta.overheadCalls, 1);

  await strategy.proposeInvariants({ state: later.state, text: "no ORM", provider });
  assert.equal(proposer.calls.length, 1);
});
