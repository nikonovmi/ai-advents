import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { STALE_AFTER_MS, openScheduler } from "./db.js";
import { createServer } from "./tools.js";

/**
 * Every test gets its own database file in a temp directory, and a clock it
 * can move: `clock.at` is "now" for anything that does not pass a time.
 */

const T0 = Date.parse("2026-09-27T12:00:00.000Z");

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "scheduler.db");
}

function open(t, { file = tempDb(t) } = {}) {
  const clock = { at: T0 };
  const scheduler = openScheduler({ file, now: () => clock.at });
  t.after(() => {
    try {
      scheduler.close();
    } catch {
      // Already closed by the test.
    }
  });
  return { scheduler, clock, file };
}

let conversation = 0;
const newConversation = () => `c-${++conversation}`;

function enabledSchedule(scheduler, options = {}) {
  const schedule = scheduler.createSchedule({ conversationId: newConversation(), prompt: "do it", intervalSeconds: 60, ...options });
  return scheduler.updateSchedule({ scheduleId: schedule.id, enabled: true });
}

// ---- claiming ----------------------------------------------------------------

test("a due, enabled schedule is claimed once, and not again while its run is open", (t) => {
  const { scheduler } = open(t);
  const schedule = enabledSchedule(scheduler);

  const first = scheduler.claimDueRuns({ now: T0 });
  assert.equal(first.claimed.length, 1);
  assert.equal(first.claimed[0].schedule.id, schedule.id);
  assert.equal(first.claimed[0].run.status, "running");

  // Same instant, and a full interval later: the open run blocks both.
  assert.equal(scheduler.claimDueRuns({ now: T0 }).claimed.length, 0);
  assert.equal(scheduler.claimDueRuns({ now: T0 + 60_000 }).claimed.length, 0);

  scheduler.finishRun({ runId: first.claimed[0].run.id, ok: true, output: "done", tokens: 42 });
  assert.equal(scheduler.claimDueRuns({ now: T0 + 60_000 }).claimed.length, 1);
});

test("claiming is atomic: four connections racing on one file never double-claim", async (t) => {
  const { scheduler, file } = open(t);
  const ids = Array.from({ length: 25 }, () => enabledSchedule(scheduler).id);

  const contenders = Array.from({ length: 4 }, () =>
    new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./testing/claimWorker.js", import.meta.url), {
        workerData: { file, rounds: 50, at: T0 },
      });
      worker.once("message", resolve);
      worker.once("error", reject);
    })
  );
  const runIds = (await Promise.all(contenders)).flat();

  // Every schedule was claimed exactly once, across all four.
  assert.equal(runIds.length, ids.length);
  assert.equal(new Set(runIds).size, ids.length);
  for (const id of ids) {
    const runs = scheduler.listRuns({ scheduleId: id, limit: 10 });
    assert.equal(runs.length, 1, `schedule ${id} has ${runs.length} runs`);
  }
});

test("disabled schedules are never claimed, however overdue", (t) => {
  const { scheduler } = open(t);
  const off = scheduler.createSchedule({ conversationId: newConversation(), prompt: "x" });
  assert.equal(off.enabled, false);
  assert.equal(scheduler.claimDueRuns({ now: T0 + 86_400_000 }).claimed.length, 0);

  // run_now makes it due, but due is not enabled.
  scheduler.runNow({ scheduleId: off.id });
  assert.equal(scheduler.claimDueRuns({ now: T0 + 86_400_000 }).claimed.length, 0);

  // And switching one off stops it.
  const on = enabledSchedule(scheduler);
  scheduler.updateSchedule({ scheduleId: on.id, enabled: false });
  assert.equal(scheduler.claimDueRuns({ now: T0 + 86_400_000 }).claimed.length, 0);
});

test("interval math: next run is claim time + interval, and run_now pulls it in", (t) => {
  const { scheduler, clock } = open(t);
  const schedule = enabledSchedule(scheduler, { intervalSeconds: 15 });
  // Enabling makes it due immediately.
  assert.equal(schedule.nextRunAt, new Date(T0).toISOString());

  const at = T0 + 1234;
  const { claimed } = scheduler.claimDueRuns({ now: at });
  assert.equal(claimed[0].schedule.nextRunAt, new Date(at + 15_000).toISOString());
  scheduler.finishRun({ runId: claimed[0].run.id, ok: true });

  // One millisecond early is not due; exactly on time is.
  assert.equal(scheduler.claimDueRuns({ now: at + 14_999 }).claimed.length, 0);
  const next = scheduler.claimDueRuns({ now: at + 15_000 }).claimed;
  assert.equal(next.length, 1);
  assert.equal(next[0].schedule.nextRunAt, new Date(at + 30_000).toISOString());
  scheduler.finishRun({ runId: next[0].run.id, ok: true });

  // run_now: due at the server's clock.
  clock.at = at + 16_000;
  const now = scheduler.runNow({ scheduleId: schedule.id });
  assert.equal(now.nextRunAt, new Date(at + 16_000).toISOString());
  assert.equal(scheduler.claimDueRuns({ now: at + 16_000 }).claimed.length, 1);

  // Shortening the interval pulls a far-off next run in; lengthening leaves it.
  const slow = enabledSchedule(scheduler, { intervalSeconds: 3600 });
  const claimedSlow = scheduler.claimDueRuns({ now: clock.at }).claimed.find((c) => c.schedule.id === slow.id);
  scheduler.finishRun({ runId: claimedSlow.run.id, ok: true });
  const shorter = scheduler.updateSchedule({ scheduleId: slow.id, intervalSeconds: 30 });
  assert.equal(shorter.nextRunAt, new Date(clock.at + 30_000).toISOString());

  assert.throws(() => scheduler.updateSchedule({ scheduleId: slow.id, intervalSeconds: 5 }), /at least 15/);
});

test("graceMs claims a schedule due a moment from now, and the next run still counts from now", (t) => {
  const { scheduler } = open(t);
  enabledSchedule(scheduler, { intervalSeconds: 15 });
  const [{ run }] = scheduler.claimDueRuns({ now: T0 + 8 }).claimed;
  scheduler.finishRun({ runId: run.id, ok: true });

  // Due at T0 + 15 008; a tick at T0 + 15 000 misses it without grace...
  assert.equal(scheduler.claimDueRuns({ now: T0 + 15_000 }).claimed.length, 0);
  // ...and claims it with a second of it, measuring the next run from the claim.
  const [next] = scheduler.claimDueRuns({ now: T0 + 15_000, graceMs: 1000 }).claimed;
  assert.equal(next.schedule.nextRunAt, new Date(T0 + 30_000).toISOString());
  assert.equal(next.run.claimedAt, new Date(T0 + 15_000).toISOString());
  assert.throws(() => scheduler.claimDueRuns({ graceMs: -1 }), /graceMs/);
});

test("a run stuck in 'running' for 5 minutes is released and its schedule claimed again", (t) => {
  const { scheduler } = open(t);
  const schedule = enabledSchedule(scheduler, { intervalSeconds: 15 });
  const [stuck] = scheduler.claimDueRuns({ now: T0 }).claimed;

  // Due again after 15 s, but the open run blocks it until it goes stale.
  assert.equal(scheduler.claimDueRuns({ now: T0 + STALE_AFTER_MS - 1 }).claimed.length, 0);

  const later = scheduler.claimDueRuns({ now: T0 + STALE_AFTER_MS });
  assert.equal(later.released, 1);
  assert.equal(later.claimed.length, 1);
  assert.notEqual(later.claimed[0].run.id, stuck.run.id);

  const [fresh, old] = scheduler.listRuns({ scheduleId: schedule.id, limit: 10 });
  assert.equal(fresh.status, "running");
  assert.equal(old.status, "error");
  assert.match(old.error, /Abandoned/);

  // The runner that finally comes back cannot overwrite the verdict.
  assert.throws(() => scheduler.finishRun({ runId: stuck.run.id, ok: true }), /already finished/);
});

test("release_runs closes every open run, for a ticker that just restarted", (t) => {
  const { scheduler } = open(t);
  enabledSchedule(scheduler);
  enabledSchedule(scheduler);
  assert.equal(scheduler.claimDueRuns({ now: T0 }).claimed.length, 2);
  assert.equal(scheduler.releaseRuns().released, 2);
  assert.equal(scheduler.claimDueRuns({ now: T0 + 60_000 }).claimed.length, 2);
});

test("finish_run records the outcome and the duration", (t) => {
  const { scheduler, clock } = open(t);
  const schedule = enabledSchedule(scheduler);
  const [{ run }] = scheduler.claimDueRuns({ now: T0 }).claimed;
  clock.at = T0 + 2500;
  const done = scheduler.finishRun({ runId: run.id, ok: false, error: "model down", tokens: 7 });
  assert.equal(done.status, "error");
  assert.equal(done.durationMs, 2500);
  assert.equal(done.error, "model down");
  assert.equal(done.tokens, 7);
  assert.deepEqual(scheduler.listRuns({ scheduleId: schedule.id, limit: 1 }).map((r) => r.id), [run.id]);
});

// ---- records -----------------------------------------------------------------

test("aggregate: invocations, unique keys, the most repeated, first and last", (t) => {
  const { scheduler, clock } = open(t);
  const schedule = enabledSchedule(scheduler);
  const other = enabledSchedule(scheduler);

  const empty = scheduler.aggregate({ scheduleId: schedule.id });
  assert.deepEqual(empty, { invocations: 0, uniqueKeys: 0, mostRepeated: null, first: null, last: null });

  const picks = [
    ["tt1375666", "Inception (2010)"],
    ["tt0133093", "The Matrix (1999)"],
    ["tt1375666", "Inception (2010)"],
    ["tt0068646", "The Godfather (1972)"],
    ["tt0133093", "The Matrix (1999)"],
    ["tt1375666", "Inception (2010)"],
  ];
  picks.forEach(([key, label], i) => {
    clock.at = T0 + i * 15_000;
    scheduler.record({ scheduleId: schedule.id, key, label, data: { i } });
  });
  // Another schedule's records never leak in.
  scheduler.record({ scheduleId: other.id, key: "tt0068646", label: "The Godfather (1972)" });

  assert.deepEqual(scheduler.aggregate({ scheduleId: schedule.id }), {
    invocations: 6,
    uniqueKeys: 3,
    mostRepeated: { label: "Inception (2010)", count: 3 },
    first: { label: "Inception (2010)", at: new Date(T0).toISOString() },
    last: { label: "Inception (2010)", at: new Date(T0 + 5 * 15_000).toISOString() },
  });
  assert.equal(scheduler.aggregate({ scheduleId: other.id }).invocations, 1);

  // A tie goes to the key recorded most recently.
  scheduler.record({ scheduleId: other.id, key: "tt0133093", label: "The Matrix (1999)" });
  assert.deepEqual(scheduler.aggregate({ scheduleId: other.id }).mostRepeated, { label: "The Matrix (1999)", count: 1 });

  assert.throws(() => scheduler.record({ scheduleId: 999, key: "k", label: "l" }), /No schedule with id 999/);
});

test("everything survives closing and reopening the database", (t) => {
  const first = open(t);
  const schedule = enabledSchedule(first.scheduler, { intervalSeconds: 15 });
  const [{ run }] = first.scheduler.claimDueRuns({ now: T0 }).claimed;
  first.scheduler.finishRun({ runId: run.id, ok: true, output: "one", tokens: 10 });
  first.scheduler.record({ scheduleId: schedule.id, key: "a", label: "A" });
  first.scheduler.record({ scheduleId: schedule.id, key: "b", label: "B" });
  first.scheduler.close();

  const again = open(t, { file: first.file });
  const loaded = again.scheduler.getSchedule({ conversationId: schedule.conversationId });
  assert.equal(loaded.id, schedule.id);
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.nextRunAt, new Date(T0 + 15_000).toISOString());
  assert.equal(again.scheduler.listRuns({ scheduleId: schedule.id, limit: 10 })[0].output, "one");
  assert.equal(again.scheduler.aggregate({ scheduleId: schedule.id }).invocations, 2);
  // And it carries on: the next claim is on the saved schedule.
  assert.equal(again.scheduler.claimDueRuns({ now: T0 + 15_000 }).claimed.length, 1);
});

test("deleting a schedule deletes its runs and records", (t) => {
  const { scheduler, file } = open(t);
  const doomed = enabledSchedule(scheduler);
  const kept = enabledSchedule(scheduler);
  scheduler.claimDueRuns({ now: T0 });
  scheduler.record({ scheduleId: doomed.id, key: "a", label: "A" });
  scheduler.record({ scheduleId: kept.id, key: "a", label: "A" });

  assert.deepEqual(scheduler.deleteSchedule({ scheduleId: doomed.id }), { deleted: true, scheduleId: doomed.id });
  assert.equal(scheduler.getSchedule({ conversationId: doomed.conversationId }), null);
  scheduler.close();

  // Counted straight from the file, not through the API that just said so.
  const db = new Database(file, { readonly: true });
  const count = (table, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE scheduleId = ?`).get(id).n;
  assert.equal(count("runs", doomed.id), 0);
  assert.equal(count("records", doomed.id), 0);
  assert.equal(count("runs", kept.id), 1);
  assert.equal(count("records", kept.id), 1);
  db.close();

  const { scheduler: reopened } = open(t, { file });
  assert.deepEqual(reopened.listSchedules().map((s) => s.id), [kept.id]);
  assert.throws(() => reopened.listRuns({ scheduleId: doomed.id, limit: 10 }), /No schedule/);
});

test("one schedule per conversation", (t) => {
  const { scheduler } = open(t);
  scheduler.createSchedule({ conversationId: "same" });
  assert.throws(() => scheduler.createSchedule({ conversationId: "same" }), /already has a schedule/);
});

// ---- over MCP ----------------------------------------------------------------

test("the server lists every tool, and errors are isError rather than crashes", async (t) => {
  const { scheduler } = open(t);
  const server = createServer({ scheduler });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "aggregate", "claim_due_runs", "create_schedule", "delete_schedule", "finish_run",
    "get_schedule", "list_runs", "list_schedules", "record", "release_runs", "run_now", "update_schedule",
  ]);
  const record = tools.find((tool) => tool.name === "record");
  assert.deepEqual(record.inputSchema.required.sort(), ["key", "label", "scheduleId"]);

  const created = await client.callTool({ name: "create_schedule", arguments: { conversationId: "c-mcp", intervalSeconds: 15 } });
  assert.equal(created.structuredContent.enabled, false);
  const got = await client.callTool({ name: "get_schedule", arguments: { conversationId: "c-mcp" } });
  assert.equal(got.structuredContent.schedule.id, created.structuredContent.id);

  const tooFast = await client.callTool({ name: "update_schedule", arguments: { scheduleId: created.structuredContent.id, intervalSeconds: 5 } });
  assert.equal(tooFast.isError, true);
  const missing = await client.callTool({ name: "aggregate", arguments: { scheduleId: 12345 } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /No schedule with id 12345/);
});
