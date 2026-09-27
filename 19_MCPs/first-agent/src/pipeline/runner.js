import { agentFor } from "../agents.js";
import { estimateCost } from "../llm/pricing.js";
import { describeError, isUnauthorized } from "../mcp/mcpClient.js";
import { resultText } from "../mcp/toolbox.js";
import { scopedTools } from "../scheduler/scope.js";
import { emptyUsage, nextMessageId } from "../store/conversationStore.js";
import { addCounts, completeWithRetry, runToolLoop } from "../toolLoop.js";
import { interpolate, resolve } from "./templates.js";

/**
 * **One pipeline run: steps in order, each output feeding the next, one
 * message out.**
 *
 * A step is either a tool — one MCP call made by this code, no model — or a
 * prompt — one model call from a fresh context: the persona and the step's
 * text, and the allowlisted tools only if the step asks for them. The chat's
 * history is never sent; neither is any earlier step's context. What passes
 * from one step to the next is data, moved by code through templates
 * (`{{prev}}`, `{{steps.N}}`, `{{now}}` — see `templates.js`).
 *
 * Fail fast: the first step that fails (an `isError` result, a throw, a
 * template that points at nothing) ends the run; the rest are recorded as
 * skipped. Every step — its resolved input, output, status, time and tokens —
 * goes back to the ticker, which stores it with the run (`finish_run`).
 * Whatever happens, exactly one assistant message is appended: the last
 * step's output, or a line saying which step failed and why, with a strip of
 * the steps for the UI.
 */

export const MAX_STEP_TOOL_ROUNDS = 5;
export const SCOPE_NOTE =
  "scheduleId context is handled for you: the record and aggregate tools already belong to this task's " +
  "schedule, so never ask for one or pass one.";
/** The message is for reading; the full output is on the stored step. */
export const MAX_MESSAGE_CHARS = 20000;
/** Scheduler tools a tool step may leave the scheduleId off, to mean its own schedule. */
const OWN_SCHEDULE_TOOLS = new Set(["record", "aggregate"]);

/** A step that failed, with the input it had resolved by then (if it got that far). */
class StepFailure extends Error {
  constructor(message, input) {
    super(message);
    this.name = "StepFailure";
    this.input = input;
  }
}

/** What a step is called on the strip: the tool it calls, or "prompt". */
export function stepLabel(step) {
  return step?.kind === "tool" ? String(step.tool ?? "tool") : "prompt";
}

/**
 * A tool result as the next step sees it: structured content if the server
 * sent it, else the text — parsed, if it is JSON.
 */
export function toolOutput(result) {
  if (result?.structuredContent !== undefined && result?.structuredContent !== null) return result.structuredContent;
  const text = resultText(result);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class PipelineRunner {
  #provider;
  #store;
  #registry;
  #toolbox;
  #now;
  #onAppended;
  #maxTokens;

  /**
   * @param {{
   *   provider: import("../llm/provider.js").LlmProvider,
   *   store: import("../store/conversationStore.js").ConversationStore,
   *   registry: import("../mcp/servers.js").McpRegistry,
   *   toolbox: { toolsFor: Function, route: Function, call: Function },
   *   now?: () => number,
   *   onAppended?: (conversationId: string) => void,
   *   maxTokens?: number,
   * }} deps - `registry` is how a tool step reaches a server directly;
   *   `toolbox` is what a prompt step with tools goes through (behind the
   *   agent's allowlist). `now` is also the clock `{{now}}` reads.
   */
  constructor({ provider, store, registry, toolbox, now = Date.now, onAppended = () => {}, maxTokens = 1024 }) {
    this.#provider = provider;
    this.#store = store;
    this.#registry = registry;
    this.#toolbox = toolbox;
    this.#now = now;
    this.#onAppended = onAppended;
    this.#maxTokens = maxTokens;
  }

  /**
   * @param {{ run: { id: number }, schedule: { id: number, conversationId: string, steps: object[] } }} claimed
   * @returns {Promise<{ ok: boolean, output?: string, error?: string, tokens?: number, steps?: object[], orphan?: boolean }>}
   *   `orphan` means the conversation is gone, so the schedule should go too.
   */
  async run({ run, schedule }) {
    const started = this.#now();
    const conversationId = schedule.conversationId;
    const record = await this.#store.load(conversationId);
    if (!record) return { ok: false, orphan: true, error: "The conversation this schedule belongs to no longer exists." };

    const definition = agentFor(record.agentId);
    if (definition.kind !== "scheduled") {
      return { ok: false, error: `The conversation belongs to "${definition.id}", which is not a scheduled agent.` };
    }

    const steps = Array.isArray(schedule.steps) ? schedule.steps : [];
    const outputs = [];
    const done = [];
    const usage = { inputTokens: null, outputTokens: null };
    let model = null;
    let failure = steps.length ? null : { index: 0, label: "", message: "The pipeline has no steps — add some in the Pipeline panel." };

    for (const [i, step] of steps.entries()) {
      const index = i + 1;
      const where = step.kind === "tool" ? { server: step.server, tool: step.tool } : {};
      if (failure) {
        done.push({ index, kind: step.kind, ...where, status: "skipped" });
        continue;
      }
      const t0 = this.#now();
      try {
        const out =
          step.kind === "tool"
            ? await this.#tool(step, outputs, schedule.id)
            : await this.#prompt(step, outputs, definition, schedule.id);
        const tokens = sum(out.usage?.inputTokens, out.usage?.outputTokens);
        if (out.usage) {
          usage.inputTokens = addCounts(usage.inputTokens, out.usage.inputTokens);
          usage.outputTokens = addCounts(usage.outputTokens, out.usage.outputTokens);
          model = out.model ?? model;
        }
        outputs.push(out.output);
        done.push({
          index,
          kind: step.kind,
          ...where,
          input: out.input,
          output: out.output,
          ...(out.toolCalls?.length ? { toolCalls: out.toolCalls } : {}),
          status: "ok",
          ms: this.#now() - t0,
          ...(tokens != null ? { tokens } : {}),
        });
      } catch (err) {
        const message = err instanceof StepFailure || err?.name === "TemplateError" ? err.message : describeError(err);
        failure = { index, label: stepLabel(step), message };
        done.push({
          index,
          kind: step.kind,
          ...where,
          ...(err?.input !== undefined ? { input: err.input } : {}),
          status: "error",
          error: message,
          ms: this.#now() - t0,
        });
      }
    }

    const durationMs = this.#now() - started;
    const tokens = sum(usage.inputTokens, usage.outputTokens);
    const strip = done.map((step, i) => ({ index: step.index, kind: step.kind, label: stepLabel(steps[i]), status: step.status, ms: step.ms ?? null }));
    const content = failure
      ? `⚠️ Run #${run.id} failed${failure.index ? ` at step ${failure.index} (${failure.label})` : ""}: ${failure.message}`
      : messageText(outputs.at(-1));
    const cost = tokens != null ? estimateCost({ model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }) : null;

    const message = {
      role: "assistant",
      content,
      steps: strip,
      ...(tokens != null
        ? {
            tokens: { input: usage.inputTokens, output: usage.outputTokens, total: tokens },
            cost: { input: cost.inputCost, output: cost.outputCost, total: cost.totalCost },
            model,
          }
        : {}),
      ms: durationMs,
      run: { runId: run.id, durationMs, tokens, ok: !failure, ...(failure ? { error: failure.message } : {}) },
    };

    const appended = await this.#append(conversationId, message, { billed: tokens != null ? usage : null, counted: !failure });
    if (!appended) return { ok: false, orphan: true, error: "The conversation was deleted while the run was in flight.", steps: done };

    return failure
      ? { ok: false, error: failure.index ? `Step ${failure.index} (${failure.label}): ${failure.message}` : failure.message, steps: done, ...(tokens != null ? { tokens } : {}) }
      : { ok: true, output: content, steps: done, ...(tokens != null ? { tokens } : {}) };
  }

  /** A fixed MCP call: args resolved, the server called directly, no model. */
  async #tool(step, outputs, scheduleId) {
    const input = resolve(step.args ?? {}, { steps: outputs, now: this.#now });
    if (step.server === "scheduler" && OWN_SCHEDULE_TOOLS.has(step.tool) && input && typeof input === "object" && !("scheduleId" in input)) {
      input.scheduleId = scheduleId;
    }
    const client = this.#registry.get(step.server);
    if (!client) throw new StepFailure(`There is no MCP server "${step.server}".`, input);
    const name = this.#registry.definition(step.server)?.name ?? step.server;
    const reconnect = `Reconnect ${name} in the panel.`;

    let result;
    try {
      if (client.auth === "oauth" && !(await client.connect()).ok) throw new StepFailure(reconnect, input);
      result = await client.callTool(step.tool, input);
    } catch (err) {
      if (err instanceof StepFailure) throw err;
      if (client.auth === "oauth" && isUnauthorized(err)) throw new StepFailure(reconnect, input);
      if (client.auth === "oauth" && /needs authorization/i.test(err?.message ?? "")) throw new StepFailure(reconnect, input);
      throw new StepFailure(`${step.server}.${step.tool} could not be called: ${describeError(err)}`, input);
    }
    if (result?.isError) throw new StepFailure(resultText(result) || `${step.server}.${step.tool} failed without saying why.`, input);
    return { input, output: toolOutput(result) };
  }

  /** One model call from a fresh context: persona + this step's text, tools only if allowed. */
  async #prompt(step, outputs, definition, scheduleId) {
    const text = interpolate(step.text, { steps: outputs, now: this.#now });
    const complete = (request) =>
      completeWithRetry(this.#provider, { ...request, temperature: 0.7, maxTokens: this.#maxTokens, model: definition.model });
    const messages = [{ role: "user", content: text }];

    let result;
    let usage;
    let toolCalls = [];
    if (step.allowTools) {
      const offered = await scopedTools({ toolbox: this.#toolbox, servers: definition.mcpServers ?? [], allow: definition.tools, scheduleId });
      for (const { server, error } of offered.unavailable) {
        console.warn(`[pipeline] MCP server "${server}" is unavailable for schedule ${scheduleId}: ${error}`);
      }
      const loop = await runToolLoop({
        complete,
        system: `${definition.systemPrompt}\n\n${SCOPE_NOTE}`,
        messages,
        tools: offered.tools,
        call: offered.call,
        maxRounds: MAX_STEP_TOOL_ROUNDS,
      });
      ({ result, usage, toolCalls } = loop);
    } else {
      result = await complete({ system: definition.systemPrompt, messages });
      usage = { inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null };
    }

    const output = result.text?.trim() ?? "";
    if (!output) throw new StepFailure("The model returned no text.", text);
    return { input: text, output, usage, model: result.model, toolCalls };
  }

  /**
   * Re-read, append, save. Re-read rather than reusing the record from the
   * start of the run: the chat may have been deleted in the meantime, and a
   * save would quietly bring it back.
   */
  async #append(conversationId, message, { billed, counted }) {
    const record = await this.#store.load(conversationId);
    if (!record) return false;

    const usage = { ...emptyUsage(), ...record.usage };
    if (billed) {
      usage.totalInputTokens += billed.inputTokens ?? 0;
      usage.totalOutputTokens += billed.outputTokens ?? 0;
      usage.totalCostUsd += message.cost?.total ?? 0;
    }
    if (counted) usage.turnCount += 1;
    const messages = [...record.messages, { ...message, id: nextMessageId(record.messages) }];
    await this.#store.save(conversationId, messages, usage, {});
    this.#onAppended(conversationId);
    return true;
  }
}

/** The last output as the message's text: a string as it is, anything else as a JSON block. */
function messageText(output) {
  if (output === "") return "(the last step returned nothing)";
  const text = typeof output === "string" ? output : "```json\n" + JSON.stringify(output ?? null, null, 2) + "\n```";
  return text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS - 1) + "…" : text;
}

function sum(a, b) {
  return typeof a === "number" && typeof b === "number" ? a + b : null;
}
