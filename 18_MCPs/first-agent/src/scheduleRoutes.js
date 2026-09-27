import crypto from "node:crypto";

import express from "express";

import { DEFAULT_AGENT, agentOf, isScheduledAgent, isValidAgent } from "./agents.js";
import { SchedulerToolError, SchedulerUnavailableError } from "./scheduler/client.js";
import { isValidSessionId } from "./store/conversationStore.js";

/**
 * **A scheduled agent's chats: the schedule behind each one, and the rules that
 * make the chat a read-only feed.**
 *
 * Every route here calls the scheduler's tools from code — no model is
 * involved. And a few routes the main server owns are guarded here first,
 * because a scheduled chat is not a conversation:
 *
 *   - `POST /conversations` creates a chat, and for a scheduled agent its
 *     schedule (disabled, every 60 s, no prompt yet);
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
export const MAX_PROMPT_CHARS = 8000;
export const DEFAULT_INTERVAL_SECONDS = 60;
const MAX_RUNS = 50;

export const READ_ONLY_REASON =
  "This chat belongs to a scheduled agent: it is a read-only feed of its runs. " +
  "Set its prompt and interval in the Schedule panel instead.";

/**
 * @param {{
 *   store: import("./store/conversationStore.js").ConversationStore,
 *   scheduler: import("./scheduler/client.js").SchedulerClient,
 *   invalidate?: (conversationId: string) => void,
 *   now?: () => number,
 * }} deps
 */
export function scheduleRoutes({ store, scheduler, invalidate = () => {}, now = Date.now }) {
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
      (await scheduler.createSchedule({ conversationId, prompt: "", intervalSeconds: DEFAULT_INTERVAL_SECONDS, enabled: false }))
    );
  }

  /** `/conversations/:id/schedule…` on something that is not a scheduled chat. */
  async function requireScheduled(req, res) {
    const { id } = req.params;
    if (!isValidSessionId(id)) {
      res.status(400).json({ error: "Not a valid conversation id." });
      return null;
    }
    const record = await scheduledRecord(id);
    if (!record) res.status(404).json({ error: "No scheduled chat with that id." });
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
        return res.status(400).json({ error: "A scheduled agent's chat cannot be forked: it is a feed of runs, not a conversation." });
      }
      next();
    })
  );

  // ---- the schedule --------------------------------------------------------

  router.get(
    "/conversations/:id/schedule",
    route(async (req, res) => {
      const record = await requireScheduled(req, res);
      if (!record) return;
      const schedule = await ensureSchedule(record.id);
      // The readout is a nicety: a failure here must not cost the panel.
      const aggregate = await scheduler.aggregate(schedule.id).catch(() => null);
      res.json({ schedule, aggregate, now: new Date(now()).toISOString() });
    })
  );

  router.put(
    "/conversations/:id/schedule",
    route(async (req, res) => {
      const record = await requireScheduled(req, res);
      if (!record) return;
      const changes = scheduleChanges(req.body);
      if (changes.error) return res.status(400).json({ error: changes.error });

      const current = await ensureSchedule(record.id);
      const prompt = changes.value.prompt ?? current.prompt;
      const enabled = changes.value.enabled ?? current.enabled;
      if (enabled && !prompt.trim()) {
        return res.status(400).json({ error: "Write a prompt before enabling the schedule: a run with nothing to do has nothing to post." });
      }

      const schedule = await scheduler.updateSchedule(current.id, changes.value);
      // A scheduled chat has no user message to be titled by, so it is named
      // after what it does.
      // Re-read first: a run may have appended a message since the load above.
      const latest = changes.value.prompt !== undefined && prompt.trim() ? await store.load(record.id) : null;
      if (latest) {
        await store.save(latest.id, latest.messages, undefined, { title: prompt });
        invalidate(latest.id);
      }
      res.json({ schedule, now: new Date(now()).toISOString() });
    })
  );

  router.post(
    "/conversations/:id/schedule/run-now",
    route(async (req, res) => {
      const record = await requireScheduled(req, res);
      if (!record) return;
      const current = await ensureSchedule(record.id);
      // The ticker only claims enabled schedules; saying "done" to a run that
      // will never happen would be a lie with a button on it.
      if (!current.enabled) {
        return res.status(409).json({ error: "The schedule is off. Enable it first — only enabled schedules are run." });
      }
      if (!current.prompt.trim()) return res.status(409).json({ error: "Write a prompt first." });
      const schedule = await scheduler.runNow(current.id);
      res.json({ schedule, now: new Date(now()).toISOString() });
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

  return router;
}

/**
 * The body of a PUT, checked field by field. Absent means unchanged; present
 * and wrong is a 400 that names the field, never a silent clamp.
 *
 * @returns {{ value: { enabled?: boolean, intervalSeconds?: number, prompt?: string } } | { error: string }}
 */
export function scheduleChanges(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Send a JSON object." };
  const value = {};
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
  if (body.prompt !== undefined) {
    if (typeof body.prompt !== "string") return { error: "'prompt' must be a string." };
    if (body.prompt.length > MAX_PROMPT_CHARS) return { error: `'prompt' must be at most ${MAX_PROMPT_CHARS} characters.` };
    value.prompt = body.prompt;
  }
  if (!Object.keys(value).length) return { error: "Nothing to change: send enabled, intervalSeconds and/or prompt." };
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
  res.status(500).json({ error: "Something went wrong with the schedule." });
}
