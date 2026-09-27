import { SchedulerToolError, SchedulerUnavailableError } from "./client.js";

/**
 * **A scheduler server in a Map, for the tests.** Same methods and answers as
 * `SchedulerClient`, the same claim rules (enabled, due, not already running;
 * next run = now + interval), and a `down` switch that makes every call fail
 * the way an unreachable server does. Every call is logged in `calls`.
 */
export class FakeScheduler {
  down = false;
  calls = [];
  schedules = new Map();
  runs = [];
  records = [];
  #ids = { schedule: 0, run: 0 };

  constructor({ now = Date.now } = {}) {
    this.now = now;
  }

  #enter(name, args) {
    this.calls.push({ name, args });
    if (this.down) throw new SchedulerUnavailableError("Could not reach the scheduler at http://127.0.0.1:3002/mcp: fetch failed (ECONNREFUSED)");
  }

  #schedule(id) {
    const schedule = this.schedules.get(id);
    if (!schedule) throw new SchedulerToolError(`No schedule with id ${id}.`);
    return schedule;
  }

  #out(schedule) {
    return { ...schedule, nextRunAt: new Date(schedule.nextRunAt).toISOString() };
  }

  async createSchedule({ conversationId, prompt = "", intervalSeconds = 60, enabled = false }) {
    this.#enter("createSchedule", { conversationId, prompt, intervalSeconds, enabled });
    if ([...this.schedules.values()].some((s) => s.conversationId === conversationId)) {
      throw new SchedulerToolError(`Conversation ${conversationId} already has a schedule.`);
    }
    const schedule = { id: ++this.#ids.schedule, conversationId, prompt, intervalSeconds, enabled, nextRunAt: this.now() };
    this.schedules.set(schedule.id, schedule);
    return this.#out(schedule);
  }

  async getSchedule(conversationId) {
    this.#enter("getSchedule", { conversationId });
    const found = [...this.schedules.values()].find((s) => s.conversationId === conversationId);
    return found ? this.#out(found) : null;
  }

  async updateSchedule(scheduleId, changes) {
    this.#enter("updateSchedule", { scheduleId, ...changes });
    const schedule = this.#schedule(scheduleId);
    const wasEnabled = schedule.enabled;
    Object.assign(schedule, changes);
    if (schedule.enabled && !wasEnabled) schedule.nextRunAt = this.now();
    return this.#out(schedule);
  }

  async deleteSchedule(scheduleId) {
    this.#enter("deleteSchedule", { scheduleId });
    const deleted = this.schedules.delete(scheduleId);
    this.runs = this.runs.filter((run) => run.scheduleId !== scheduleId);
    this.records = this.records.filter((record) => record.scheduleId !== scheduleId);
    return { deleted, scheduleId };
  }

  async claimDueRuns({ now = this.now(), graceMs = 0 } = {}) {
    this.#enter("claimDueRuns", { now, graceMs });
    const claimed = [];
    for (const schedule of this.schedules.values()) {
      const busy = this.runs.some((run) => run.scheduleId === schedule.id && run.status === "running");
      if (!schedule.enabled || schedule.nextRunAt > now + graceMs || busy) continue;
      const run = { id: ++this.#ids.run, scheduleId: schedule.id, status: "running", claimedAt: now };
      this.runs.push(run);
      schedule.nextRunAt = now + schedule.intervalSeconds * 1000;
      claimed.push({ run: { ...run }, schedule: this.#out(schedule) });
    }
    return { claimed, released: 0 };
  }

  async finishRun({ runId, ok, output, error, tokens }) {
    this.#enter("finishRun", { runId, ok, output, error, tokens });
    const run = this.runs.find((each) => each.id === runId);
    if (!run) throw new SchedulerToolError(`No run with id ${runId}.`);
    Object.assign(run, { status: ok ? "ok" : "error", output, error, tokens, finishedAt: this.now() });
    return { ...run };
  }

  async listRuns(scheduleId, limit = 10) {
    this.#enter("listRuns", { scheduleId, limit });
    this.#schedule(scheduleId);
    return this.runs.filter((run) => run.scheduleId === scheduleId).reverse().slice(0, limit).map((run) => ({ ...run }));
  }

  async runNow(scheduleId) {
    this.#enter("runNow", { scheduleId });
    const schedule = this.#schedule(scheduleId);
    schedule.nextRunAt = this.now();
    return this.#out(schedule);
  }

  async releaseRuns() {
    this.#enter("releaseRuns", {});
    let released = 0;
    for (const run of this.runs) {
      if (run.status === "running") {
        run.status = "error";
        released += 1;
      }
    }
    return { released };
  }

  async aggregate(scheduleId) {
    this.#enter("aggregate", { scheduleId });
    this.#schedule(scheduleId);
    const mine = this.records.filter((record) => record.scheduleId === scheduleId);
    return { invocations: mine.length, uniqueKeys: new Set(mine.map((record) => record.key)).size, mostRepeated: null, first: null, last: null };
  }
}
