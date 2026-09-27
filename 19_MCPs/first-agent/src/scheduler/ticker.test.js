import assert from "node:assert/strict";
import test from "node:test";

import { FakeScheduler } from "./fakeScheduler.js";
import { CLAIM_GRACE_MS, Ticker } from "./ticker.js";

/**
 * **The ticker, with a fake clock and a fake timer.** Nothing waits on real
 * time: the test holds the interval callback and fires it, and moves the clock
 * by hand between ticks.
 */

const T0 = Date.parse("2026-09-27T12:00:00.000Z");

function world({ runner } = {}) {
  const clock = { at: T0 };
  const scheduler = new FakeScheduler({ now: () => clock.at });
  const timer = { callback: null, ms: null, cleared: false };
  const logs = [];
  const ticker = new Ticker({
    scheduler,
    runner: runner ?? { run: async () => ({ ok: true, output: "fine", tokens: 12 }) },
    intervalMs: 15000,
    now: () => clock.at,
    setInterval: (callback, ms) => {
      Object.assign(timer, { callback, ms });
      return { id: 1 };
    },
    clearInterval: () => {
      timer.cleared = true;
    },
    log: { log: (line) => logs.push(["log", line]), warn: (line) => logs.push(["warn", line]) },
  });
  return { clock, scheduler, timer, logs, ticker };
}

async function enabled(scheduler, conversationId, intervalSeconds = 15) {
  const schedule = await scheduler.createSchedule({ conversationId, steps: [{ kind: "prompt", text: "go" }], intervalSeconds });
  return scheduler.updateSchedule(schedule.id, { enabled: true });
}

test("start() arms one interval at SCHEDULER_TICK_MS, and stop() clears it", async () => {
  const { ticker, timer } = world();
  ticker.start();
  ticker.start();
  assert.equal(timer.ms, 15000);
  assert.equal(typeof timer.callback, "function");
  assert.equal(ticker.running, true);
  await ticker.stop();
  assert.equal(timer.cleared, true);
  assert.equal(ticker.running, false);
});

test("a tick claims due runs with the injected clock, runs each, and finishes it", async () => {
  const seen = [];
  const { ticker, scheduler, clock } = world({
    runner: {
      run: async ({ run, schedule }) => {
        seen.push({ runId: run.id, conversationId: schedule.conversationId });
        return { ok: true, output: `reply for ${schedule.conversationId}`, tokens: 30 };
      },
    },
  });
  const a = await enabled(scheduler, "conv-a");
  await enabled(scheduler, "conv-b", 60);
  await scheduler.createSchedule({ conversationId: "conv-off", steps: [{ kind: "prompt", text: "never" }] });

  assert.deepEqual(await ticker.tick(), { claimed: 2 });
  assert.deepEqual(seen.map((each) => each.conversationId).sort(), ["conv-a", "conv-b"]);
  assert.deepEqual(scheduler.calls.find((call) => call.name === "claimDueRuns").args, { now: T0, graceMs: CLAIM_GRACE_MS });

  const finished = scheduler.calls.filter((call) => call.name === "finishRun").map((call) => call.args);
  assert.equal(finished.length, 2);
  for (const args of finished) {
    assert.equal(args.ok, true);
    assert.equal(args.tokens, 30);
    assert.match(args.output, /^reply for conv-/);
  }

  // 15 s later only the 15 s schedule is due again; the disabled one never is.
  clock.at = T0 + 15000;
  assert.deepEqual(await ticker.tick(), { claimed: 1 });
  assert.equal(seen.at(-1).conversationId, "conv-a");
  assert.equal(scheduler.runs.filter((run) => run.scheduleId === a.id).length, 2);
  assert.ok(scheduler.runs.every((run) => run.status === "ok"));
});

test("a 15 s schedule on a 15 s tick runs every tick, even when the claim ran a few ms late", async () => {
  const { ticker, scheduler, clock } = world();
  const schedule = await enabled(scheduler, "conv-a");
  // Claimed 8 ms after the tick fired (a slow first request, a late timer)...
  clock.at = T0 + 8;
  await ticker.tick();
  // ...so its next run is due 8 ms after the next tick. It is still claimed on it.
  clock.at = T0 + 15000;
  assert.deepEqual(await ticker.tick(), { claimed: 1 });
  clock.at = T0 + 30000;
  assert.deepEqual(await ticker.tick(), { claimed: 1 });
  assert.equal(scheduler.runs.filter((run) => run.scheduleId === schedule.id).length, 3);
  // But nothing is claimed a whole tick early.
  clock.at = T0 + 30000 + 15000 - CLAIM_GRACE_MS - 100;
  assert.deepEqual(await ticker.tick(), { claimed: 0 });
});

test("the interval callback drives ticks: fired from the fake timer, it claims and finishes", async () => {
  const { ticker, scheduler, timer } = world();
  await enabled(scheduler, "conv-a");
  ticker.start();
  timer.callback();
  // The callback does not return its promise; let it settle.
  await new Promise((resolve) => setImmediate(resolve));
  await ticker.stop();
  assert.deepEqual(scheduler.runs.map((run) => run.status), ["ok"]);
});

test("a run that throws is finished as ok:false, and the ticker keeps ticking", async () => {
  let calls = 0;
  const { ticker, scheduler, clock, logs } = world({
    runner: {
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error("model exploded");
        return { ok: true, output: "recovered" };
      },
    },
  });
  await enabled(scheduler, "conv-a");

  assert.deepEqual(await ticker.tick(), { claimed: 1 });
  const failed = scheduler.calls.filter((call) => call.name === "finishRun")[0].args;
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "model exploded");
  assert.ok(logs.some(([level, line]) => level === "warn" && /model exploded/.test(line)));

  clock.at = T0 + 15000;
  assert.deepEqual(await ticker.tick(), { claimed: 1 });
  assert.deepEqual(scheduler.runs.map((run) => run.status), ["error", "ok"]);
});

test("a runner that reports failure without throwing is finished as ok:false too", async () => {
  const { ticker, scheduler } = world({ runner: { run: async () => ({ ok: false, error: "no prompt" }) } });
  await enabled(scheduler, "conv-a");
  await ticker.tick();
  const args = scheduler.calls.find((call) => call.name === "finishRun").args;
  assert.deepEqual([args.ok, args.error], [false, "no prompt"]);
});

test("scheduler down: the tick is skipped, logged once, and resumes when it is back", async () => {
  let ran = 0;
  const { ticker, scheduler, clock, logs } = world({ runner: { run: async () => ((ran += 1), { ok: true }) } });
  await enabled(scheduler, "conv-a");
  scheduler.down = true;

  assert.deepEqual(await ticker.tick(), { skipped: "down" });
  clock.at += 15000;
  assert.deepEqual(await ticker.tick(), { skipped: "down" });
  clock.at += 15000;
  assert.deepEqual(await ticker.tick(), { skipped: "down" });
  assert.equal(ran, 0);
  assert.equal(logs.filter(([level]) => level === "warn").length, 1, "one warning for the whole outage");
  assert.match(logs[0][1], /ECONNREFUSED/);

  scheduler.down = false;
  assert.deepEqual(await ticker.tick(), { claimed: 1 });
  assert.equal(ran, 1);
  assert.ok(logs.some(([level, line]) => level === "log" && /reachable again/.test(line)));
});

test("the first tick that reaches the scheduler releases runs a previous start left open", async () => {
  const { ticker, scheduler } = world();
  const schedule = await enabled(scheduler, "conv-a");
  scheduler.runs.push({ id: 99, scheduleId: schedule.id, status: "running", claimedAt: T0 - 1000 });

  assert.deepEqual(await ticker.tick(), { claimed: 1 });
  assert.equal(scheduler.runs.find((run) => run.id === 99).status, "error");
  // Only once per process.
  await ticker.tick();
  assert.equal(scheduler.calls.filter((call) => call.name === "releaseRuns").length, 1);
});

test("an orphaned schedule (its chat is gone) is deleted after its run", async () => {
  const { ticker, scheduler } = world({ runner: { run: async () => ({ ok: false, orphan: true, error: "gone" }) } });
  const schedule = await enabled(scheduler, "conv-gone");
  await ticker.tick();
  assert.equal(scheduler.schedules.has(schedule.id), false);
});

test("overlapping ticks do not claim twice; runs do not block the next claim", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const runner = {
    run: async ({ schedule }) => {
      if (schedule.conversationId === "slow") await gate;
      return { ok: true };
    },
  };
  const { ticker, scheduler, clock } = world({ runner });
  await enabled(scheduler, "slow");
  const first = ticker.tick();
  // The slow run is still going. The next tick claims the new schedule without
  // waiting for it — and does not claim the slow one again, though it is due.
  await new Promise((resolve) => setImmediate(resolve));
  clock.at += 15000;
  await enabled(scheduler, "fast");
  assert.deepEqual(await ticker.tick(), { claimed: 1 });
  release();
  assert.deepEqual(await first, { claimed: 1 });
});
