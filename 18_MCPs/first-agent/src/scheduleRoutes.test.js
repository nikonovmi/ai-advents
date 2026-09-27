import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { FakeScheduler } from "./scheduler/fakeScheduler.js";
import { READ_ONLY_REASON, scheduleRoutes } from "./scheduleRoutes.js";
import { MemoryStore } from "./store/memoryStore.js";

/**
 * **The schedule routes, over HTTP**, with an in-memory scheduler behind them.
 * Every route the main server owns (/chat, fork, delete) is stood in for by a
 * handler that answers `reached`, so a test can tell "guarded here" from
 * "handed on".
 */

const CHAT = "55555555-5555-4555-8555-555555555555";

async function serve(t) {
  const store = new MemoryStore();
  const scheduler = new FakeScheduler();
  const invalidated = [];

  const app = express();
  app.use(express.json());
  app.use(scheduleRoutes({ store, scheduler, invalidate: (id) => invalidated.push(id) }));
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

  return { call, store, scheduler, invalidated };
}

async function newScheduledChat(call) {
  const created = await call("POST", "/conversations", { agent: "movie-picker" });
  assert.equal(created.status, 201);
  return created.body.id;
}

test("creating a scheduled chat creates its schedule: disabled, 60 s, no prompt", async (t) => {
  const { call, store, scheduler } = await serve(t);
  const created = await call("POST", "/conversations", { agent: "movie-picker" });
  assert.equal(created.status, 201);
  assert.equal(created.body.agentId, "movie-picker");
  assert.equal((await store.load(created.body.id)).agentId, "movie-picker");

  assert.deepEqual(scheduler.calls.find((c) => c.name === "createSchedule").args, {
    conversationId: created.body.id,
    prompt: "",
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
});

test("GET schedule returns the schedule, the aggregate and the server's clock", async (t) => {
  const { call } = await serve(t);
  const id = await newScheduledChat(call);
  const got = await call("GET", `/conversations/${id}/schedule`);
  assert.equal(got.status, 200);
  assert.equal(got.body.schedule.conversationId, id);
  assert.equal(got.body.schedule.intervalSeconds, 60);
  assert.deepEqual(got.body.aggregate, { invocations: 0, uniqueKeys: 0, mostRepeated: null, first: null, last: null });
  assert.ok(Date.parse(got.body.now));
});

test("GET schedule heals a chat that has none (made while the scheduler was down)", async (t) => {
  const { call, scheduler } = await serve(t);
  t.mock.method(console, "warn", () => {});
  scheduler.down = true;
  const created = await call("POST", "/conversations", { agent: "movie-picker" });
  assert.equal(created.status, 201, "the chat is created anyway");
  assert.equal(created.body.schedule, null);
  assert.equal((await call("GET", `/conversations/${created.body.id}/schedule`)).status, 503);

  scheduler.down = false;
  const got = await call("GET", `/conversations/${created.body.id}/schedule`);
  assert.equal(got.status, 200);
  assert.equal(got.body.schedule.enabled, false);
});

test("PUT schedule validates every field and refuses to enable an empty prompt", async (t) => {
  const { call, scheduler } = await serve(t);
  const id = await newScheduledChat(call);
  const put = (body) => call("PUT", `/conversations/${id}/schedule`, body);

  const bad = [
    [{ intervalSeconds: 14 }, /intervalSeconds/],
    [{ intervalSeconds: 15.5 }, /intervalSeconds/],
    [{ intervalSeconds: "30" }, /intervalSeconds/],
    [{ intervalSeconds: 999_999_999 }, /intervalSeconds/],
    [{ enabled: "yes" }, /enabled/],
    [{ prompt: 42 }, /prompt/],
    [{ prompt: "x".repeat(8001) }, /prompt/],
    [{}, /Nothing to change/],
    [[1, 2], /JSON object/],
    [{ enabled: true }, /Write a prompt before enabling/],
    [{ enabled: true, prompt: "   " }, /Write a prompt before enabling/],
  ];
  for (const [body, message] of bad) {
    const res = await put(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    assert.match(res.body.error, message);
  }
  assert.equal(scheduler.calls.filter((c) => c.name === "updateSchedule").length, 0, "nothing invalid reached the scheduler");

  const ok = await put({ enabled: true, intervalSeconds: 15, prompt: "Call random_movie and reply in one line." });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.schedule.enabled, true);
  assert.equal(ok.body.schedule.intervalSeconds, 15);
  assert.equal(ok.body.schedule.prompt, "Call random_movie and reply in one line.");

  // Partial updates keep the rest; switching off needs no prompt check.
  const off = await put({ enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.schedule.intervalSeconds, 15);
  assert.equal(off.body.schedule.enabled, false);
});

test("saving a prompt names the chat after it", async (t) => {
  const { call, store, invalidated } = await serve(t);
  const id = await newScheduledChat(call);
  await call("PUT", `/conversations/${id}/schedule`, { prompt: "Pick a film every fifteen seconds and count the repeats" });
  assert.equal((await store.load(id)).title, "Pick a film every fifteen seconds and c…");
  assert.ok(invalidated.includes(id));
});

test("the schedule routes 404 for a chat agent's conversation and 400 for a bad id", async (t) => {
  const { call } = await serve(t);
  const plain = (await call("POST", "/conversations", { agent: "first-agent" })).body.id;
  assert.equal((await call("GET", `/conversations/${plain}/schedule`)).status, 404);
  assert.equal((await call("PUT", `/conversations/${plain}/schedule`, { enabled: false })).status, 404);
  assert.equal((await call("GET", `/conversations/${CHAT}/runs`)).status, 404);
  assert.equal((await call("GET", "/conversations/not-a-uuid/schedule")).status, 400);
});

test("POST /chat to a scheduled chat is a 400 with the reason; other chats pass through", async (t) => {
  const { call } = await serve(t);
  const id = await newScheduledChat(call);
  const refused = await call("POST", "/chat", { sessionId: id, message: "hello?" });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, READ_ONLY_REASON);

  // A brand-new id on the scheduled agent is refused too: there is no composer to open one with.
  const fresh = await call("POST", "/chat", { sessionId: CHAT, agent: "movie-picker", message: "hi" });
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

test("run-now needs an enabled schedule; runs lists the latest", async (t) => {
  const { call, scheduler } = await serve(t);
  const id = await newScheduledChat(call);
  const off = await call("POST", `/conversations/${id}/schedule/run-now`);
  assert.equal(off.status, 409);
  assert.match(off.body.error, /Enable it first/);

  await call("PUT", `/conversations/${id}/schedule`, { enabled: true, prompt: "go" });
  const now = await call("POST", `/conversations/${id}/schedule/run-now`);
  assert.equal(now.status, 200);
  assert.ok(scheduler.calls.some((c) => c.name === "runNow"));

  await scheduler.claimDueRuns();
  const runs = await call("GET", `/conversations/${id}/runs?limit=10`);
  assert.equal(runs.status, 200);
  assert.equal(runs.body.runs.length, 1);
  assert.equal(runs.body.runs[0].status, "running");
  assert.equal((await call("GET", `/conversations/${id}/runs?limit=0`)).status, 400);
});

test("a scheduler that is down is a 503 that says what to start", async (t) => {
  const { call, scheduler } = await serve(t);
  const id = await newScheduledChat(call);
  scheduler.down = true;
  const res = await call("PUT", `/conversations/${id}/schedule`, { intervalSeconds: 30 });
  assert.equal(res.status, 503);
  assert.match(res.body.error, /Start scheduler_mcp_server/);
});
