import { describeError } from "../mcp/mcpClient.js";

/**
 * **The clock that starts runs.** Plain code, no model.
 *
 * Every `intervalMs` it asks the scheduler for the runs that are due —
 * `claim_due_runs` picks and marks them in one transaction, so two tickers
 * never start the same run — then executes each through the runner and closes
 * it with `finish_run`. A run that throws is closed as an error; it never
 * stops the ticker. A scheduler that is down is logged once and the tick is
 * skipped, until it answers again.
 *
 * The claim is guarded against overlapping ticks; the runs are not held
 * behind it. A slow run keeps its own schedule busy (the server will not claim
 * a schedule with a run open) without delaying anybody else's.
 */

export const DEFAULT_TICK_MS = 15000;
/**
 * How close to due a schedule may be and still be claimed on this tick. A
 * schedule's next run is its claim time plus its interval, and its claim time
 * is a tick — so with a 15 s interval on a 15 s tick, the next run is due *on*
 * the next tick, give or take the few milliseconds a timer is early or late.
 * Without slack, "due 3 ms after the tick" waits a whole extra tick: every
 * 30 s instead of every 15. Running a moment early is the better mistake.
 */
export const CLAIM_GRACE_MS = 1000;

export class Ticker {
  #scheduler;
  #runner;
  #intervalMs;
  #now;
  #setInterval;
  #clearInterval;
  #log;
  #timer = null;
  #claiming = false;
  #down = false;
  /** Runs left "running" by a previous process are released once, on the first tick that reaches the server. */
  #released = false;
  /** Every run still executing, so `stop()` and the tests can wait for them. */
  #inFlight = new Set();

  /**
   * @param {{
   *   scheduler: Pick<import("./client.js").SchedulerClient, "claimDueRuns" | "finishRun" | "releaseRuns" | "deleteSchedule">,
   *   runner: { run: (claimed: { run: object, schedule: object }) => Promise<{ ok: boolean, output?: string, error?: string, tokens?: number, orphan?: boolean }> },
   *   intervalMs?: number,
   *   now?: () => number,
   *   setInterval?: typeof globalThis.setInterval,
   *   clearInterval?: typeof globalThis.clearInterval,
   *   log?: Pick<Console, "log" | "warn">,
   * }} deps
   */
  constructor({
    scheduler,
    runner,
    intervalMs = DEFAULT_TICK_MS,
    now = Date.now,
    setInterval = globalThis.setInterval,
    clearInterval = globalThis.clearInterval,
    log = console,
  }) {
    this.#scheduler = scheduler;
    this.#runner = runner;
    this.#intervalMs = intervalMs;
    this.#now = now;
    this.#setInterval = setInterval;
    this.#clearInterval = clearInterval;
    this.#log = log;
  }

  get running() {
    return this.#timer !== null;
  }

  start() {
    if (this.#timer) return;
    this.#timer = this.#setInterval(() => {
      this.tick().catch((err) => this.#log.warn(`[ticker] tick failed: ${describeError(err)}`));
    }, this.#intervalMs);
    this.#timer?.unref?.();
    this.#log.log(`[ticker] claiming due runs every ${this.#intervalMs / 1000} s`);
  }

  async stop() {
    if (this.#timer) this.#clearInterval(this.#timer);
    this.#timer = null;
    await Promise.allSettled([...this.#inFlight]);
  }

  /**
   * One tick: claim, then run everything claimed.
   *
   * @returns {Promise<{ skipped: "busy" | "down" } | { claimed: number }>}
   *   Resolves when every run this tick claimed has been finished.
   */
  async tick() {
    // Read the moment the tick fired, before anything is awaited.
    const at = this.#now();
    if (this.#claiming) return { skipped: "busy" };
    this.#claiming = true;
    let claimed;
    try {
      if (!this.#released) {
        const { released } = await this.#scheduler.releaseRuns();
        if (released) this.#log.log(`[ticker] released ${released} run(s) left open by a previous start`);
        this.#released = true;
      }
      ({ claimed = [] } = await this.#scheduler.claimDueRuns({ now: at, graceMs: CLAIM_GRACE_MS }));
      if (this.#down) this.#log.log("[ticker] the scheduler is reachable again");
      this.#down = false;
    } catch (err) {
      if (!this.#down) this.#log.warn(`[ticker] skipping ticks until the scheduler answers: ${describeError(err)}`);
      this.#down = true;
      return { skipped: "down" };
    } finally {
      this.#claiming = false;
    }

    await Promise.all(claimed.map((each) => this.#track(this.#execute(each))));
    return { claimed: claimed.length };
  }

  #track(promise) {
    this.#inFlight.add(promise);
    return promise.finally(() => this.#inFlight.delete(promise));
  }

  async #execute({ run, schedule }) {
    let outcome;
    try {
      outcome = await this.#runner.run({ run, schedule });
    } catch (err) {
      outcome = { ok: false, error: describeError(err) };
    }
    if (!outcome?.ok) this.#log.warn(`[ticker] run ${run.id} (schedule ${schedule.id}) failed: ${outcome?.error ?? "no reason given"}`);

    try {
      await this.#scheduler.finishRun({
        runId: run.id,
        ok: Boolean(outcome?.ok),
        output: outcome?.output,
        error: outcome?.ok ? undefined : (outcome?.error ?? "The run failed without saying why."),
        tokens: outcome?.tokens,
      });
    } catch (err) {
      // Left "running", it is released as stale in five minutes.
      this.#log.warn(`[ticker] could not finish run ${run.id}: ${describeError(err)}`);
    }

    if (outcome?.orphan) {
      try {
        await this.#scheduler.deleteSchedule(schedule.id);
        this.#log.log(`[ticker] deleted schedule ${schedule.id}: its conversation is gone`);
      } catch (err) {
        this.#log.warn(`[ticker] could not delete orphaned schedule ${schedule.id}: ${describeError(err)}`);
      }
    }
  }
}
