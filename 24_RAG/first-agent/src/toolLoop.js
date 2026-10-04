import { LlmError } from "./llm/provider.js";

/**
 * **The tool loop, on its own.** Model → tools → model, until a text reply.
 *
 * It used to live inside `Agent`, which was fine while a chat turn was the only
 * thing that called tools. A scheduled run calls them too, from a fresh context
 * and with no Agent in sight, so the loop is here and both use it. It knows
 * nothing about histories, strategies or stores: it gets a system string, a
 * message list, the tools to offer and a way to call one, and it hands back the
 * final completion, the summed usage and what the tools did.
 */

/** Model → tools → model, at most this many times in one answer. */
export const MAX_TOOL_ROUNDS = 5;
export const TOOL_ROUNDS_FALLBACK =
  `I looked things up ${MAX_TOOL_ROUNDS} times without reaching an answer, so I stopped there. ` +
  "Try a narrower question, or name the exact title (and year) you mean.";

const RETRY_DELAYS_MS = [500, 1000, 2000];

/**
 * One model call, with up to three attempts, backing off on failures that are
 * worth retrying (rate limits and server-side errors). Everything else fails
 * immediately.
 *
 * @param {import("./llm/provider.js").LlmProvider} provider
 * @param {Parameters<import("./llm/provider.js").LlmProvider["complete"]>[0]} params
 * @param {{ delays?: number[], sleep?: (ms: number) => Promise<void> }} [options]
 */
export async function completeWithRetry(provider, params, { delays = RETRY_DELAYS_MS, sleep = defaultSleep } = {}) {
  let lastError;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      return await provider.complete(params);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof LlmError && (err.status === 429 || err.status >= 500);
      const attemptsLeft = attempt < delays.length - 1;
      if (!retryable || !attemptsLeft) throw err;
      await sleep(delays[attempt]);
    }
  }
  throw lastError;
}

/**
 * **One answer, however many model calls it takes.**
 *
 * Without tools this is exactly one call. With them, while the model stops on
 * `tool_use`, each requested tool is run, the assistant's blocks and the
 * results go on the end of *this call's* message list, and the model is asked
 * again. A tool that failed goes back as `isError`, so the model can say so or
 * try something else. After `maxRounds` rounds the loop stops with a fallback
 * sentence rather than asking forever.
 *
 * The extended messages live only here. The caller gets the final text.
 *
 * @param {object} params
 * @param {(request: { system?: string, messages: object[], tools?: object[] }) => Promise<import("./llm/provider.js").Completion>} params.complete
 *   One model call; the caller decides the model, the temperature and the retries.
 * @param {string} [params.system]
 * @param {import("./llm/provider.js").Message[]} params.messages
 * @param {import("./llm/provider.js").ToolDefinition[]} [params.tools] - Absent or empty: no tools offered.
 * @param {(name: string, input: object) => Promise<{ server: string, tool: string, ok: boolean, text: string, preview: string, ms: number }>} [params.call]
 * @param {number} [params.maxRounds]
 */
export async function runToolLoop({ complete, system, messages, tools, call, maxRounds = MAX_TOOL_ROUNDS }) {
  const offered = tools?.length ? tools : undefined;

  let wire = messages;
  let result = await complete({ system, messages: wire, ...(offered ? { tools: offered } : {}) });
  const usage = { inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null };
  const toolCalls = [];
  let rounds = 0;
  let capped = false;

  while (offered && result.stopReason === "tool_use") {
    const uses = (result.content ?? []).filter((block) => block.type === "tool_use");
    if (!uses.length) break;
    if (rounds === maxRounds) {
      capped = true;
      break;
    }
    rounds += 1;

    const results = [];
    for (const use of uses) {
      const done = await call(use.name, use.input);
      toolCalls.push({
        server: done.server,
        tool: done.tool,
        input: use.input ?? {},
        ok: done.ok,
        resultPreview: done.preview,
        ms: done.ms,
      });
      results.push({ type: "tool_result", toolUseId: use.id, content: done.text, ...(done.ok ? {} : { isError: true }) });
    }

    wire = [...wire, { role: "assistant", content: result.content }, { role: "user", content: results }];
    result = await complete({ system, messages: wire, tools: offered });
    usage.inputTokens = addCounts(usage.inputTokens, result.usage?.inputTokens);
    usage.outputTokens = addCounts(usage.outputTokens, result.usage?.outputTokens);
  }

  if (capped) {
    const said = result.text?.trim();
    result = { ...result, text: said ? `${said}\n\n${TOOL_ROUNDS_FALLBACK}` : TOOL_ROUNDS_FALLBACK };
  }

  return { result, usage, toolCalls, toolRounds: rounds, toolsCapped: capped };
}

/** Adds two counts where either may be unknown; both unknown stays unknown. */
export function addCounts(a, b) {
  if (typeof a !== "number" && typeof b !== "number") return null;
  return (a ?? 0) + (b ?? 0);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
