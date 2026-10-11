import assert from "node:assert/strict";
import test from "node:test";

import {
  MEMORY_OPS,
  NAMESPACES,
  PROPOSABLE,
  ROUTES,
  TASK_OPS,
  coerceOp,
  parseJsonArray,
  readPatch,
  routeFor,
} from "./patch.js";

/**
 * **The patch format, and the one property that keeps it honest.**
 *
 * Three times in one sitting a model got the envelope wrong — the key in the
 * `op` field, the verb invented, the verb missing — and three times the thing
 * it got wrong was the unanswered questions, which nothing else in the system
 * writes down. Each time it arrived as a different useless panel row, and each
 * time it was found by a person noticing a missing row rather than by anything
 * in here.
 *
 * Coercion is not what stops that happening again; coercion always runs out.
 * The property is:
 *
 *   > Every item in a patch either **lands** or is **reported, with a reason**.
 *   > There is no third outcome.
 *
 * The table below is the census. Everything that has actually gone wrong is in
 * it, and the last test asserts the property over the whole table at once — so
 * a fourth shape nobody predicted is a line in the panel rather than a fact
 * that never existed.
 */

/** Every envelope this format has been handed, and what it means. */
const PATCHES = [
  // ---- well-formed --------------------------------------------------------
  { name: "a set", op: { op: "set", key: "goal", value: "Implement a DFS" }, lands: "memory", as: "set goal" },
  { name: "a delete", op: { op: "delete", key: "open.region" }, lands: "memory", as: "delete open.region" },
  { name: "a promote", op: { op: "promote", key: "decision.db" }, lands: "memory", as: "promote decision.db" },
  { name: "a step", op: { op: "step", value: "writing the migration" }, lands: "task" },
  { name: "an awaiting", op: { op: "awaiting", actor: "user", what: "confirm the date" }, lands: "task" },
  { name: "a stage suggestion", op: { op: "stage", to: "validation", reason: "written" }, lands: "task" },
  { name: "a refusal", op: { op: "refused", invariant: "orm", request: "add Prisma" }, lands: "task" },

  // ---- the envelope slips that actually happened --------------------------
  {
    name: "the key in the verb's place",
    op: { op: "open.graph_representation", value: "How is the graph provided?" },
    lands: "memory",
    as: "set open.graph_representation",
  },
  {
    name: "a verb nobody knows",
    op: { op: "add", key: "open.graph_direction", value: "Directed?" },
    lands: "memory",
    as: "set open.graph_direction",
  },
  {
    name: "no verb at all",
    op: { key: "open.dfs_output", value: "What does it return?" },
    lands: "memory",
    as: "set open.dfs_output",
  },
  {
    name: "a verb nobody knows and `text` instead of `value`",
    op: { op: "record", key: "finding.latency", text: "p99 is 400ms" },
    lands: "memory",
    as: "set finding.latency",
  },

  // ---- past coercion, and each says which field was wrong -----------------
  {
    name: "a key in the verb's place with nothing to store",
    op: { op: "open.region" },
    rejected: /`open\.region` is not an op/,
  },
  { name: "a verb nobody knows and no key", op: { op: "remember", value: "x" }, rejected: /`remember` is not an op/ },
  { name: "neither a verb nor a key", op: { value: "x" }, rejected: /no op and no key/ },
  { name: "not an object at all", op: "just a sentence", rejected: /not an operation/ },
  { name: "null", op: null, rejected: /not an operation/ },
];

test("every envelope the format has been handed reads as what it meant", () => {
  for (const row of PATCHES) {
    const { taskOps, memoryOps, rejected } = readPatch([row.op], { turn: 1 });

    if (row.lands === "memory") {
      assert.equal(memoryOps.length, 1, `${row.name}: did not land`);
      assert.deepEqual(rejected, [], `${row.name}: landed and was reported`);
      if (row.as) assert.equal(`${memoryOps[0].op} ${memoryOps[0].key}`, row.as, row.name);
    } else if (row.lands === "task") {
      assert.equal(taskOps.length, 1, `${row.name}: did not land`);
      assert.deepEqual(rejected, [], `${row.name}: landed and was reported`);
    } else {
      assert.equal(rejected.length, 1, `${row.name}: was not reported`);
      assert.match(rejected[0].reason, row.rejected, row.name);
      // A reason nobody can act on is the bug this replaced: "(no key) —
      // unknown namespace" was true of every one of these.
      assert.notEqual(rejected[0].reason, "unknown namespace", `${row.name}: the reason says nothing`);
    }
  }
});

test("nothing is lost: every item lands or is reported, and never both", () => {
  const ops = PATCHES.map((row) => row.op);
  const { taskOps, memoryOps, rejected } = readPatch(ops, { turn: 3 });

  // **The property.** Not "the coercion handles these fifteen shapes" — that
  // claim expires the moment a model invents a sixteenth — but that the three
  // piles account for every item that went in.
  assert.equal(taskOps.length + memoryOps.length + rejected.length, ops.length);

  // ...and every rejection carries what a person needs to act on it.
  for (const row of rejected) {
    assert.ok(row.reason && row.reason.length > 8, `a rejection with no usable reason: ${JSON.stringify(row)}`);
    assert.ok("key" in row && "op" in row && "value" in row, "a rejection the panel cannot draw");
    assert.equal(row.turn, 3, "a rejection nobody can place in the conversation");
  }
});

test("a known verb is never rewritten into one the model was not allowed to use", () => {
  // The forgiveness must not reach a real op. `promote` from a model is a
  // request for something it may not have, and it stays that request so the
  // write path can refuse it and say so.
  for (const verb of MEMORY_OPS) {
    assert.equal(coerceOp({ op: verb, key: "decision.db", value: "x" }).action, verb);
  }
  for (const verb of TASK_OPS) {
    assert.equal(coerceOp({ op: verb, value: "x" }).action, verb);
  }
  // A delete carries no value, so nothing about it looks like a `set`.
  assert.equal(coerceOp({ op: "delete", key: "open.region" }).action, "delete");
  // And nothing is conjured from an op with nothing in it. It comes back
  // exactly as it arrived, so the reader can name the field that was wrong
  // rather than guessing at a verb on its behalf.
  for (const empty of [{ op: "open.region" }, { key: "open.region" }, { op: "add", key: "open.region" }]) {
    const { action } = coerceOp(empty);
    assert.ok(
      !MEMORY_OPS.has(action) && !TASK_OPS.has(action),
      `a verb was invented for ${JSON.stringify(empty)}`
    );
  }
});

test("a reply with no array in it is not a model that found nothing to say", () => {
  // The two used to be the same empty list, and they call for opposite fixes.
  assert.deepEqual(parseJsonArray("[]"), { items: [], rejected: [] });
  assert.deepEqual(parseJsonArray("").items, []);
  assert.deepEqual(parseJsonArray("").rejected, []);

  const prose = parseJsonArray("I could not find anything to record this turn.");
  assert.deepEqual(prose.items, []);
  assert.match(prose.rejected[0].reason, /no JSON array/);

  const broken = parseJsonArray('[{"op":"set","key":"goal",}]');
  assert.deepEqual(broken.items, []);
  assert.match(broken.rejected[0].reason, /would not parse/);

  // ...and a fenced, prefixed, trailing-prose reply is still a patch.
  const messy = parseJsonArray('Sure! ```json\n[{"op":"set","key":"goal","value":"x"}]\n``` hope that helps');
  assert.equal(messy.items.length, 1);
  assert.deepEqual(messy.rejected, []);
});

test("the routing table is the only thing that decides a layer", () => {
  for (const [namespace, route] of Object.entries(ROUTES)) {
    const resolved = routeFor(`${namespace}.thing`);
    assert.equal(resolved.layer, route.layer, namespace);
    assert.equal(resolved.namespace, namespace);
  }
  assert.equal(routeFor("random.thing"), null);
  assert.equal(routeFor(""), null);
  assert.equal(routeFor("goal.a.b.c"), null, "at most three segments");

  // The vocabulary a model is given never includes the person-only namespace.
  assert.ok(!PROPOSABLE.includes("invariant"));
  assert.deepEqual(
    NAMESPACES.filter((namespace) => !PROPOSABLE.includes(namespace)),
    ["invariant"]
  );
});
