import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { StepsError, validateSteps } from "./steps.js";

/**
 * **The only file that knows SQL.**
 *
 * Four tables: a schedule per conversation (its pipeline: steps, mode,
 * interval), a run per time one fired, the steps of each run with their exact
 * inputs and outputs, and the records a run chose to keep. Times are stored as
 * epoch milliseconds, which is
 * what makes "due" a plain `<=` and the interval a plain `+`; everything handed
 * out of here is an ISO string instead, because that is what a person (or a
 * model) can read.
 *
 * `better-sqlite3` is synchronous, and that is a feature here: a transaction is
 * a function call, so "pick the due schedules, insert their runs, push their
 * next run" cannot interleave with another claim in the same process — and
 * SQLite's write lock covers the case of two processes.
 */

export const DEFAULT_DB_PATH = path.join(import.meta.dirname, "..", "data", "scheduler.db");
/** A run still "running" after this long lost its runner; it may be claimed again. */
export const STALE_AFTER_MS = 5 * 60 * 1000;
export const MIN_INTERVAL_SECONDS = 15;
export const MAX_GRACE_MS = 60_000;
export const MODES = ["once", "interval"];

/**
 * `mode` "interval" runs every `intervalSeconds` while `enabled`; "once" runs
 * only when asked (`run_now`), and its `nextRunAt` is always null. `runNowAt`
 * is a pending `run_now`: set by the button, cleared by the claim that honours
 * it, whatever the mode and whether or not the schedule is enabled.
 */
const schedulesTable = (name) => `
  CREATE TABLE IF NOT EXISTS ${name} (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversationId  TEXT    NOT NULL UNIQUE,
    mode            TEXT    NOT NULL DEFAULT 'interval' CHECK (mode IN ('once', 'interval')),
    steps           TEXT    NOT NULL DEFAULT '[]',
    intervalSeconds INTEGER NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 0,
    nextRunAt       INTEGER,
    runNowAt        INTEGER,
    createdAt       INTEGER NOT NULL,
    updatedAt       INTEGER NOT NULL
  );
`;

const SCHEMA = `
  ${schedulesTable("schedules")}
  CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    scheduleId  INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    status      TEXT    NOT NULL CHECK (status IN ('running', 'ok', 'error')),
    claimedAt   INTEGER NOT NULL,
    finishedAt  INTEGER,
    output      TEXT,
    error       TEXT,
    tokens      INTEGER
  );
  CREATE INDEX IF NOT EXISTS runs_by_schedule ON runs (scheduleId, id);
  CREATE TABLE IF NOT EXISTS run_steps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    runId       INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    "index"     INTEGER NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('tool', 'prompt')),
    server      TEXT,
    tool        TEXT,
    input       TEXT,
    output      TEXT,
    toolCalls   TEXT,
    status      TEXT    NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
    error       TEXT,
    ms          INTEGER,
    tokens      INTEGER,
    UNIQUE (runId, "index")
  );
  CREATE TABLE IF NOT EXISTS records (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    scheduleId  INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    key         TEXT    NOT NULL,
    label       TEXT    NOT NULL,
    data        TEXT,
    createdAt   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS records_by_schedule ON records (scheduleId, key);
`;

/** A readable error for the tool result, as opposed to a crash. */
export class SchedulerError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchedulerError";
  }
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const toJson = (value) => (value === undefined ? null : JSON.stringify(value));
const fromJson = (text) => (text == null ? null : JSON.parse(text));

function scheduleOut(row) {
  return row
    ? {
        id: row.id,
        conversationId: row.conversationId,
        mode: row.mode,
        steps: fromJson(row.steps) ?? [],
        intervalSeconds: row.intervalSeconds,
        enabled: Boolean(row.enabled),
        nextRunAt: iso(row.nextRunAt),
        runPending: row.runNowAt != null,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      }
    : null;
}

function stepOut(row) {
  return {
    index: row.index,
    kind: row.kind,
    ...(row.server != null ? { server: row.server, tool: row.tool } : {}),
    input: fromJson(row.input),
    output: fromJson(row.output),
    ...(row.toolCalls != null ? { toolCalls: fromJson(row.toolCalls) } : {}),
    status: row.status,
    error: row.error,
    ms: row.ms,
    tokens: row.tokens,
  };
}

function runOut(row) {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    status: row.status,
    claimedAt: iso(row.claimedAt),
    finishedAt: iso(row.finishedAt),
    durationMs: row.finishedAt == null ? null : row.finishedAt - row.claimedAt,
    output: row.output,
    error: row.error,
    tokens: row.tokens,
  };
}

/** A caller's `now`: epoch ms or an ISO string, or the injected clock. */
function msOf(value, clock) {
  if (value === undefined || value === null) return clock();
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new SchedulerError(`"${value}" is not a time.`);
  return ms;
}

/**
 * Day 18 kept one `prompt` per schedule, and `nextRunAt` could not be null.
 * Such a database is rebuilt in place, once: the prompt becomes one prompt
 * step (with the tools it always had), the mode "interval". An empty prompt
 * becomes no steps — a step with no text would not validate.
 *
 * Foreign keys go off for the swap, or dropping the old table would cascade
 * every run with it.
 *
 * @returns {number} How many schedules were migrated (0: nothing to do).
 */
function migrate(db) {
  const columns = db.prepare("PRAGMA table_info(schedules)").all().map((column) => column.name);
  if (!columns.length || !columns.includes("prompt")) return 0;

  db.pragma("foreign_keys = OFF");
  try {
    return db.transaction(() => {
      db.exec(schedulesTable("schedules_new"));
      const rows = db.prepare("SELECT * FROM schedules").all();
      const insert = db.prepare(
        `INSERT INTO schedules_new (id, conversationId, mode, steps, intervalSeconds, enabled, nextRunAt, runNowAt, createdAt, updatedAt)
         VALUES (@id, @conversationId, 'interval', @steps, @intervalSeconds, @enabled, @nextRunAt, NULL, @createdAt, @updatedAt)`
      );
      for (const row of rows) {
        const prompt = String(row.prompt ?? "");
        const steps = prompt.trim() ? [{ kind: "prompt", text: prompt, allowTools: true }] : [];
        insert.run({ ...row, steps: JSON.stringify(steps) });
      }
      db.exec("DROP TABLE schedules; ALTER TABLE schedules_new RENAME TO schedules;");
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length) throw new Error(`Migration left ${broken.length} dangling reference(s).`);
      return rows.length;
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/** Steps as the tools hand them in, checked; a bad list is a readable error. */
function checkedSteps(steps) {
  try {
    return validateSteps(steps);
  } catch (err) {
    if (err instanceof StepsError) throw new SchedulerError(err.message);
    throw err;
  }
}

function checkMode(mode) {
  if (!MODES.includes(mode)) throw new SchedulerError(`mode must be "once" or "interval".`);
}

/**
 * Open (or create) the database and hand back the operations on it.
 *
 * @param {{ file?: string, now?: () => number }} [options] - `now` is the
 *   clock every default time is read from, which is how the tests move time.
 */
export function openScheduler({ file = DEFAULT_DB_PATH, now = Date.now } = {}) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const migrated = migrate(db);
  db.exec(SCHEMA);

  const q = {
    insertSchedule: db.prepare(
      `INSERT INTO schedules (conversationId, mode, steps, intervalSeconds, enabled, nextRunAt, createdAt, updatedAt)
       VALUES (@conversationId, @mode, @steps, @intervalSeconds, @enabled, @nextRunAt, @now, @now)`
    ),
    scheduleById: db.prepare("SELECT * FROM schedules WHERE id = ?"),
    scheduleByConversation: db.prepare("SELECT * FROM schedules WHERE conversationId = ?"),
    allSchedules: db.prepare("SELECT * FROM schedules ORDER BY id"),
    updateSchedule: db.prepare(
      `UPDATE schedules SET mode = @mode, steps = @steps, intervalSeconds = @intervalSeconds, enabled = @enabled,
         nextRunAt = @nextRunAt, updatedAt = @now WHERE id = @id`
    ),
    deleteSchedule: db.prepare("DELETE FROM schedules WHERE id = ?"),
    releaseStale: db.prepare(
      `UPDATE runs SET status = 'error', finishedAt = @now,
         error = 'Abandoned: still running after ' || @staleMinutes || ' minutes, so it was released.'
       WHERE status = 'running' AND claimedAt <= @cutoff`
    ),
    releaseAll: db.prepare(
      `UPDATE runs SET status = 'error', finishedAt = @now, error = @reason WHERE status = 'running'`
    ),
    // Due on the clock (interval mode, enabled), or asked for by run_now in
    // any mode — and in either case not already running.
    due: db.prepare(
      `SELECT s.* FROM schedules s
       WHERE ((s.mode = 'interval' AND s.enabled = 1 AND s.nextRunAt <= @due) OR s.runNowAt IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.scheduleId = s.id AND r.status = 'running')
       ORDER BY COALESCE(s.runNowAt, s.nextRunAt), s.id`
    ),
    insertRun: db.prepare(`INSERT INTO runs (scheduleId, status, claimedAt) VALUES (?, 'running', ?)`),
    pushNextRun: db.prepare("UPDATE schedules SET nextRunAt = @nextRunAt, runNowAt = NULL WHERE id = @id"),
    runById: db.prepare("SELECT * FROM runs WHERE id = ?"),
    finishRun: db.prepare(
      `UPDATE runs SET status = @status, finishedAt = @now, output = @output, error = @error, tokens = @tokens
       WHERE id = @id AND status = 'running'`
    ),
    insertStep: db.prepare(
      `INSERT INTO run_steps (runId, "index", kind, server, tool, input, output, toolCalls, status, error, ms, tokens)
       VALUES (@runId, @index, @kind, @server, @tool, @input, @output, @toolCalls, @status, @error, @ms, @tokens)`
    ),
    stepsOfRun: db.prepare(`SELECT * FROM run_steps WHERE runId = ? ORDER BY "index"`),
    listRuns: db.prepare("SELECT * FROM runs WHERE scheduleId = ? ORDER BY id DESC LIMIT ?"),
    runNow: db.prepare("UPDATE schedules SET runNowAt = @now, updatedAt = @now WHERE id = @id"),
    insertRecord: db.prepare(
      `INSERT INTO records (scheduleId, key, label, data, createdAt) VALUES (@scheduleId, @key, @label, @data, @now)`
    ),
    counts: db.prepare(
      "SELECT COUNT(*) AS invocations, COUNT(DISTINCT key) AS uniqueKeys FROM records WHERE scheduleId = ?"
    ),
    // The most recorded key; a tie goes to the one recorded most recently, and
    // its label is the latest one written for it.
    mostRepeated: db.prepare(
      `WITH byKey AS (
         SELECT key, COUNT(*) AS count, MAX(id) AS lastId FROM records WHERE scheduleId = ? GROUP BY key
       )
       SELECT byKey.count, records.label FROM byKey JOIN records ON records.id = byKey.lastId
       ORDER BY byKey.count DESC, byKey.lastId DESC LIMIT 1`
    ),
    first: db.prepare("SELECT label, createdAt FROM records WHERE scheduleId = ? ORDER BY createdAt, id LIMIT 1"),
    last: db.prepare("SELECT label, createdAt FROM records WHERE scheduleId = ? ORDER BY createdAt DESC, id DESC LIMIT 1"),
  };

  function requireSchedule(id) {
    const row = q.scheduleById.get(id);
    if (!row) throw new SchedulerError(`No schedule with id ${id}.`);
    return row;
  }

  function checkInterval(seconds) {
    if (!Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS) {
      throw new SchedulerError(`intervalSeconds must be a whole number of at least ${MIN_INTERVAL_SECONDS}.`);
    }
  }

  const claim = db.transaction((at, graceMs) => {
    // A run that has been "running" for five minutes lost its runner — a crash,
    // a restart, a hung call. Closing it here is what lets its schedule be
    // claimed again below, in the same transaction.
    const released = q.releaseStale.run({ now: at, cutoff: at - STALE_AFTER_MS, staleMinutes: STALE_AFTER_MS / 60000 }).changes;
    const claimed = [];
    for (const row of q.due.all({ due: at + graceMs })) {
      const runId = Number(q.insertRun.run(row.id, at).lastInsertRowid);
      // An interval schedule that is on counts its next run from this claim;
      // a "once" schedule has none; one that is off keeps what it had.
      const nextRunAt = row.mode === "once" ? null : row.enabled ? at + row.intervalSeconds * 1000 : row.nextRunAt;
      q.pushNextRun.run({ id: row.id, nextRunAt });
      claimed.push({ run: runOut(q.runById.get(runId)), schedule: scheduleOut({ ...row, nextRunAt, runNowAt: null }) });
    }
    return { claimed, released };
  });

  /**
   * The run's row and its step rows, in one transaction: a reader sees a
   * finished run with all of its steps, or a running one with none.
   */
  const finish = db.transaction((runId, fields, steps) => {
    if (q.finishRun.run({ id: runId, ...fields }).changes !== 1) {
      throw new SchedulerError(`Run ${runId} is already finished.`);
    }
    for (const step of steps) {
      q.insertStep.run({
        runId,
        index: step.index,
        kind: step.kind,
        server: step.server ?? null,
        tool: step.tool ?? null,
        input: toJson(step.input),
        output: toJson(step.output),
        toolCalls: step.toolCalls?.length ? JSON.stringify(step.toolCalls) : null,
        status: step.status,
        error: step.error ?? null,
        ms: step.ms ?? null,
        tokens: step.tokens ?? null,
      });
    }
  });

  return {
    /** The file it is backed by, for the start-up line. */
    file,
    /** How many Day 18 schedules this open migrated to steps (0 almost always). */
    migrated,

    createSchedule({ conversationId, mode = "interval", steps = [], intervalSeconds = 60, enabled = false }) {
      checkMode(mode);
      checkInterval(intervalSeconds);
      const clean = checkedSteps(steps);
      if (q.scheduleByConversation.get(conversationId)) {
        throw new SchedulerError(`Conversation ${conversationId} already has a schedule.`);
      }
      const at = now();
      const id = Number(
        q.insertSchedule.run({
          conversationId,
          mode,
          steps: JSON.stringify(clean),
          intervalSeconds,
          enabled: enabled ? 1 : 0,
          nextRunAt: mode === "interval" ? at : null,
          now: at,
        }).lastInsertRowid
      );
      return scheduleOut(q.scheduleById.get(id));
    },

    /** @returns {object | null} */
    getSchedule({ conversationId }) {
      return scheduleOut(q.scheduleByConversation.get(conversationId));
    },

    /**
     * Change any of mode, steps, interval and enabled. Switching an interval
     * schedule on (or switching an enabled one to interval) makes it due now —
     * nobody enables a task to wait a full interval for the first result — and
     * shortening the interval pulls the next run in. "once" has no next run.
     */
    updateSchedule({ scheduleId, mode, steps, intervalSeconds, enabled }) {
      const row = requireSchedule(scheduleId);
      if (mode !== undefined) checkMode(mode);
      if (intervalSeconds !== undefined) checkInterval(intervalSeconds);
      const at = now();
      const next = {
        id: row.id,
        mode: mode ?? row.mode,
        steps: steps === undefined ? row.steps : JSON.stringify(checkedSteps(steps)),
        intervalSeconds: intervalSeconds ?? row.intervalSeconds,
        enabled: enabled === undefined ? row.enabled : enabled ? 1 : 0,
        nextRunAt: row.nextRunAt,
        now: at,
      };
      const wasTicking = row.mode === "interval" && row.enabled;
      if (next.mode === "once") next.nextRunAt = null;
      else if (next.enabled && !wasTicking) next.nextRunAt = at;
      else if (row.nextRunAt == null) next.nextRunAt = at;
      else next.nextRunAt = Math.min(row.nextRunAt, at + next.intervalSeconds * 1000);
      q.updateSchedule.run(next);
      return scheduleOut(q.scheduleById.get(row.id));
    },

    /** Runs and records go with it (ON DELETE CASCADE). */
    deleteSchedule({ scheduleId }) {
      const deleted = q.deleteSchedule.run(scheduleId).changes > 0;
      return { deleted, scheduleId };
    },

    listSchedules() {
      return q.allSchedules.all().map(scheduleOut);
    },

    /**
     * **The one place a run starts.** Every enabled schedule that is due and is
     * not already running gets a run row and its next time, in one transaction:
     * two tickers asking at once get disjoint answers.
     *
     * `graceMs` (default 0) widens only "is it due": a schedule due within
     * that much of `now` is claimed now. The next run is still measured from
     * the real claim time. A ticker whose period equals the interval needs a
     * little of it — its ticks are a few milliseconds early or late relative
     * to the last claim, and without slack "a few ms early" skips a whole tick.
     */
    claimDueRuns({ now: when, graceMs = 0 } = {}) {
      if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > MAX_GRACE_MS) {
        throw new SchedulerError(`graceMs must be between 0 and ${MAX_GRACE_MS}.`);
      }
      return claim(msOf(when, now), graceMs);
    },

    /**
     * Close a run, with the steps it took. The run and its steps are written
     * together or not at all: a step list the table refuses (two steps with
     * one index, say) leaves the run open and nothing stored.
     */
    finishRun({ runId, ok, output = null, error = null, tokens = null, steps = [] }) {
      const run = q.runById.get(runId);
      if (!run) throw new SchedulerError(`No run with id ${runId}.`);
      if (run.status !== "running") {
        throw new SchedulerError(`Run ${runId} is already finished (${run.status}${run.error ? `: ${run.error}` : ""}).`);
      }
      try {
        finish(runId, { status: ok ? "ok" : "error", now: now(), output, error, tokens }, steps);
      } catch (err) {
        if (err instanceof SchedulerError) throw err;
        throw new SchedulerError(`The run and its steps were not stored: ${err.message}`);
      }
      return runOut(q.runById.get(runId));
    },

    /** One run with every step it took, in order. */
    getRun({ runId }) {
      const run = q.runById.get(runId);
      if (!run) throw new SchedulerError(`No run with id ${runId}.`);
      return { run: runOut(run), steps: q.stepsOfRun.all(runId).map(stepOut) };
    },

    listRuns({ scheduleId, limit = 10 }) {
      requireSchedule(scheduleId);
      return q.listRuns.all(scheduleId, limit).map(runOut);
    },

    /**
     * A run is wanted: the next claim takes it, whatever the mode and whether
     * or not the schedule is enabled — the button is an explicit ask.
     */
    runNow({ scheduleId }) {
      requireSchedule(scheduleId);
      q.runNow.run({ id: scheduleId, now: now() });
      return scheduleOut(q.scheduleById.get(scheduleId));
    },

    /**
     * Close every run still marked running. For an app that has just started:
     * whatever it was running before it stopped is not coming back, and
     * waiting out the five-minute stale window would pause those schedules.
     */
    releaseRuns({ reason = "Abandoned: the app restarted while this run was in flight." } = {}) {
      return { released: q.releaseAll.run({ now: now(), reason }).changes };
    },

    record({ scheduleId, key, label, data }) {
      requireSchedule(scheduleId);
      const at = now();
      const id = Number(
        q.insertRecord.run({ scheduleId, key, label, data: data === undefined ? null : JSON.stringify(data), now: at }).lastInsertRowid
      );
      return { id, scheduleId, key, label, createdAt: iso(at) };
    },

    /** Numbers about the records, computed in SQL. No rows leave. */
    aggregate({ scheduleId }) {
      requireSchedule(scheduleId);
      const { invocations, uniqueKeys } = q.counts.get(scheduleId);
      const top = q.mostRepeated.get(scheduleId);
      const first = q.first.get(scheduleId);
      const last = q.last.get(scheduleId);
      return {
        invocations,
        uniqueKeys,
        mostRepeated: top ? { label: top.label, count: top.count } : null,
        first: first ? { label: first.label, at: iso(first.createdAt) } : null,
        last: last ? { label: last.label, at: iso(last.createdAt) } : null,
      };
    },

    close() {
      db.close();
    },
  };
}
