import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import pkg from "../package.json" with { type: "json" };
import { MAX_GRACE_MS, MIN_INTERVAL_SECONDS, MODES } from "./db.js";
import { MAX_STEPS } from "./steps.js";

/**
 * **The tools, and the one place they are registered.**
 *
 * Two audiences. Most tools are for the app's own code — the ticker and the
 * routes — and first-agent never offers them to a model. `record` and
 * `aggregate` are for the model and the planner: they are how a run keeps a
 * result and reads back what earlier runs kept, and they declare an
 * `outputSchema` so a plan can refer to their fields. Both take a
 * `scheduleId`, which the app strips from the schema the model sees and fills
 * in itself, so a run can only ever write to its own schedule.
 *
 * Like the OMDb server: a handler returns data or throws, and `toolResult` is
 * the only place either becomes a `CallToolResult`. Nothing crashes the server.
 */

const scheduleId = z.number().int().positive().describe("The schedule's id.");
const conversationId = z.string().trim().min(1).max(200).describe("The first-agent conversation this schedule belongs to.");
const intervalSeconds = z.number().int().min(MIN_INTERVAL_SECONDS).max(7 * 24 * 3600).describe(`Seconds between runs, at least ${MIN_INTERVAL_SECONDS}.`);
// The shape of each step is checked by `validateSteps` (steps.js), which can
// say which step is wrong and why — including a template that points forward.
const plan = z
  .array(z.record(z.string(), z.unknown()))
  .max(MAX_STEPS)
  .describe(
    'The accepted pipeline, in order: what a run executes. Each step is { kind: "tool", server, tool, args?, why? } or ' +
      '{ kind: "prompt", text, allowTools?, format?: "text" | "json", outputSchema?, why? }. ' +
      "Strings may use {{prev}}, {{steps.N}} (an earlier step, 1-based, optionally .path) and {{now}}."
  );
const goal = z.string().max(4000).describe("What the pipeline is for, in prose: what the planner plans from.");
// Checked by `validateProposal` (steps.js).
const proposal = z
  .record(z.string(), z.unknown())
  .nullable()
  .describe('A plan waiting to be accepted: { steps, notes?, createdAt, reason: "generated" | "repair", errors?, run? }, or null to clear it.');
const mode = z.enum(MODES).describe('"interval": every intervalSeconds while enabled. "once": only when run_now asks.');
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

  /**
   * One registration, wrapped so every handler ends up in `toolResult`. A tool
   * the planner may put in a plan declares its `output`, so the planner knows
   * the shape of what it returns before calling it.
   */
  const tool = (name, { title, description, input, output, annotations = app }, handler) =>
    server.registerTool(
      name,
      { title, description, inputSchema: input, ...(output ? { outputSchema: output } : {}), annotations },
      (args) => toolResult(() => handler(args))
    );

  // ---- for the app ---------------------------------------------------------

  tool(
    "create_schedule",
    {
      title: "Create a schedule",
      description:
        "App tool. Create the schedule (a pipeline) for one conversation (one per conversation). In interval mode it " +
        "starts due now and runs once enabled; in once mode it runs only on run_now. It is never claimed without a plan.",
      input: z.object({
        conversationId,
        mode: mode.optional(),
        goal: goal.optional(),
        plan: plan.optional(),
        proposal: proposal.optional(),
        intervalSeconds: intervalSeconds.optional(),
        enabled: z.boolean().optional(),
      }),
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
      description:
        "App tool. Change mode, goal, plan, proposal, intervalSeconds and/or enabled. Enabling an interval schedule makes it due now.",
      input: z.object({
        scheduleId,
        mode: mode.optional(),
        goal: goal.optional(),
        plan: plan.optional(),
        proposal: proposal.optional(),
        intervalSeconds: intervalSeconds.optional(),
        enabled: z.boolean().optional(),
      }),
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
        "every schedule that has an accepted plan, is not running, and is either due (interval mode, enabled, nextRunAt <= now + graceMs) or " +
        "has a pending run_now (any mode), insert a run, clear the run_now, and set nextRunAt = now + interval " +
        "(null in once mode). Returns { claimed: [{ run, schedule }], released }.",
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
      description:
        "App tool. Close a claimed run as ok or error, with its output, error, token count and the steps it took " +
        "(stored with the run in one transaction).",
      input: z.object({
        runId: z.number().int().positive(),
        ok: z.boolean(),
        output: z.string().max(20000).optional(),
        error: z.string().max(4000).optional(),
        tokens: z.number().int().min(0).optional(),
        steps: z
          .array(
            z.object({
              index: z.number().int().min(1),
              kind: z.enum(["tool", "prompt"]),
              server: z.string().max(64).optional(),
              tool: z.string().max(64).optional(),
              input: z.unknown().optional(),
              output: z.unknown().optional(),
              toolCalls: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
              status: z.enum(["ok", "error", "skipped"]),
              error: z.string().max(4000).optional(),
              ms: z.number().int().min(0).optional(),
              tokens: z.number().int().min(0).optional(),
            })
          )
          .max(MAX_STEPS)
          .optional()
          .describe("What each step did: its resolved input, its output, status, time and tokens."),
      }),
    },
    (args) => scheduler.finishRun(args)
  );

  tool(
    "get_run",
    {
      title: "Get a run",
      description: "App tool. One run and its steps, each with its exact resolved input and output: { run, steps }.",
      input: z.object({ runId: z.number().int().positive() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => scheduler.getRun(args)
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
      description: "App tool. Ask for a run: the next claim takes it, in either mode, enabled or not.",
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
      output: z.object({
        id: z.number().int().describe("The record's id."),
        scheduleId: z.number().int(),
        key: z.string(),
        label: z.string(),
        createdAt: z.string().describe("ISO time it was recorded."),
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
      output: z.object({
        invocations: z.number().int().describe("How many records there are."),
        uniqueKeys: z.number().int().describe("How many distinct keys."),
        mostRepeated: z.object({ label: z.string(), count: z.number().int() }).nullable().describe("The most recorded key's label, or null."),
        first: z.object({ label: z.string(), at: z.string() }).nullable().describe("The first record, or null."),
        last: z.object({ label: z.string(), at: z.string() }).nullable().describe("The latest record, or null."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => scheduler.aggregate(args)
  );

  return server;
}
