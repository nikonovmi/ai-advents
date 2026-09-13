/**
 * The LLM abstraction.
 *
 * Everything above this boundary (the Agent, the routes) speaks only in the
 * neutral shapes defined here: a system string, a `{ role, content }` message
 * array, and a `{ text, model }` result. Nothing vendor-specific — no wire
 * formats, no raw responses, no API keys — is allowed to cross it.
 */

/**
 * @typedef {{ role: "user" | "assistant", content: string }} Message
 * @typedef {{ text: string, model: string }} Completion
 */

export class LlmProvider {
  /**
   * @param {object} params
   * @param {string} [params.system] - System prompt / persona.
   * @param {Message[]} params.messages - Conversation so far, oldest first.
   * @param {number} [params.temperature]
   * @param {number} [params.maxTokens]
   * @returns {Promise<Completion>}
   */
  // eslint-disable-next-line no-unused-vars
  async complete({ system, messages, temperature, maxTokens }) {
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
