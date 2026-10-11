import assert from "node:assert/strict";
import test from "node:test";

import { FakeProvider } from "../llm/anthropic.js";
import { FakeScheduler } from "../scheduler/fakeScheduler.js";
import { GOAL, PLANNER_ALLOW, WINNER_PLAN, WINNER_SCHEMA, WINNER_SUBMISSION, stubCatalog, stubRegistry } from "./fixtures.js";
import { PLANNER_SYSTEM, Planner, SUBMIT_PLAN, buildCatalog, stepsFromSubmission } from "./planner.js";
import { repairer } from "./repair.js";
import { validatePlan } from "./validatePlan.js";

/**
 * **The planner, offline.** The catalog comes from stub servers behind a real
 * registry, and the model is a `FakeProvider` scripted to call `submit_plan`
 * with whatever plan the test wants to see handled.
 */

const T0 = Date.parse("2026-09-28T09:00:00.000Z");

/** A planner whose model answers with these submissions, in order; every request is kept. */
function plannerWith(submissions, { down } = {}) {
  const inner = new FakeProvider({ delayMs: 0, script: submissions.map((input) => ({ toolUse: [{ name: SUBMIT_PLAN, input }] })) });
  const requests = [];
  const provider = {
    async complete(params) {
      requests.push(structuredClone({ system: params.system, messages: params.messages, tools: params.tools, toolChoice: params.toolChoice, model: params.model }));
      return inner.complete(params);
    },
  };
  const planner = new Planner({ provider, catalog: stubCatalog({ down }), model: "claude-test", now: () => T0 });
  return { planner, requests };
}

const catalogOf = async (options) => stubCatalog(options)();

// ---- the catalog ---------------------------------------------------------------

test("the catalog: namespaced tools with outputSchema, no app-only tools, no scheduleId, and down servers named", async () => {
  const catalog = await buildCatalog({ registry: stubRegistry({ down: ["notion"] }), allow: PLANNER_ALLOW });
  assert.deepEqual(catalog.tools.map((tool) => tool.name), [
    "omdb.search_movies",
    "omdb.get_movie",
    "omdb.random_movie",
    "scheduler.record",
    "scheduler.aggregate",
  ]);
  for (const name of ["claim_due_runs", "delete_schedule", "finish_run", "get_run"]) {
    assert.ok(!catalog.tools.some((tool) => tool.tool === name), `${name} is app-only`);
  }

  const get = catalog.tools.find((tool) => tool.name === "omdb.get_movie");
  assert.equal(get.server, "omdb");
  assert.equal(get.tool, "get_movie");
  assert.equal(get.outputSchema.properties.imdbRating.type[0], "number");
  const record = catalog.tools.find((tool) => tool.name === "scheduler.record");
  assert.ok(!("scheduleId" in record.inputSchema.properties), "the planner never sees scheduleId");
  assert.deepEqual(record.inputSchema.required, ["key", "label"]);
  assert.ok(record.outputSchema);

  // Notion needs a login: none of its tools, and the reason.
  assert.deepEqual(catalog.down, [{ server: "notion", error: "needs authorization: connect it in the MCP panel" }]);

  // Up, Notion contributes only its allowlisted tools, and declares no outputSchema.
  const all = await catalogOf();
  const notion = all.tools.filter((tool) => tool.server === "notion");
  assert.deepEqual(notion.map((tool) => tool.tool), ["notion-create-pages", "notion-search"]);
  assert.ok(notion.every((tool) => !tool.outputSchema));
  assert.deepEqual(all.down, []);

  // A local server that is not running is down with its error.
  const refused = await catalogOf({ down: ["omdb"] });
  assert.match(refused.down[0].error, /fetch failed \(ECONNREFUSED\)/);
});

// ---- planning ------------------------------------------------------------------

test("a valid plan comes back in one call: submit_plan forced, the catalog and the goal in the prompt", async () => {
  const { planner, requests } = plannerWith([WINNER_SUBMISSION], { down: ["notion"] });
  // With Notion down its step would not validate, so plan against a catalog where it is up.
  const up = plannerWith([WINNER_SUBMISSION]);
  const result = await up.planner.propose({ goal: GOAL });

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(result.steps, WINNER_PLAN);
  assert.equal(result.notes, WINNER_SUBMISSION.notes);
  assert.equal(result.attempts, 1);
  assert.equal(result.createdAt, new Date(T0).toISOString());

  const [request] = up.requests;
  assert.equal(up.requests.length, 1);
  assert.equal(request.system, PLANNER_SYSTEM);
  assert.deepEqual(request.toolChoice, { name: SUBMIT_PLAN });
  assert.deepEqual(request.tools.map((tool) => tool.name), [SUBMIT_PLAN]);
  assert.equal(request.model, "claude-test", "the agent's model");
  const prompt = request.messages[0].content;
  assert.match(prompt, /### omdb\.get_movie/);
  assert.match(prompt, /outputSchema: \{"type":"object","properties":\{"title"/);
  assert.match(prompt, /### notion\.notion-create-pages[\s\S]*outputSchema: none declared/);
  assert.ok(prompt.includes(GOAL));
  assert.ok(!prompt.includes("claim_due_runs"));
  const inputs = prompt.split("\n").filter((line) => line.startsWith("inputSchema:"));
  assert.equal(inputs.length, 7);
  assert.ok(inputs.every((line) => !line.includes("scheduleId")), "no input the planner can see takes a scheduleId");

  // The down server is named in the prompt.
  await planner.propose({ goal: GOAL });
  assert.match(requests[0].messages[0].content, /down right now[\s\S]*- notion: needs authorization/);
});

test("an invalid plan gets one retry with every error in the prompt; a second failure is returned, not fixed", async () => {
  const bad = {
    steps: [
      { kind: "tool", tool: "omdb.get_film", args: { title: "Heat" }, why: "invented tool" },
      { kind: "tool", tool: "omdb.get_movie", args: { imdbId: 42, plot: "long" }, why: "bad args" },
      { kind: "prompt", text: "Which is better: {{steps.2.rating}}?", why: "bad template path" },
    ],
  };
  const { planner, requests } = plannerWith([bad, bad]);
  const result = await planner.propose({ goal: "Compare two films." });

  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.equal(requests.length, 2, "one retry, not more");
  assert.deepEqual(result.errors, [
    "Step 1 (omdb.get_film): omdb.get_film is not in the catalog. Use only the tools listed there, exactly as named.",
    "Step 2 (omdb.get_movie): args.imdbId: must be string",
    'Step 2 (omdb.get_movie): args.plot: must be equal to one of the allowed values ("short", "full")',
    'Step 3 (prompt): {{steps.2.rating}}: steps.2 has no "rating" (it has title, year, runtimeMinutes, genres, director, actors, plot, imdbRating, ratings, imdbId).',
  ]);

  // The retry carried the first attempt and its errors, as submit_plan's (failed) result.
  const retry = requests[1].messages;
  assert.equal(retry.length, 3);
  assert.equal(retry[1].role, "assistant");
  assert.equal(retry[1].content.find((block) => block.type === "tool_use").name, SUBMIT_PLAN);
  const feedback = retry[2].content[0];
  assert.equal(feedback.type, "tool_result");
  assert.equal(feedback.isError, true);
  for (const error of result.errors) assert.ok(feedback.content.includes(error), `the retry prompt names: ${error}`);
});

test("an invalid plan that the retry fixes is ok on the second attempt", async () => {
  const broken = structuredClone(WINNER_SUBMISSION);
  broken.steps[5].args.key = "{{steps.4.winnerId}}";
  const { planner, requests } = plannerWith([broken, WINNER_SUBMISSION]);
  const result = await planner.propose({ goal: GOAL });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.match(requests[1].messages[2].content[0].content, /\{\{steps\.4\.winnerId\}\}: steps\.4 has no "winnerId" \(it has imdbId, title, imdbRating, summary\)/);
  assert.deepEqual(result.steps, WINNER_PLAN);
});

// ---- the validator -------------------------------------------------------------

test("validatePlan: templates stand in for typed args, and paths are checked against the target's shape", async () => {
  const catalog = await catalogOf();
  const check = (submission) => validatePlan(stepsFromSubmission({ steps: submission }), catalog);

  assert.deepEqual(check(WINNER_SUBMISSION.steps), []);

  // A whole template where the schema wants an object, or a pattern it cannot
  // match yet, is fine: it is only known at run time.
  assert.deepEqual(
    check([
      { kind: "tool", tool: "omdb.search_movies", args: { query: "heat" }, why: "" },
      { kind: "tool", tool: "omdb.get_movie", args: { imdbId: "{{steps.1.results.0.imdbId}}" }, why: "" },
      { kind: "tool", tool: "scheduler.record", args: { key: "{{prev.imdbId}}", label: "{{prev.title}} ({{prev.year}})", data: "{{prev}}" }, why: "" },
      { kind: "tool", tool: "scheduler.aggregate", args: {}, why: "" },
      { kind: "prompt", text: "Most repeated: {{steps.4.mostRepeated.label}} at {{now}}", why: "" },
    ]),
    []
  );

  const problems = check([
    { kind: "tool", tool: "notion.notion-create-pages", args: { pages: [{ properties: { title: "x" }, content: "y" }] }, why: "" },
    { kind: "prompt", text: "Page: {{steps.1.pages.0.url}}", why: "" },
    { kind: "prompt", text: "{{prev.first}}", why: "" },
    { kind: "prompt", format: "json", text: "shape it", why: "" },
    { kind: "tool", tool: "omdb.search_movies", args: {}, why: "" },
    { kind: "tool", tool: "omdb.search_movies", args: { query: "x" }, why: "" },
    { kind: "prompt", text: "{{steps.6.results.first}} {{steps.9}} {{previous}} {{now.year}}", why: "" },
  ]);
  assert.deepEqual(problems, [
    "Step 2 (prompt): {{steps.1.pages.0.url}}: step 1's output shape is unknown (notion.notion-create-pages declares no outputSchema), so its fields cannot be referenced. Use {{steps.1}} whole, or add a json prompt step that reshapes it.",
    'Step 3 (prompt): {{prev.first}}: step 2 is a text prompt, its output is a plain string with no fields. Give it format "json" and an outputSchema.',
    'Step 4 (prompt (json)): a json step needs an outputSchema: a JSON Schema { type: "object", properties, required } of what it returns.',
    "Step 5 (omdb.search_movies): args: must have required property 'query'",
    'Step 7 (prompt): {{steps.6.results.first}}: steps.6.results has no "first" (it is a list: use an index, like .0).',
    "Step 7 (prompt): {{steps.9}} must refer to an earlier step (1 to 6).",
    "Step 7 (prompt): {{previous}} is not a template: use {{prev}}, {{steps.N}} or {{now}}.",
    "Step 7 (prompt): {{now.year}}: {{now}} has no fields.",
  ]);

  // A server that is down is named as the reason, not as an invented tool.
  const down = validatePlan(WINNER_PLAN, await catalogOf({ down: ["notion"] }));
  assert.deepEqual(down, ["Step 5 (notion.notion-create-pages): the notion server is down (needs authorization: connect it in the MCP panel), so none of its tools can be used."]);
  assert.deepEqual(validatePlan([], catalog), ["The plan has no steps."]);
});

// ---- repair ----------------------------------------------------------------------

test("a failed run gets a repair proposal: the goal, the plan, the outputs and the error go in; the plan is untouched", async () => {
  const fixed = structuredClone(WINNER_SUBMISSION);
  fixed.steps[2].args = { title: "Heat", year: 1995 };
  const { planner, requests } = plannerWith([fixed]);
  const scheduler = new FakeScheduler({ now: () => T0 });
  const schedule = await scheduler.createSchedule({ conversationId: "c-repair", mode: "interval", goal: GOAL, plan: WINNER_PLAN });
  const logs = [];
  const repair = repairer({ planner, scheduler, log: { log: (line) => logs.push(line) } });

  const outcome = {
    ok: false,
    error: "Step 3 (get_movie): OMDb: Movie not found!",
    steps: [
      { index: 1, kind: "tool", status: "ok", input: { title: "Inception" }, output: { title: "Inception", imdbRating: 8.8 } },
      { index: 2, kind: "tool", status: "ok", input: { title: "The Matrix" }, output: { title: "The Matrix", imdbRating: 8.7 } },
      { index: 3, kind: "tool", status: "error", input: { title: "Heat" }, error: "OMDb: Movie not found!" },
      { index: 4, kind: "prompt", status: "skipped" },
    ],
  };
  const proposal = await repair({ run: { id: 7 }, schedule, outcome });

  const ask = requests[0].messages[0].content;
  assert.ok(ask.includes(GOAL));
  assert.match(ask, /## The plan that ran[\s\S]*"tool": "get_movie"/);
  assert.match(ask, /Run #7 failed: Step 3 \(get_movie\): OMDb: Movie not found!/);
  assert.match(ask, /"imdbRating": 8\.7/);

  const stored = await scheduler.getSchedule("c-repair");
  assert.deepEqual(stored.plan, WINNER_PLAN, "the accepted plan is untouched");
  assert.deepEqual(stored.proposal, proposal);
  assert.equal(proposal.reason, "repair");
  assert.deepEqual(proposal.run, { id: 7, error: outcome.error });
  assert.deepEqual(proposal.steps[2].args, { title: "Heat", year: 1995 });
  assert.equal(proposal.errors, undefined);

  // A second failure while that proposal is pending does not call the planner again.
  assert.equal(await repair({ run: { id: 8 }, schedule, outcome }), null);
  assert.equal(requests.length, 1);
  assert.match(logs.at(-1), /already has a proposal pending/);
});

test("a repair the planner cannot make valid is stored with its errors", async () => {
  const bad = { steps: [{ kind: "tool", tool: "omdb.get_film", args: {}, why: "" }] };
  const { planner } = plannerWith([bad, bad]);
  const scheduler = new FakeScheduler({ now: () => T0 });
  const schedule = await scheduler.createSchedule({ conversationId: "c-bad", goal: GOAL, plan: WINNER_PLAN });
  const proposal = await repairer({ planner, scheduler, log: { log() {} } })({ run: { id: 3 }, schedule, outcome: { ok: false, error: "boom" } });
  assert.deepEqual(proposal.errors, ["Step 1 (omdb.get_film): omdb.get_film is not in the catalog. Use only the tools listed there, exactly as named."]);
  assert.deepEqual((await scheduler.getSchedule("c-bad")).plan, WINNER_PLAN);
});

test("WINNER_SCHEMA is what the json step declares", () => {
  assert.deepEqual(WINNER_PLAN[3].outputSchema, WINNER_SCHEMA);
  assert.equal(WINNER_PLAN[3].format, "json");
});
