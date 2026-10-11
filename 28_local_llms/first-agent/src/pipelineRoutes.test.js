import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { FakeProvider } from "./llm/anthropic.js";
import { GOAL, WINNER_PLAN, WINNER_SUBMISSION, stubCatalog } from "./pipeline/fixtures.js";
import { Planner, SUBMIT_PLAN } from "./pipeline/planner.js";
import { FakeScheduler } from "./scheduler/fakeScheduler.js";
import { READ_ONLY_REASON, pipelineRoutes } from "./pipelineRoutes.js";
import { MemoryStore } from "./store/memoryStore.js";

/**
 * **The pipeline routes, over HTTP**, with an in-memory scheduler behind them
 * and a real planner whose model is a `FakeProvider` scripted to call
 * `submit_plan` with `submissions`, in order.
 * Every route the main server owns (/chat, fork, delete) is stood in for by a
 * handler that answers `reached`, so a test can tell "guarded here" from
 * "handed on".
 */

const CHAT = "55555555-5555-4555-8555-555555555555";

async function serve(t, { submissions = [] } = {}) {
  const store = new MemoryStore();
  const scheduler = new FakeScheduler();
  const invalidated = [];
  const kicks = [];
  const provider = new FakeProvider({ delayMs: 0, script: submissions.map((input) => ({ toolUse: [{ name: SUBMIT_PLAN, input }] })) });
  const planner = new Planner({ provider, catalog: stubCatalog() });

  const app = express();
  app.use(express.json());
  app.use(
    pipelineRoutes({
      store,
      scheduler,
      planner,
      kick: () => kicks.push(Date.now()),
      invalidate: (id) => invalidated.push(id),
    })
  );
  const reached = (_req, res) => res.json({ reached: true });
  app.post("/chat", reached);
  app.post("/conversations/:id/fork", reached);
  app.delete("/conversations/:id", async (req, res) => {
    await store.clear(req.params.id);
    res.json({ reached: true });
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  return { call, store, scheduler, invalidated, kicks, provider };
}

async function newScheduledChat(call) {
  const created = await call("POST", "/conversations", { agent: "pipeline" });
  assert.equal(created.status, 201);
  return created.body.id;
}

/** A pipeline chat whose plan has been generated and accepted. */
async function acceptedChat(call) {
  const id = await newScheduledChat(call);
  assert.equal((await call("POST", `/conversations/${id}/pipeline/plan`, { goal: GOAL })).status, 200);
  assert.equal((await call("POST", `/conversations/${id}/pipeline/proposal`, { action: "accept" })).status, 200);
  return id;
}

test("creating a pipeline chat creates its schedule: once, no goal, no plan", async (t) => {
  const { call, store, scheduler } = await serve(t);
  const created = await call("POST", "/conversations", { agent: "pipeline" });
  assert.equal(created.status, 201);
  assert.equal(created.body.agentId, "pipeline");
  assert.equal((await store.load(created.body.id)).agentId, "pipeline");

  assert.deepEqual(scheduler.calls.find((c) => c.name === "createSchedule").args, {
    conversationId: created.body.id,
    mode: "once",
    goal: "",
    plan: [],
    intervalSeconds: 60,
    enabled: false,
  });
  assert.equal(created.body.schedule.enabled, false);

  // A chat agent gets a record and no schedule.
  const plain = await call("POST", "/conversations", { agent: "first-agent" });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.schedule, null);
  assert.equal(scheduler.schedules.size, 1);

  assert.equal((await call("POST", "/conversations", { agent: "nobody" })).status, 400);
  // The Day 18 id still names the same agent.
  assert.equal((await call("POST", "/conversations", { agent: "movie-picker" })).body.agentId, "pipeline");
});

test("GET pipeline returns goal, plan, proposal, mode, interval, switch and the server's clock", async (t) => {
  const { call } = await serve(t);
  const id = await newScheduledChat(call);
  const got = await call("GET", `/conversations/${id}/pipeline`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.pipeline, {
    scheduleId: got.body.pipeline.scheduleId,
    goal: "",
    plan: [],
    proposal: null,
    mode: "once",
    intervalSeconds: 60,
    enabled: false,
    nextRunAt: null,
    runPending: false,
  });
  assert.ok(Date.parse(got.body.now));
});

test("GET pipeline heals a chat that has none (made while the scheduler was down)", async (t) => {
  const { call, scheduler } = await serve(t);
  t.mock.method(console, "warn", () => {});
  scheduler.down = true;
  const created = await call("POST", "/conversations", { agent: "pipeline" });
  assert.equal(created.status, 201, "the chat is created anyway");
  assert.equal(created.body.schedule, null);
  assert.equal((await call("GET", `/conversations/${created.body.id}/pipeline`)).status, 503);

  scheduler.down = false;
  const got = await call("GET", `/conversations/${created.body.id}/pipeline`);
  assert.equal(got.status, 200);
  assert.equal(got.body.pipeline.mode, "once");
});

test("PUT pipeline takes goal, mode, interval and switch; never steps", async (t) => {
  const { call, scheduler } = await serve(t, { submissions: [WINNER_SUBMISSION] });
  const id = await newScheduledChat(call);
  const put = (body) => call("PUT", `/conversations/${id}/pipeline`, body);

  const bad = [
    [{ intervalSeconds: 14 }, /intervalSeconds/],
    [{ intervalSeconds: 15.5 }, /intervalSeconds/],
    [{ intervalSeconds: "30" }, /intervalSeconds/],
    [{ enabled: "yes" }, /enabled/],
    [{ mode: "sometimes" }, /mode/],
    [{ goal: 42 }, /'goal' must be text/],
    [{ goal: "x".repeat(4001) }, /at most 4000/],
    [{ steps: [{ kind: "prompt", text: "hi" }] }, /Steps are not edited by hand/],
    [{ plan: [] }, /Steps are not edited by hand/],
    [{}, /Nothing to change/],
    [[1, 2], /JSON object/],
    [{ mode: "interval", enabled: true }, /Accept a plan before enabling/],
  ];
  for (const [body, message] of bad) {
    const res = await put(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    assert.match(res.body.error, message);
  }
  assert.equal(scheduler.calls.filter((c) => c.name === "updateSchedule").length, 0, "nothing invalid reached the scheduler");

  const goal = await put({ goal: GOAL });
  assert.equal(goal.status, 200);
  assert.equal(goal.body.pipeline.goal, GOAL);

  // With an accepted plan, the switch works; partial updates keep the rest.
  await call("POST", `/conversations/${id}/pipeline/plan`);
  await call("POST", `/conversations/${id}/pipeline/proposal`, { action: "accept" });
  const ok = await put({ mode: "interval", enabled: true, intervalSeconds: 15 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.pipeline.mode, "interval");
  assert.equal(ok.body.pipeline.enabled, true);
  assert.equal(ok.body.pipeline.intervalSeconds, 15);
  assert.deepEqual(ok.body.pipeline.plan, WINNER_PLAN);
  const once = await put({ mode: "once" });
  assert.equal(once.body.pipeline.intervalSeconds, 15);
  assert.equal(once.body.pipeline.nextRunAt, null);
});

test("Generate plan: a valid plan is stored as the proposal, and the plan is untouched until it is accepted", async (t) => {
  const { call, store, provider, invalidated } = await serve(t, { submissions: [WINNER_SUBMISSION, WINNER_SUBMISSION] });
  const id = await newScheduledChat(call);

  // No goal yet: nothing to plan from.
  const empty = await call("POST", `/conversations/${id}/pipeline/plan`, {});
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /Write a goal first/);
  assert.equal(provider.toolCalls.length, 0);

  const planned = await call("POST", `/conversations/${id}/pipeline/plan`, { goal: GOAL });
  assert.equal(planned.status, 200);
  assert.equal(planned.body.attempts, 1);
  const { pipeline } = planned.body;
  assert.equal(pipeline.goal, GOAL, "the goal in the body is saved first");
  assert.deepEqual(pipeline.plan, [], "nothing runs until it is accepted");
  assert.deepEqual(pipeline.proposal.steps, WINNER_PLAN);
  assert.equal(pipeline.proposal.reason, "generated");
  assert.equal(pipeline.proposal.notes, WINNER_SUBMISSION.notes);
  assert.ok(Date.parse(pipeline.proposal.createdAt));
  assert.equal(pipeline.proposal.errors, undefined);
  // The chat is named after its goal.
  assert.match((await store.load(id)).title, /^Look up Inception, The Matrix and Heat\.…$/);
  assert.ok(invalidated.includes(id));
  // Run needs an accepted plan.
  assert.equal((await call("POST", `/conversations/${id}/pipeline/run`)).status, 409);

  // Accept: the proposal becomes the plan, and is gone.
  const accepted = await call("POST", `/conversations/${id}/pipeline/proposal`, { action: "accept" });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body.pipeline.plan, WINNER_PLAN);
  assert.equal(accepted.body.pipeline.proposal, null);
  assert.equal((await call("POST", `/conversations/${id}/pipeline/proposal`, { action: "accept" })).status, 409, "nothing left to accept");

  // Generate again, then discard: the proposal is cleared and the plan stays.
  assert.equal((await call("POST", `/conversations/${id}/pipeline/plan`)).status, 200);
  const discarded = await call("POST", `/conversations/${id}/pipeline/proposal`, { action: "discard" });
  assert.equal(discarded.status, 200);
  assert.equal(discarded.body.pipeline.proposal, null);
  assert.deepEqual(discarded.body.pipeline.plan, WINNER_PLAN);
  assert.equal((await call("POST", `/conversations/${id}/pipeline/proposal`, { action: "maybe" })).status, 400);
});

test("Generate plan: a plan invalid twice is a 422 with the errors, and stores nothing", async (t) => {
  const invented = { steps: [{ kind: "tool", tool: "imdb.top_rated", args: {}, why: "" }] };
  const { call, scheduler, provider } = await serve(t, { submissions: [invented, invented] });
  const id = await newScheduledChat(call);
  const res = await call("POST", `/conversations/${id}/pipeline/plan`, { goal: "Find the best film." });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /did not validate, even after one retry\. Nothing was stored/);
  assert.deepEqual(res.body.errors, ["Step 1 (imdb.top_rated): imdb.top_rated is not in the catalog. Use only the tools listed there, exactly as named."]);
  assert.equal(provider.toolCalls.length, 2);
  const [schedule] = scheduler.schedules.values();
  assert.equal(schedule.proposal, null);
  assert.deepEqual(schedule.plan, []);
  assert.equal(schedule.goal, "Find the best film.", "the goal itself was saved");
});

test("a repair proposal that did not validate cannot be accepted", async (t) => {
  const { call, scheduler } = await serve(t, { submissions: [WINNER_SUBMISSION] });
  const id = await acceptedChat(call);
  const [schedule] = scheduler.schedules.values();
  await scheduler.updateSchedule(schedule.id, {
    proposal: { steps: [], createdAt: new Date().toISOString(), reason: "repair", errors: ["The plan has no steps."], run: { id: 1, error: "x" } },
  });
  const got = await call("GET", `/conversations/${id}/pipeline`);
  assert.equal(got.body.pipeline.proposal.reason, "repair");
  const res = await call("POST", `/conversations/${id}/pipeline/proposal`, { action: "accept" });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /did not validate/);
  assert.deepEqual((await call("POST", `/conversations/${id}/pipeline/proposal`, { action: "discard" })).body.pipeline.proposal, null);
  assert.deepEqual(scheduler.schedules.get(schedule.id).plan, WINNER_PLAN);
});

test("the pipeline routes 404 for a chat agent's conversation and 400 for a bad id", async (t) => {
  const { call } = await serve(t);
  const plain = (await call("POST", "/conversations", { agent: "first-agent" })).body.id;
  assert.equal((await call("GET", `/conversations/${plain}/pipeline`)).status, 404);
  assert.equal((await call("PUT", `/conversations/${plain}/pipeline`, { enabled: false })).status, 404);
  assert.equal((await call("POST", `/conversations/${plain}/pipeline/plan`, { goal: "x" })).status, 404);
  assert.equal((await call("POST", `/conversations/${plain}/pipeline/proposal`, { action: "accept" })).status, 404);
  assert.equal((await call("POST", `/conversations/${plain}/pipeline/run`)).status, 404);
  assert.equal((await call("GET", `/conversations/${CHAT}/runs`)).status, 404);
  assert.equal((await call("GET", "/conversations/not-a-uuid/pipeline")).status, 400);
});

test("POST /chat to a scheduled chat is a 400 with the reason; other chats pass through", async (t) => {
  const { call } = await serve(t);
  const id = await newScheduledChat(call);
  const refused = await call("POST", "/chat", { sessionId: id, message: "hello?" });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, READ_ONLY_REASON);

  // A brand-new id on the scheduled agent is refused too: there is no composer to open one with.
  const fresh = await call("POST", "/chat", { sessionId: CHAT, agent: "pipeline", message: "hi" });
  assert.equal(fresh.status, 400);

  const plain = (await call("POST", "/conversations", { agent: "first-agent" })).body.id;
  assert.deepEqual((await call("POST", "/chat", { sessionId: plain, message: "hi" })).body, { reached: true });
  assert.deepEqual((await call("POST", "/chat", { sessionId: CHAT, message: "hi" })).body, { reached: true });
});

test("forking a scheduled chat is refused", async (t) => {
  const { call } = await serve(t);
  const id = await newScheduledChat(call);
  const res = await call("POST", `/conversations/${id}/fork`, { fromMessageId: "m1" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cannot be forked/);
});

test("deleting a scheduled chat deletes its schedule, runs and records with it", async (t) => {
  const { call, store, scheduler, invalidated } = await serve(t);
  const id = await newScheduledChat(call);
  const keep = await newScheduledChat(call);
  const [doomed] = [...scheduler.schedules.values()];
  scheduler.records.push({ scheduleId: doomed.id, key: "tt1", label: "A" });

  const res = await call("DELETE", `/conversations/${id}`);
  assert.deepEqual(res.body, { ok: true, scheduleDeleted: true });
  assert.equal(await store.load(id), null);
  assert.equal(scheduler.schedules.has(doomed.id), false);
  assert.equal(scheduler.records.length, 0);
  assert.ok(invalidated.includes(id));
  // The other chat's schedule is untouched.
  assert.ok(await scheduler.getSchedule(keep));

  // A chat agent's delete is handed on to the main route.
  const plain = (await call("POST", "/conversations", { agent: "first-agent" })).body.id;
  assert.deepEqual((await call("DELETE", `/conversations/${plain}`)).body, { reached: true });
});

test("Run needs a plan, works in either mode, and kicks the ticker; runs and one run's steps are listed", async (t) => {
  const { call, scheduler, kicks } = await serve(t, { submissions: [WINNER_SUBMISSION] });
  const planless = await newScheduledChat(call);
  const empty = await call("POST", `/conversations/${planless}/pipeline/run`);
  assert.equal(empty.status, 409);
  assert.match(empty.body.error, /Generate a plan and accept it first/);

  // Once mode, not enabled: Run is still a run.
  const id = await acceptedChat(call);
  const ran = await call("POST", `/conversations/${id}/pipeline/run`);
  assert.equal(ran.status, 200);
  assert.equal(ran.body.pipeline.runPending, true);
  assert.equal(kicks.length, 1);

  const { claimed } = await scheduler.claimDueRuns();
  assert.equal(claimed.length, 1);
  assert.deepEqual(claimed[0].schedule.plan, WINNER_PLAN);
  const runId = claimed[0].run.id;
  const step = { index: 1, kind: "tool", server: "omdb", tool: "get_movie", input: { title: "Inception" }, output: { title: "Inception" }, status: "ok", ms: 12 };
  await scheduler.finishRun({ runId, ok: true, output: "{}", steps: [step] });

  const runs = await call("GET", `/conversations/${id}/runs?limit=10`);
  assert.equal(runs.status, 200);
  assert.equal(runs.body.runs.length, 1);
  assert.equal((await call("GET", `/conversations/${id}/runs?limit=0`)).status, 400);

  const one = await call("GET", `/conversations/${id}/runs/${runId}`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.steps, [step]);
  assert.equal((await call("GET", `/conversations/${id}/runs/999`)).status, 404);
  assert.equal((await call("GET", `/conversations/${id}/runs/abc`)).status, 400);

  // Another chat cannot read this chat's run.
  const other = await newScheduledChat(call);
  assert.equal((await call("GET", `/conversations/${other}/runs/${runId}`)).status, 404);
});

test("a scheduler that is down is a 503 that says what to start", async (t) => {
  const { call, scheduler } = await serve(t);
  const id = await newScheduledChat(call);
  scheduler.down = true;
  const res = await call("PUT", `/conversations/${id}/pipeline`, { intervalSeconds: 30 });
  assert.equal(res.status, 503);
  assert.match(res.body.error, /Start scheduler_mcp_server/);
});
