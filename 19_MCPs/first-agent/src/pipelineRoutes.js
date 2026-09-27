import crypto from "node:crypto";

import express from "express";

import { DEFAULT_AGENT, agentOf, isScheduledAgent, isValidAgent } from "./agents.js";
import { SchedulerToolError, SchedulerUnavailableError } from "./scheduler/client.js";
import { isValidSessionId } from "./store/conversationStore.js";

/**
 * **A pipeline agent's chats: the pipeline behind each one, and the rules that
 * make the chat a read-only feed.**
 *
 * The pipeline is the chat's schedule on the scheduler server — its steps, its
 * mode ("once" or "interval"), its interval and switch. Every route here calls
 * the scheduler's tools from code; no model is involved. And a few routes the
 * main server owns are guarded here first, because a pipeline chat is not a
 * conversation:
 *
 *   - `POST /conversations` creates a chat, and for a scheduled agent its
 *     schedule (mode "once", no steps yet);
 *   - `DELETE /conversations/:id` takes the schedule with it — runs, records
 *     and all;
 *   - `POST /chat` and `POST /conversations/:id/fork` answer 400 with a
 *     reason: nobody types into a feed, and a fork of one would be a
 *     conversation that can never be continued.
 *
 * Anything that is not a scheduled chat falls through to the next handler.
 */

export const MIN_INTERVAL_SECONDS = 15;
export const MAX_INTERVAL_SECONDS = 7 * 24 * 3600;
export const DEFAULT_INTERVAL_SECONDS = 60;
export const MAX_STEPS = 20;
const MODES = ["once", "interval"];
const MAX_RUNS = 50;

export const READ_ONLY_REASON =
  "This chat belongs to a pipeline agent: it is a read-only feed of its runs. " +
  "Build its steps and press Run in the Pipeline panel instead.";

/**
 * @param {{
 *   store: import("./store/conversationStore.js").ConversationStore,
 *   scheduler: import("./scheduler/client.js").SchedulerClient,
 *   servers?: string[],
 *   kick?: () => unknown,
 *   invalidate?: (conversationId: string) => void,
 *   now?: () => number,
 * }} deps - `servers` are the MCP server ids a tool step may name (omitted:
 *   any; the scheduler checks the rest). `kick` asks the ticker for a tick
 *   right away, so Run does not wait up to 15 s for the next one.
 */
export function pipelineRoutes({ store, scheduler, servers, kick = () => {}, invalidate = () => {}, now = Date.now }) {
  const router = express.Router();

  /** The record, if `id` is a scheduled chat; otherwise null. */
  async function scheduledRecord(id) {
    if (!isValidSessionId(id)) return null;
    const record = await store.load(id);
    return record && isScheduledAgent(record.agentId) ? record : null;
  }

  /**
   * The chat's schedule, created if it has none. A chat made while the
   * scheduler was down, or one whose schedule was lost with the database,
   * heals the first time its panel is opened.
   */
  async function ensureSchedule(conversationId) {
    return (
      (await scheduler.getSchedule(conversationId)) ??
      (await scheduler.createSchedule({ conversationId, mode: "once", steps: [], intervalSeconds: DEFAULT_INTERVAL_SECONDS, enabled: false }))
    );
  }

  /** `/conversations/:id/pipeline…` on something that is not a pipeline chat. */
  async function requireScheduled(req, res) {
    const { id } = req.params;
    if (!isValidSessionId(id)) {
      res.status(400).json({ error: "Not a valid conversation id." });
      return null;
    }
    const record = await scheduledRecord(id);
    if (!record) res.status(404).json({ error: "No pipeline chat with that id." });
    return record;
  }

  const route = (handler) => async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      fail(res, err, `${req.method} ${req.path}`);
    }
  };

  // ---- the chat itself -----------------------------------------------------

  router.post(
    "/conversations",
    route(async (req, res) => {
      const wanted = req.body?.agent;
      if (wanted !== undefined && !isValidAgent(wanted)) {
        return res.status(400).json({ error: "'agent' must be one this server knows." });
      }
      const agentId = agentOf(wanted ?? DEFAULT_AGENT);
      const id = crypto.randomUUID();
      const saved = await store.save(id, [], undefined, { agentId });

      let schedule = null;
      if (isScheduledAgent(agentId)) {
        try {
          schedule = await ensureSchedule(id);
        } catch (err) {
          // The chat exists either way; its schedule is created the first time
          // the panel can reach the scheduler.
          console.warn(`[POST /conversations] no schedule yet for ${id}: ${err?.message ?? err}`);
        }
      }
      res.status(201).json({ id, title: saved.title, agentId, updatedAt: saved.updatedAt, schedule });
    })
  );

  router.delete(
    "/conversations/:id",
    route(async (req, res, next) => {
      const record = await scheduledRecord(req.params.id);
      if (!record) return next();

      // The schedule first: a chat deleted with its schedule left behind would
      // keep a task running against nothing. If the scheduler is down, the chat
      // still goes, and the ticker deletes the orphan on its next run.
      let scheduleDeleted = false;
      try {
        const schedule = await scheduler.getSchedule(record.id);
        if (schedule) await scheduler.deleteSchedule(schedule.id);
        scheduleDeleted = true;
      } catch (err) {
        console.warn(`[DELETE /conversations/:id] schedule not deleted: ${err?.message ?? err}`);
      }
      await store.clear(record.id);
      invalidate(record.id);
      res.json({ ok: true, scheduleDeleted });
    })
  );

  router.post(
    "/chat",
    route(async (req, res, next) => {
      const { sessionId, agent } = req.body ?? {};
      const record = isValidSessionId(sessionId) ? await store.load(sessionId) : null;
      const agentId = record ? record.agentId : agent;
      if (isScheduledAgent(agentId)) return res.status(400).json({ error: READ_ONLY_REASON });
      next();
    })
  );

  router.post(
    "/conversations/:id/fork",
    route(async (req, res, next) => {
      if (await scheduledRecord(req.params.id)) {
        return res.status(400).json({ error: "A pipeline chat cannot be forked: it is a feed of runs, not a conversation." });
      }
      next();
    })
  );

  // ---- the pipeline --------------------------------------------------------

  router.get(
    "/conversations/:id/pipeline",
    route(async (req, res) => {
      const record = await requireScheduled(req, res);
      if (!record) return;
      const schedule = await ensureSchedule(record.id);
      res.json({ pipeline: pipelineOf(schedule), now: new Date(now()).toISOString() });
    })
  );

  router.put(
    "/conversations/:id/pipeline",
    route(async (req, res) => {
      const record = await requireScheduled(req, res);
      if (!record) return;
      const changes = pipelineChanges(req.body, { servers });
      if (changes.error) return res.status(400).json({ error: changes.error });

      const current = await ensureSchedule(record.id);
      const next = { ...pipelineOf(current), ...changes.value };
      if (next.mode === "interval" && next.enabled && !next.steps.length) {
        return res.status(400).json({ error: "Add a step before enabling the pipeline: a run with nothing to do has nothing to post." });
      }

      let schedule;
      try {
        schedule = await scheduler.updateSchedule(current.id, changes.value);
      } catch (err) {
        // The scheduler is the one that knows every step rule; what it says
        // is the answer to show beside the Save button.
        if (err instanceof SchedulerToolError) return res.status(400).json({ error: err.message });
        throw err;
      }

      // A pipeline chat has no user message to be titled by, so it is named
      // after its steps. Re-read first: a run may have appended since.
      const latest = changes.value.steps?.length ? await store.load(record.id) : null;
      if (latest) {
        await store.save(latest.id, latest.messages, undefined, { title: pipelineTitle(schedule.steps) });
        invalidate(latest.id);
      }
      res.json({ pipeline: pipelineOf(schedule), now: new Date(now()).toISOString() });
    })
  );

  router.post(
    "/conversations/:id/pipeline/run",
    route(async (req, res) => {
      const record = await requireScheduled(req, res);
      if (!record) return;
      const current = await ensureSchedule(record.id);
      if (!current.steps?.length) return res.status(409).json({ error: "Add a step and save first." });
      const schedule = await scheduler.runNow(current.id);
      // Fire and forget: the run posts its own message, and a tick that is
      // already busy leaves the run pending for the next one.
      Promise.resolve()
        .then(kick)
        .catch((err) => console.warn(`[pipeline/run] tick failed: ${err?.message ?? err}`));
      res.json({ pipeline: pipelineOf(schedule), now: new Date(now()).toISOString() });
    })
  );

  router.get(
    "/conversations/:id/runs",
    route(async (req, res) => {
      const record = await requireScheduled(req, res);
      if (!record) return;
      const limit = req.query.limit === undefined ? 10 : Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RUNS) {
        return res.status(400).json({ error: `'limit' must be an integer between 1 and ${MAX_RUNS}.` });
      }
      const schedule = await ensureSchedule(record.id);
      res.json({ runs: await scheduler.listRuns(schedule.id, limit) });
    })
  );

  /** One run's steps, each with its exact resolved input and output. */
  router.get(
    "/conversations/:id/runs/:runId",
    route(async (req, res) => {
      const record = await requireScheduled(req, res);
      if (!record) return;
      const runId = Number(req.params.runId);
      if (!Number.isInteger(runId) || runId < 1) return res.status(400).json({ error: "Not a valid run id." });
      const schedule = await ensureSchedule(record.id);
      let found;
      try {
        found = await scheduler.getRun(runId);
      } catch (err) {
        if (err instanceof SchedulerToolError) return res.status(404).json({ error: `No run ${runId}.` });
        throw err;
      }
      // Another chat's run is not this chat's business.
      if (found.run.scheduleId !== schedule.id) return res.status(404).json({ error: `No run ${runId} in this chat.` });
      res.json(found);
    })
  );

  return router;
}

/** A schedule as the panel sees it: the pipeline, without the scheduler's bookkeeping. */
export function pipelineOf(schedule) {
  return {
    scheduleId: schedule.id,
    mode: schedule.mode ?? "interval",
    intervalSeconds: schedule.intervalSeconds,
    enabled: Boolean(schedule.enabled),
    steps: schedule.steps ?? [],
    nextRunAt: schedule.nextRunAt ?? null,
    runPending: Boolean(schedule.runPending),
  };
}

/** "search_movies → prompt → notion-create-pages". */
export function pipelineTitle(steps) {
  return steps.map((step) => (step.kind === "tool" ? step.tool : "prompt")).join(" → ");
}

/**
 * The body of a PUT, checked for shape. Absent means unchanged; present and
 * wrong is a 400 that names the field, never a silent clamp. What each step
 * must contain — and which templates it may use — is the scheduler's rule,
 * checked there; here a tool step is only checked to name a server this app
 * knows, which the scheduler cannot.
 *
 * @returns {{ value: { mode?: string, enabled?: boolean, intervalSeconds?: number, steps?: object[] } } | { error: string }}
 */
export function pipelineChanges(body, { servers } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Send a JSON object." };
  const value = {};
  if (body.mode !== undefined) {
    if (!MODES.includes(body.mode)) return { error: "'mode' must be \"once\" or \"interval\"." };
    value.mode = body.mode;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return { error: "'enabled' must be true or false." };
    value.enabled = body.enabled;
  }
  if (body.intervalSeconds !== undefined) {
    const n = body.intervalSeconds;
    if (!Number.isInteger(n) || n < MIN_INTERVAL_SECONDS || n > MAX_INTERVAL_SECONDS) {
      return { error: `'intervalSeconds' must be a whole number from ${MIN_INTERVAL_SECONDS} to ${MAX_INTERVAL_SECONDS}.` };
    }
    value.intervalSeconds = n;
  }
  if (body.steps !== undefined) {
    if (!Array.isArray(body.steps)) return { error: "'steps' must be an array." };
    if (body.steps.length > MAX_STEPS) return { error: `At most ${MAX_STEPS} steps.` };
    for (const [i, step] of body.steps.entries()) {
      if (step?.kind === "tool" && servers && !servers.includes(step.server)) {
        return { error: `Step ${i + 1}: there is no MCP server "${step.server}" (known: ${servers.join(", ")}).` };
      }
    }
    value.steps = body.steps;
  }
  if (!Object.keys(value).length) return { error: "Nothing to change: send mode, enabled, intervalSeconds and/or steps." };
  return { value };
}

function fail(res, err, where) {
  if (err instanceof SchedulerUnavailableError) {
    return res.status(503).json({ error: `${err.message}. Start scheduler_mcp_server (npm start, port 3002).` });
  }
  if (err instanceof SchedulerToolError) {
    return res.status(502).json({ error: `The scheduler refused: ${err.message}` });
  }
  console.error(`[${where}]`, err);
  res.status(500).json({ error: "Something went wrong with the pipeline." });
}
