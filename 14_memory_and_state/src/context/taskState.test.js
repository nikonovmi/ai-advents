import assert from "node:assert/strict";
import test from "node:test";

import {
  STAGES,
  STAGE_PROMPTS,
  TRANSITIONS,
  applyTaskOps,
  edgesFrom,
  emptyTask,
  frozenKeys,
  guardFor,
  normaliseTask,
  splitTaskOps,
  warningFor,
  stageOf,
  taskLines,
  transition,
} from "./taskState.js";

/** Working memory in the shape `applyOps` writes it. */
function working(pairs) {
  const entries = {};
  for (const [key, value] of Object.entries(pairs)) {
    entries[key] = { value, updatedAt: null, turn: 0, previous: [] };
  }
  return entries;
}

/** Walk a task forward through legal edges, as the strip's buttons do. */
function walk(task, stages, work = working({ goal: "migrate billing off Heroku" })) {
  let current = task;
  for (const to of stages) {
    const moved = transition(current, { to, working: work, by: "user" });
    assert.equal(moved.ok, true, `${stageOf(current)} → ${to} was refused: ${moved.reason}`);
    current = moved.task;
  }
  return current;
}

test("the edges are a table, and every stage in it is a stage", () => {
  assert.deepEqual(Object.keys(TRANSITIONS), STAGES);
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    for (const to of tos) {
      assert.ok(STAGES.includes(to), `${from} leads to ${to}, which is not a stage`);
      assert.notEqual(from, to, `${from} leads to itself`);
    }
  }

  // The backward edges are the point of the table. A machine that can only
  // move forward leaves "it does not meet the goal" unrepresentable, and the
  // work carries on in validation pretending otherwise.
  assert.ok(TRANSITIONS.validation.includes("execution"));
  assert.ok(TRANSITIONS.execution.includes("planning"));
  assert.deepEqual(TRANSITIONS.done, []);
});

test("the stage is derived from the last entry in the log, and nothing else", () => {
  const fresh = emptyTask();
  // An empty log *is* planning. There is no null/no-task state to special-case.
  assert.deepEqual(fresh.transitions, []);
  assert.equal(stageOf(fresh), "planning");

  const walked = walk(fresh, ["execution", "validation", "execution"]);
  assert.equal(stageOf(walked), "execution");
  assert.deepEqual(
    walked.transitions.map((entry) => `${entry.from}→${entry.to}`),
    ["planning→execution", "execution→validation", "validation→execution"]
  );

  // Append-only: nothing was rewritten on the way back, so the audit trail
  // still says validation sent it back.
  assert.equal(walked.transitions.length, 3);
});

test("an illegal edge is discarded and logged, and the state does not move", () => {
  const task = walk(emptyTask(), ["execution"]);

  // Skipping a stage, standing still, a stage that does not exist, and nothing
  // at all. None of them is close enough to a legal edge to be worth guessing.
  for (const to of ["done", "execution", "nowhere", ""]) {
    const refused = transition(task, { to, working: working({ goal: "ship it" }) });
    assert.equal(refused.ok, false, `${to} was allowed`);
    assert.equal(refused.reason && typeof refused.reason, "string");
    // Not coerced to a nearby valid stage — that is the failure worth naming.
    // The machine would look like it worked and the stage would be something
    // nobody chose.
    assert.equal(stageOf(refused.task), "execution");
    assert.deepEqual(
      refused.task.transitions.map((entry) => entry.to),
      task.transitions.map((entry) => entry.to)
    );
    // Discarded, but on the record. "The button did nothing and said nothing"
    // is indistinguishable from a broken one.
    assert.equal(refused.task.refused.at(-1).to, to.trim().toLowerCase() || "(nothing)");
  }
});

test("done is terminal: nothing leads out of it, not even back to planning", () => {
  const done = walk(emptyTask(), ["execution", "validation", "done"]);
  assert.equal(stageOf(done), "done");

  for (const to of STAGES) {
    const refused = transition(done, { to, working: {} });
    assert.equal(refused.ok, false, `done → ${to} was allowed`);
    assert.match(refused.reason, /new task/);
    assert.equal(stageOf(refused.task), "done");
  }
});

test("leaving planning requires a goal, and the guard's reason is the tooltip", () => {
  const fresh = emptyTask();

  const blocked = guardFor("planning", "execution", working({ "constraint.database": "Postgres 14" }));
  assert.notEqual(blocked, true);
  assert.match(blocked, /goal/i);

  // The button renders from the same call, so the disabled state and the
  // tooltip cannot disagree about why.
  const [edge] = edgesFrom(fresh, working({}));
  assert.equal(edge.to, "execution");
  assert.equal(edge.allowed, false);
  assert.equal(edge.reason, blocked);

  const refused = transition(fresh, { to: "execution", working: working({}) });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, blocked);
  assert.equal(stageOf(refused.task), "planning");

  // And with one, it moves.
  assert.equal(guardFor("planning", "execution", working({ goal: "ship it" })), true);
  assert.equal(transition(fresh, { to: "execution", working: working({ goal: "ship it" }) }).ok, true);
});

test("both edges that walk away from an open question warn, and neither blocks", () => {
  const work = working({ goal: "ship it", "open.region": "which region do we deploy to?" });

  // **Leaving planning.** This is the moment the goal freezes and the unknowns
  // stop being things anyone is going to ask about, so filing clarifications
  // as `open.*` is only worth doing if something downstream reads them.
  const [toExecution] = edgesFrom(emptyTask(), work);
  assert.equal(toExecution.to, "execution");
  assert.equal(toExecution.allowed, true, "an unanswered question must not block starting work");
  assert.match(toExecution.warning, /open\.region/);
  assert.match(toExecution.warning, /freezes the goal/);

  const started = transition(emptyTask(), { to: "execution", working: work });
  assert.equal(started.ok, true);
  assert.equal(stageOf(started.task), "execution");
  assert.match(started.warning, /1 question is still unanswered/);

  // **Entering done.** The same condition, on the other end of the work.
  const ready = walk(emptyTask(), ["execution", "validation"], work);
  const [toDone] = edgesFrom(ready, work).filter((edge) => edge.to === "done");
  // Neither is a guard. A machine that refuses to let you begin until the form
  // is complete is a machine people route around — and blocking the start
  // while the finish only warns would gate *starting* work more strictly than
  // declaring it done, which is backwards.
  assert.equal(toDone.allowed, true);
  assert.match(toDone.warning, /open\.region/);
  assert.match(toDone.warning, /still open/);

  const moved = transition(ready, { to: "done", working: work });
  assert.equal(moved.ok, true);
  assert.equal(stageOf(moved.task), "done");

  // ...and with nothing open, neither edge says anything.
  const clean = working({ goal: "ship it" });
  assert.equal(transition(emptyTask(), { to: "execution", working: clean }).warning, null);
  assert.equal(transition(walk(emptyTask(), ["execution", "validation"]), { to: "done", working: clean }).warning, null);

  // The backward edges never nag: going back to planning is how you go and
  // answer them, and being warned for doing the right thing is noise.
  const back = transition(walk(emptyTask(), ["execution"], work), { to: "planning", working: work });
  assert.equal(back.warning, null);
});

test("a model saying it is blocked on you warns, even when nothing was written down", () => {
  // The conversation this came from: the assistant asked four questions, the
  // user answered none of them, and the extractor — busy with a refusal that
  // turn — wrote no `open.*` at all. There was nothing for the open-question
  // warning to read, so leaving planning went through in silence.
  const work = { goal: { value: "Implement a generic DFS" } };
  const planning = applyTaskOps(emptyTask(), [
    { op: "awaiting", actor: "user", what: "graph representation, return type, and node type" },
  ], { turn: 2 });

  assert.equal(planning.task.expectedBy, "model");
  const warning = warningFor("planning", "execution", work, planning.task);
  assert.match(warning, /still waiting on you/);
  assert.match(warning, /graph representation, return type, and node type/);
  // ...and it says why nothing will chase it, which is the actual cost.
  assert.match(warning, /Nothing recorded it as an open question/);

  // It warns; it does not block. That distinction is the whole design.
  const moved = transition(planning.task, { to: "execution", working: work, turn: 2 });
  assert.equal(moved.ok, true);
  assert.equal(moved.warning, warning);
});

test("the machine's own resting state is not a warning", () => {
  // Every stage has a default and planning's is `actor: "user"`, so a task
  // nobody has said anything about is always "waiting on the user". Warning on
  // that would fire on every single transition and mean nothing.
  const work = { goal: { value: "Ship the thing" } };
  assert.equal(emptyTask().expectedBy, "system");
  assert.equal(warningFor("planning", "execution", work, emptyTask()), null);

  // A transition resets the field to the stage's default, so the next edge is
  // not still warning about what a model said two stages ago.
  const flagged = applyTaskOps(emptyTask(), [{ op: "awaiting", actor: "user", what: "confirm the date" }], { turn: 1 });
  const inExecution = transition(flagged.task, { to: "execution", working: work, turn: 1 });
  assert.equal(inExecution.task.expectedBy, "system");
  assert.equal(warningFor("validation", "done", work, inExecution.task), null);

  // And an agent-side await is not a thing to warn about at all: that is the
  // machine saying it has work to do, not that it is stuck on you.
  const busy = applyTaskOps(emptyTask(), [{ op: "awaiting", actor: "agent", what: "writing the code" }], { turn: 1 });
  assert.equal(warningFor("planning", "execution", work, busy.task), null);
});

test("both sources of the warning are said, not just whichever came first", () => {
  const work = { goal: { value: "Ship it" }, "open.region": { value: "Frankfurt or not?" } };
  const blocked = applyTaskOps(emptyTask(), [{ op: "awaiting", actor: "user", what: "pick a region" }], { turn: 3 });
  const warning = warningFor("planning", "execution", work, blocked.task);
  assert.match(warning, /open\.region/);
  assert.match(warning, /still waiting on you — pick a region/);
});

test("each stage contributes its own instruction line, and they differ", () => {
  const seen = new Set();
  for (const stage of STAGES) {
    const task = stage === "planning" ? emptyTask() : walk(emptyTask(), routeTo(stage));
    const lines = taskLines(task);
    assert.equal(lines[0], `stage: ${stage}`);
    const instruction = lines.at(-1);
    assert.equal(instruction, STAGE_PROMPTS[stage]);
    assert.ok(!seen.has(instruction), `${stage} reuses another stage's instruction`);
    seen.add(instruction);
  }

  // Planning is the one that matters, and it is the one with the most ways to
  // go wrong. It must refuse to do the work, must still answer an ordinary
  // question so the first message of every chat is not an interrogation, must
  // bound the clarifying, must say the goal is about to freeze, and must have
  // one thing to say when there is nothing left to ask.
  const planning = STAGE_PROMPTS.planning;
  assert.match(planning, /Do not produce the deliverable/i);
  assert.match(planning, /never holds an ordinary answer back/i);
  assert.match(planning, /one or two questions per turn/i);
  assert.match(planning, /open questions?/i);
  assert.match(planning, /frozen/i);
  assert.match(planning, /Everything's clear — we can switch to execution now/);
  // ...and it says out loud that the conversation is about to be replaced,
  // because a model that knows this is the last place to write something down
  // writes it down.
  assert.match(planning, /replaced by a written brief/i);
});

test("the goal freezes on leaving planning, and thaws on the way back", () => {
  assert.deepEqual(frozenKeys(emptyTask()), []);

  const executing = walk(emptyTask(), ["execution"]);
  assert.deepEqual(frozenKeys(executing), ["goal"]);
  assert.deepEqual(frozenKeys(walk(executing, ["validation"])), ["goal"]);

  // The backward edge is what you press when the goal is the thing that was
  // wrong, so it had better be writable again on the other side of it.
  assert.deepEqual(frozenKeys(walk(executing, ["planning"])), []);
});

test("a model may describe the task; it may not change its stage", () => {
  const task = walk(emptyTask(), ["execution"]);

  const { taskOps, memoryOps } = splitTaskOps([
    { op: "set", key: "finding.latency", value: "p99 is 400ms" },
    { op: "step", value: "writing the migration script" },
    { op: "awaiting", actor: "user", what: "confirm the March 14 date" },
    { op: "stage", to: "validation", reason: "the script is written" },
  ]);
  // The memory half of the patch never sees the task ops, so `applyOps` goes
  // on refusing everything that is not a routable key.
  assert.deepEqual(memoryOps, [{ op: "set", key: "finding.latency", value: "p99 is 400ms" }]);
  assert.deepEqual(taskOps.map((op) => op.op), ["step", "awaiting", "stage"]);

  const applied = applyTaskOps(task, taskOps, { turn: 4 });

  // The two descriptive fields are written: nobody will click a button to
  // keep a status line fresh, and a stale one is worse than none.
  assert.equal(applied.task.step, "writing the migration script");
  assert.deepEqual(applied.task.expectedAction, { actor: "user", what: "confirm the March 14 date" });

  // The stage is not. It is a suggestion beside a button and nothing else.
  assert.equal(stageOf(applied.task), "execution");
  assert.equal(applied.suggested, "validation");
  assert.deepEqual(applied.task.suggestion, {
    to: "validation",
    reason: "the script is written",
    turn: 4,
    at: applied.task.suggestion.at,
  });
  assert.equal(applied.task.transitions.length, 1);

  // Taking it is a click, and the click clears the suggestion.
  const moved = transition(applied.task, { to: "validation", working: working({ goal: "ship it" }) });
  assert.equal(moved.task.suggestion, null);
  assert.equal(moved.task.transitions.at(-1).by, "user");
});

test("a suggestion the table cannot honour is still worth showing", () => {
  const fresh = emptyTask();
  const applied = applyTaskOps(fresh, [{ op: "stage", to: "done", reason: "seems finished" }], { turn: 1 });

  assert.equal(applied.task.suggestion.to, "done");
  assert.equal(stageOf(applied.task), "planning");
  // ...and the button it points at is not there at all, so nothing can be
  // clicked into an illegal state by accident.
  assert.deepEqual(edgesFrom(applied.task, working({ goal: "x" })).map((edge) => edge.to), ["execution"]);
});

test("a task restored from disk is the task that was saved", () => {
  const work = working({ goal: "ship it" });
  const walked = walk(emptyTask(), ["execution", "validation", "execution", "validation"], work);
  const applied = applyTaskOps(walked, [{ op: "step", value: "re-checking the failing constraint" }], { turn: 6 });

  // Through JSON and back, which is exactly what the store does to it.
  const restored = normaliseTask(JSON.parse(JSON.stringify(applied.task)));

  assert.equal(stageOf(restored), "validation");
  assert.equal(restored.step, "re-checking the failing constraint");
  assert.deepEqual(restored.transitions, applied.task.transitions);
  assert.deepEqual(restored.expectedAction, applied.task.expectedAction);
  assert.deepEqual(frozenKeys(restored), ["goal"]);

  // A record written before any of this existed loads in planning with an
  // empty log, which is where a conversation with no recorded transitions
  // actually is.
  const legacy = normaliseTask(undefined);
  assert.equal(stageOf(legacy), "planning");
  assert.deepEqual(legacy.transitions, []);

  // And so does a record whose log has been hand-edited into nonsense.
  const junk = normaliseTask({ transitions: [{ from: "planning", to: "shipping" }, "nope"] });
  assert.deepEqual(junk.transitions, []);
  assert.equal(stageOf(junk), "planning");
});

test("a transition replaces the step and the actor rather than carrying them over", () => {
  const task = applyTaskOps(walk(emptyTask(), ["execution"]), [
    { op: "step", value: "writing the migration script" },
    { op: "awaiting", actor: "agent", what: "finish the script" },
  ]).task;

  const moved = transition(task, { to: "validation", working: working({ goal: "ship it" }) });
  // "Writing the migration script" is worse than useless once the stage says
  // validation: it is a status line confidently describing the stage before.
  assert.notEqual(moved.task.step, "writing the migration script");
  assert.match(moved.task.step, /checking/);
  assert.equal(moved.task.expectedAction.actor, "agent");
});

/** The legal route to a stage, for a test that wants to stand in one. */
function routeTo(stage) {
  return { execution: ["execution"], validation: ["execution", "validation"], done: ["execution", "validation", "done"] }[stage] ?? [];
}
