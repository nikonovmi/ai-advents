import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import pkg from "../package.json" with { type: "json" };
import { MAX_GRACE_MS, MIN_INTERVAL_SECONDS } from "./db.js";

/**
 * **The tools, and the one place they are registered.**
 *
 * Two audiences. Most tools are for the app's own code — the ticker and the
 * routes — and first-agent never offers them to a model. `record` and
 * `aggregate` are for the model: they are how a run keeps a result and reads
 * back what earlier runs kept. Both take a `scheduleId`, which the app strips
 * from the schema the model sees and fills in itself, so a run can only ever
 * write to its own schedule.
 *
 * Like the OMDb server: a handler returns data or throws, and `toolResult` is
 * the only place either becomes a `CallToolResult`. Nothing crashes the server.
 */

const scheduleId = z.number().int().positive().describe("The schedule's id.");
const conversationId = z.string().trim().min(1).max(200).describe("The first-agent conversation this schedule belongs to.");
const intervalSeconds = z.number().int().min(MIN_INTERVAL_SECONDS).max(7 * 24 * 3600).describe(`Seconds between runs, at least ${MIN_INTERVAL_SECONDS}.`);
const prompt = z.string().max(8000).describe("What every run is asked to do.");
const when = z.union([z.number(), z.string()]).optional().describe("Epoch milliseconds or an ISO time. Default: the server's clock.");

/** Data or an error, as MCP wants it back. `structuredContent` must be an object. */
export async function toolResult(run) {
  try {
    const data = await run();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
    };
  } catch (err) {
    return { content: [{ type: "text", text: readable(err) }], isError: true };
  }
}

function readable(err) {
  if (err instanceof z.ZodError) {
    return "Invalid input: " + err.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ` : "") + issue.message).join("; ");
  }
  return err?.message ?? String(err);
}

/**
 * A fresh server over the shared database. Stateless HTTP builds one per
 * request; the database handle is the only thing that lives longer.
 *
 * @param {{ scheduler: ReturnType<typeof import("./db.js").openScheduler> }} deps
 */
export function createServer({ scheduler }) {
  const server = new McpServer({ name: "scheduler-mcp", version: pkg.version });
  const app = { readOnlyHint: false, openWorldHint: false };

  /** One registration, wrapped so every handler ends up in `toolResult`. */
  const tool = (name, { title, description, input, annotations = app }, handler) =>
    server.registerTool(name, { title, description, inputSchema: input, annotations }, (args) => toolResult(() => handler(args)));

  // ---- for the app ---------------------------------------------------------

  tool(
    "create_schedule",
    {
      title: "Create a schedule",
      description: "App tool. Create the schedule for one conversation (one per conversation). Starts due now; runs only once enabled.",
      input: z.object({ conversationId, prompt: prompt.optional(), intervalSeconds: intervalSeconds.optional(), enabled: z.boolean().optional() }),
    },
    (args) => scheduler.createSchedule(args)
  );

  tool(
    "get_schedule",
    {
      title: "Get a schedule",
      description: "App tool. The schedule of one conversation, or { schedule: null }.",
      input: z.object({ conversationId }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => ({ schedule: scheduler.getSchedule(args) })
  );

  tool(
    "update_schedule",
    {
      title: "Update a schedule",
      description: "App tool. Change prompt, intervalSeconds and/or enabled. Enabling makes it due now.",
      input: z.object({ scheduleId, prompt: prompt.optional(), intervalSeconds: intervalSeconds.optional(), enabled: z.boolean().optional() }),
    },
    (args) => scheduler.updateSchedule(args)
  );

  tool(
    "delete_schedule",
    {
      title: "Delete a schedule",
      description: "App tool. Delete a schedule with all of its runs and records.",
      input: z.object({ scheduleId }),
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    (args) => scheduler.deleteSchedule(args)
  );

  tool(
    "list_schedules",
    {
      title: "List schedules",
      description: "App tool. Every schedule.",
      input: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => ({ schedules: scheduler.listSchedules() })
  );

  tool(
    "claim_due_runs",
    {
      title: "Claim due runs",
      description:
        "App tool, for the ticker. In one transaction: release runs stuck in 'running' for over 5 minutes, then for " +
        "every enabled schedule that is due (nextRunAt <= now + graceMs) and not running, insert a run and set " +
        "nextRunAt = now + interval. Returns { claimed: [{ run, schedule }], released }.",
      input: z.object({
        now: when,
        graceMs: z.number().int().min(0).max(MAX_GRACE_MS).optional().describe("Also claim schedules due this soon. Default 0."),
      }),
    },
    (args) => scheduler.claimDueRuns(args)
  );

  tool(
    "finish_run",
    {
      title: "Finish a run",
      description: "App tool. Close a claimed run as ok or error, with its output, error and token count.",
      input: z.object({
        runId: z.number().int().positive(),
        ok: z.boolean(),
        output: z.string().max(20000).optional(),
        error: z.string().max(4000).optional(),
        tokens: z.number().int().min(0).optional(),
      }),
    },
    (args) => scheduler.finishRun(args)
  );

  tool(
    "list_runs",
    {
      title: "List runs",
      description: "App tool. A schedule's most recent runs, newest first.",
      input: z.object({ scheduleId, limit: z.number().int().min(1).max(200).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => ({ runs: scheduler.listRuns(args) })
  );

  tool(
    "run_now",
    {
      title: "Run now",
      description: "App tool. Make a schedule due now, so the next tick claims it (if it is enabled).",
      input: z.object({ scheduleId }),
    },
    (args) => scheduler.runNow(args)
  );

  tool(
    "release_runs",
    {
      title: "Release running runs",
      description: "App tool, for a ticker that just started: mark every run still 'running' as an error, so nothing waits out the stale window.",
      input: z.object({ reason: z.string().max(500).optional() }),
    },
    (args) => scheduler.releaseRuns(args)
  );

  // ---- for the model -------------------------------------------------------

  tool(
    "record",
    {
      title: "Record a result",
      description:
        "Store one result of this run so later runs can count it. `key` identifies the thing (e.g. an IMDb id) and " +
        "decides what counts as a repeat; `label` is how it reads (e.g. \"Inception (2010)\"); `data` is optional extra JSON.",
      input: z.object({
        scheduleId,
        key: z.string().trim().min(1).max(200),
        label: z.string().trim().min(1).max(300),
        data: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    (args) => scheduler.record(args)
  );

  tool(
    "aggregate",
    {
      title: "Aggregate the records",
      description:
        "Numbers about everything recorded so far, across all runs: { invocations, uniqueKeys, mostRepeated: " +
        "{ label, count }, first: { label, at }, last: { label, at } }. No raw rows.",
      input: z.object({ scheduleId }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => scheduler.aggregate(args)
  );

  return server;
}
