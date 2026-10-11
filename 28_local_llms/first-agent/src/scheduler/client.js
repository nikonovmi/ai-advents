import { describeError } from "../mcp/mcpClient.js";
import { resultText } from "../mcp/toolbox.js";

/**
 * **The scheduler server, as the app's own code calls it.**
 *
 * The ticker and the schedule routes call these tools directly — no model is
 * involved, and none of them is ever offered to one. Each method is one tool
 * call through the registry's `McpClient`, unwrapped: data comes back, a tool
 * error is a `SchedulerToolError`, and a server that cannot be reached is a
 * `SchedulerUnavailableError`, because "it said no" and "it is not running"
 * are answered differently (a 4xx with its sentence, a 503 that says start it).
 */

export class SchedulerUnavailableError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "SchedulerUnavailableError";
  }
}

export class SchedulerToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchedulerToolError";
  }
}

/**
 * How much of one step's input or output goes to `finish_run`, as JSON. The
 * run's message keeps the whole last output; the stored step is for looking
 * at, and a runaway tool should not make the run impossible to close.
 */
export const MAX_STEP_JSON_CHARS = 100_000;

/** A value, or a note saying how big it was and its start, if its JSON is too long. */
export function capJson(value, limit = MAX_STEP_JSON_CHARS) {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (json === undefined || json.length <= limit) return value;
  return { truncated: true, chars: json.length, preview: json.slice(0, limit) };
}

export class SchedulerClient {
  #mcp;

  /** @param {{ mcp: import("../mcp/mcpClient.js").McpClient }} deps */
  constructor({ mcp }) {
    if (!mcp) throw new Error("SchedulerClient needs the scheduler's McpClient");
    this.#mcp = mcp;
  }

  get url() {
    return this.#mcp.url;
  }

  async #call(name, args = {}) {
    let result;
    try {
      result = await this.#mcp.callTool(name, args);
    } catch (err) {
      throw new SchedulerUnavailableError(`Could not reach the scheduler at ${this.#mcp.url}: ${describeError(err)}`, err);
    }
    if (result?.isError) throw new SchedulerToolError(resultText(result) || `${name} failed`);
    if (result?.structuredContent) return result.structuredContent;
    try {
      return JSON.parse(resultText(result));
    } catch {
      throw new SchedulerToolError(`${name} answered something that was not JSON`);
    }
  }

  createSchedule({ conversationId, mode = "interval", steps = [], intervalSeconds = 60, enabled = false }) {
    return this.#call("create_schedule", { conversationId, mode, steps, intervalSeconds, enabled });
  }

  /** @returns {Promise<object | null>} */
  async getSchedule(conversationId) {
    return (await this.#call("get_schedule", { conversationId })).schedule ?? null;
  }

  updateSchedule(scheduleId, changes) {
    return this.#call("update_schedule", { scheduleId, ...changes });
  }

  deleteSchedule(scheduleId) {
    return this.#call("delete_schedule", { scheduleId });
  }

  async listSchedules() {
    return (await this.#call("list_schedules")).schedules ?? [];
  }

  claimDueRuns({ now, graceMs } = {}) {
    return this.#call("claim_due_runs", { ...(now === undefined ? {} : { now }), ...(graceMs === undefined ? {} : { graceMs }) });
  }

  finishRun({ runId, ok, output, error, tokens, steps }) {
    const args = { runId, ok };
    if (typeof output === "string") args.output = output.slice(0, 20000);
    if (typeof error === "string") args.error = error.slice(0, 4000);
    if (Number.isInteger(tokens) && tokens >= 0) args.tokens = tokens;
    if (Array.isArray(steps) && steps.length) args.steps = steps.map(stepForStorage);
    return this.#call("finish_run", args);
  }

  /** @returns {Promise<{ run: object, steps: object[] }>} */
  getRun(runId) {
    return this.#call("get_run", { runId });
  }

  async listRuns(scheduleId, limit = 10) {
    return (await this.#call("list_runs", { scheduleId, limit })).runs ?? [];
  }

  runNow(scheduleId) {
    return this.#call("run_now", { scheduleId });
  }

  releaseRuns() {
    return this.#call("release_runs");
  }

  aggregate(scheduleId) {
    return this.#call("aggregate", { scheduleId });
  }
}

/** One step as `finish_run` takes it: only the fields it has, the big ones capped. */
function stepForStorage(step) {
  const out = { index: step.index, kind: step.kind, status: step.status };
  if (step.server) out.server = step.server;
  if (step.tool) out.tool = step.tool;
  if (step.input !== undefined) out.input = capJson(step.input);
  if (step.output !== undefined) out.output = capJson(step.output);
  if (step.toolCalls?.length) out.toolCalls = step.toolCalls.slice(0, 50);
  if (typeof step.error === "string") out.error = step.error.slice(0, 4000);
  if (Number.isInteger(step.ms) && step.ms >= 0) out.ms = step.ms;
  if (Number.isInteger(step.tokens) && step.tokens >= 0) out.tokens = step.tokens;
  return out;
}
