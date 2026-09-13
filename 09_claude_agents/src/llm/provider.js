/**
 * The LLM abstraction.
 *
 * Everything above this boundary (the Agent, the routes) speaks only in the
 * neutral shapes defined here: a system string, a `{ role, content }` message
 * array, and a `{ text, model, stopReason, usage }` result. Nothing
 * vendor-specific — no wire formats, no raw responses, no API keys — is
 * allowed to cross it.
 *
 * Note the naming: `stopReason` and `usage.inputTokens`, not `stop_reason` and
 * `input_tokens`. Those are Anthropic's spellings and they stop one file over.
 */

/**
 * @typedef {{ role: "user" | "assistant", content: string }} Message
 * @typedef {{ inputTokens: number, outputTokens: number, cacheReadInputTokens?: number, cacheCreationInputTokens?: number }} Usage
 * @typedef {{ text: string, model: string, stopReason: string | null, usage: Usage }} Completion
 */

export class LlmProvider {
  /**
   * @param {object} params
   * @param {string} [params.system] - System prompt / persona.
   * @param {Message[]} params.messages - Conversation so far, oldest first.
   * @param {number} [params.temperature]
   * @param {number} [params.maxTokens]
   * @param {string} [params.model] - Override the provider's default model for
   *   this one call. A model id is a neutral string — it is already in every
   *   `Completion` and in the price table — so naming one here crosses no
   *   boundary. It is what lets a caller send a side task, like summarising,
   *   to a cheaper model than the conversation itself.
   * @returns {Promise<Completion>}
   */
  // eslint-disable-next-line no-unused-vars
  async complete({ system, messages, temperature, maxTokens, model }) {
    throw new Error("Not implemented");
  }

  /**
   * Measure a payload without running the model, so the caller can know what
   * a request costs before paying for it.
   *
   * @param {object} params
   * @param {string} [params.system]
   * @param {Message[]} params.messages
   * @param {string} [params.model]
   * @returns {Promise<{ inputTokens: number }>}
   */
  // eslint-disable-next-line no-unused-vars
  async countTokens({ system, messages, model }) {
    throw new Error("Not implemented");
  }
}

/**
 * A provider-agnostic failure. Callers can branch on `status` (HTTP-ish:
 * 429 for rate limits, 5xx for server trouble) without knowing which vendor
 * produced it.
 */
export class LlmError extends Error {
  /**
   * @param {string} message
   * @param {number} [status] - HTTP status, or 0 when the call never landed.
   */
  constructor(message, status = 0) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}
