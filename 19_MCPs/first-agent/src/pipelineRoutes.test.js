import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { FakeScheduler } from "./scheduler/fakeScheduler.js";
import { READ_ONLY_REASON, pipelineRoutes } from "./pipelineRoutes.js";
import { MemoryStore } from "./store/memoryStore.js";

/**
 * **The pipeline routes, over HTTP**, with an in-memory scheduler behind them.
 * Every route the main server owns (/chat, fork, delete) is stood in for by a
 * handler that answers `reached`, so a test can tell "guarded here" from
 * "handed on".
 */

const CHAT = "55555555-5555-4555-8555-555555555555";

async function serve(t) {
  const store = new MemoryStore();
  const scheduler = new FakeScheduler();
  const invalidated = [];
  const kicks = [];

  const app = express();
  app.use(express.json());
  app.use(
    pipelineRoutes({
      store,
      scheduler,
      servers: ["omdb", "notion", "scheduler"],
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

  return { call, store, scheduler, invalidated, kicks };
}

async function newScheduledChat(call) {
  const created = await call("POST", "/conversations", { agent: "pipeline" });
  assert.equal(created.status, 201);
  return created.body.id;
}

const SEARCH = { kind: "tool", server: "omdb", tool: "search_movies", args: { query: "batman" } };
const SUMMARIZE = { kind: "prompt", text: "Summarize what you found in 3 sentences:\n{{prev}}" };

test("creating a pipeline chat creates its schedule: once, no steps", async (t) => {
  const { call, store, scheduler } = await serve(t);
  const created = await call("POST", "/conversations", { agent: "pipeline" });
  assert.equal(created.status, 201);
  assert.equal(created.body.agentId, "pipeline");
  assert.equal((await store.load(created.body.id)).agentId, "pipeline");

  assert.deepEqual(scheduler.calls.find((c) => c.name === "createSchedule").args, {
    conversationId: created.body.id,
    mode: "once",
    steps: [],
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

test("GET pipeline returns mode, interval, switch, steps and the server's clock", async (t) => {
  const { call } = await serve(t);
  const id = await newScheduledChat(call);
  const got = await call("GET", `/conversations/${id}/pipeline`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.pipeline, {
    scheduleId: got.body.pipeline.scheduleId,
    mode: "once",
    intervalSeconds: 60,
    enabled: false,
    steps: [],
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

test("PUT pipeline validates shape here and passes the scheduler's step errors through as 400s", async (t) => {
  const { call, scheduler } = await serve(t);
  const id = await newScheduledChat(call);
  const put = (body) => call("PUT", `/conversations/${id}/pipeline`, body);

  const bad = [
    [{ intervalSeconds: 14 }, /intervalSeconds/],
    [{ intervalSeconds: 15.5 }, /intervalSeconds/],
    [{ intervalSeconds: "30" }, /intervalSeconds/],
    [{ enabled: "yes" }, /enabled/],
    [{ mode: "sometimes" }, /mode/],
    [{ steps: "search" }, /steps/],
    [{ steps: [{ kind: "tool", server: "jira", tool: "x" }] }, /Step 1: there is no MCP server "jira"/],
    [{}, /Nothing to change/],
    [[1, 2], /JSON object/],
    [{ mode: "interval", enabled: true }, /Add a step before enabling/],
  ];
  for (const [body, message] of bad) {
    const res = await put(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    assert.match(res.body.error, message);
  }
  assert.equal(scheduler.calls.filter((c) => c.name === "updateSchedule").length, 0, "nothing invalid reached the scheduler");

  // The scheduler's own rule — a template that points forward — comes back verbatim.
  const forward = await put({ steps: [{ kind: "prompt", text: "{{steps.2}}" }, SUMMARIZE] });
  assert.equal(forward.status, 400);
  assert.match(forward.body.error, /Step 1: \{\{steps\.2\}\} must refer to an earlier step/);

  const ok = await put({ mode: "interval", enabled: true, intervalSeconds: 15, steps: [SEARCH, SUMMARIZE] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.pipeline.mode, "interval");
  assert.equal(ok.body.pipeline.enabled, true);
  assert.equal(ok.body.pipeline.intervalSeconds, 15);
  assert.deepEqual(ok.body.pipeline.steps, [SEARCH, SUMMARIZE]);

  // Partial updates keep the rest; switching to once clears the next run.
  const once = await put({ mode: "once" });
  assert.equal(once.status, 200);
  assert.equal(once.body.pipeline.intervalSeconds, 15);
  assert.equal(once.body.pipeline.nextRunAt, null);
});

test("saving steps names the chat after them", async (t) => {
  const { call, store, invalidated } = await serve(t);
  const id = await newScheduledChat(call);
  await call("PUT", `/conversations/${id}/pipeline`, { steps: [SEARCH, SUMMARIZE] });
  assert.equal((await store.load(id)).title, "search_movies → prompt");
  assert.ok(invalidated.includes(id));
});

test("the pipeline routes 404 for a chat agent's conversation and 400 for a bad id", async (t) => {
  const { call } = await serve(t);
  const plain = (await call("POST", "/conversations", { agent: "first-agent" })).body.id;
  assert.equal((await call("GET", `/conversations/${plain}/pipeline`)).status, 404);
  assert.equal((await call("PUT", `/conversations/${plain}/pipeline`, { enabled: false })).status, 404);
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

test("Run needs steps, works in either mode, and kicks the ticker; runs and one run's steps are listed", async (t) => {
  const { call, scheduler, kicks } = await serve(t);
  const id = await newScheduledChat(call);
  const empty = await call("POST", `/conversations/${id}/pipeline/run`);
  assert.equal(empty.status, 409);
  assert.match(empty.body.error, /Add a step/);

  // Once mode, not enabled: Run is still a run.
  await call("PUT", `/conversations/${id}/pipeline`, { steps: [SEARCH] });
  const ran = await call("POST", `/conversations/${id}/pipeline/run`);
  assert.equal(ran.status, 200);
  assert.equal(ran.body.pipeline.runPending, true);
  assert.equal(kicks.length, 1);

  const { claimed } = await scheduler.claimDueRuns();
  assert.equal(claimed.length, 1);
  const runId = claimed[0].run.id;
  const step = { index: 1, kind: "tool", server: "omdb", tool: "search_movies", input: { query: "batman" }, output: { results: [] }, status: "ok", ms: 12 };
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
