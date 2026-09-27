import { agentFor } from "../agents.js";
import { describeError } from "../mcp/mcpClient.js";
import { estimateCost } from "../llm/pricing.js";
import { emptyUsage, nextMessageId } from "../store/conversationStore.js";
import { completeWithRetry, runToolLoop } from "../toolLoop.js";
import { scopedTools } from "./scope.js";

/**
 * **One scheduled run: fresh context in, one message out.**
 *
 * The payload is the persona and the chat's prompt, and nothing else — the
 * chat's history is never sent. There is no Agent here, no ContextStrategy, no
 * task lifecycle and no extraction: a run is the provider plus the Day 17 tool
 * loop, with the tools narrowed to the agent's allowlist and the scheduleId
 * filled in by the app. Whatever happens, exactly one assistant message is
 * appended to the conversation: the reply, or a sentence saying why there is
 * none.
 */

export const MAX_RUN_TOOL_ROUNDS = 5;
export const SCOPE_NOTE =
  "scheduleId context is handled for you: the record and aggregate tools already belong to this task's " +
  "schedule, so never ask for one or pass one.";

export class ScheduledRunner {
  #provider;
  #store;
  #toolbox;
  #now;
  #onAppended;
  #maxTokens;

  /**
   * @param {{
   *   provider: import("../llm/provider.js").LlmProvider,
   *   store: import("../store/conversationStore.js").ConversationStore,
   *   toolbox: { toolsFor: Function, route: Function, call: Function },
   *   now?: () => number,
   *   onAppended?: (conversationId: string) => void,
   *   maxTokens?: number,
   * }} deps - `onAppended` is how the server drops a cached copy of the
   *   conversation that no longer has the latest message.
   */
  constructor({ provider, store, toolbox, now = Date.now, onAppended = () => {}, maxTokens = 1024 }) {
    this.#provider = provider;
    this.#store = store;
    this.#toolbox = toolbox;
    this.#now = now;
    this.#onAppended = onAppended;
    this.#maxTokens = maxTokens;
  }

  /**
   * @param {{ run: { id: number }, schedule: { id: number, conversationId: string, prompt: string } }} claimed
   * @returns {Promise<{ ok: boolean, output?: string, error?: string, tokens?: number, orphan?: boolean }>}
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

    let answer = null;
    let failure = null;
    const prompt = String(schedule.prompt ?? "").trim();
    if (!prompt) {
      failure = "No prompt is set for this task — write one in the Schedule panel.";
    } else {
      try {
        answer = await this.#answer({ definition, prompt, scheduleId: schedule.id });
      } catch (err) {
        failure = describeError(err);
      }
    }

    const durationMs = this.#now() - started;
    const tokens = answer ? sum(answer.usage.inputTokens, answer.usage.outputTokens) : null;
    const message = answer
      ? this.#reply({ answer, runId: run.id, durationMs, tokens })
      : {
          role: "assistant",
          content: `⚠️ Run #${run.id} failed: ${failure}`,
          run: { runId: run.id, durationMs, tokens: null, ok: false, error: failure },
        };

    const appended = await this.#append(conversationId, message, answer);
    if (!appended) return { ok: false, orphan: true, error: "The conversation was deleted while the run was in flight." };

    return answer
      ? { ok: true, output: message.content, ...(tokens != null ? { tokens } : {}) }
      : { ok: false, error: failure };
  }

  /** Persona + prompt, the allowlisted tools, the shared loop. */
  async #answer({ definition, prompt, scheduleId }) {
    const offered = await scopedTools({
      toolbox: this.#toolbox,
      servers: definition.mcpServers ?? [],
      allow: definition.tools,
      scheduleId,
    });
    for (const { server, error } of offered.unavailable) {
      console.warn(`[scheduler] MCP server "${server}" is unavailable for schedule ${scheduleId}: ${error}`);
    }

    const loop = await runToolLoop({
      complete: (request) =>
        completeWithRetry(this.#provider, {
          ...request,
          temperature: 0.7,
          maxTokens: this.#maxTokens,
          model: definition.model,
        }),
      system: `${definition.systemPrompt}\n\n${SCOPE_NOTE}`,
      messages: [{ role: "user", content: prompt }],
      tools: offered.tools,
      call: offered.call,
      maxRounds: MAX_RUN_TOOL_ROUNDS,
    });
    return { ...loop, toolsUnavailable: offered.unavailable };
  }

  #reply({ answer, runId, durationMs, tokens }) {
    const { result, usage, toolCalls, toolsCapped, toolsUnavailable } = answer;
    const cost = estimateCost({ model: result.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    return {
      role: "assistant",
      content: result.text?.trim() || "(the run finished without a reply)",
      tokens: { input: usage.inputTokens, output: usage.outputTokens, total: tokens },
      cost: { input: cost.inputCost, output: cost.outputCost, total: cost.totalCost },
      model: result.model,
      ms: durationMs,
      stopReason: result.stopReason,
      ...(result.stopReason === "max_tokens" ? { truncated: true } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(toolsCapped ? { toolRoundsExceeded: true } : {}),
      ...(toolsUnavailable.length ? { toolsUnavailable } : {}),
      run: { runId, durationMs, tokens, ok: true },
    };
  }

  /**
   * Re-read, append, save. Re-read rather than reusing the record from the
   * start of the run: the chat may have been deleted in the meantime, and a
   * save would quietly bring it back.
   */
  async #append(conversationId, message, answer) {
    const record = await this.#store.load(conversationId);
    if (!record) return false;

    const usage = { ...emptyUsage(), ...record.usage };
    if (answer) {
      usage.totalInputTokens += answer.usage.inputTokens ?? 0;
      usage.totalOutputTokens += answer.usage.outputTokens ?? 0;
      usage.totalCostUsd += message.cost?.total ?? 0;
      usage.turnCount += 1;
    }
    const messages = [...record.messages, { ...message, id: nextMessageId(record.messages) }];
    await this.#store.save(conversationId, messages, usage, {});
    this.#onAppended(conversationId);
    return true;
  }
}

function sum(a, b) {
  return typeof a === "number" && typeof b === "number" ? a + b : null;
}
