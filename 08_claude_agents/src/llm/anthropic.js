import { LlmProvider, LlmError } from "./provider.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const TIMEOUT_MS = 30000;

/**
 * Anthropic implementation of the LLM abstraction.
 *
 * This is the only file that knows the endpoint, the header names, the
 * request/response shape, or the API key.
 */
export class AnthropicProvider extends LlmProvider {
  #apiKey;
  #model;
  #workspaceId;

  /**
   * @param {object} params
   * @param {string} params.apiKey
   * @param {string} [params.model]
   * @param {string} [params.workspaceId] - Only needed for identity-linked keys.
   */
  constructor({ apiKey, model = "claude-haiku-4-5-20251001", workspaceId } = {}) {
    super();
    if (!apiKey) {
      throw new Error(
        "AnthropicProvider requires an apiKey. Set ANTHROPIC_API_KEY in your .env file."
      );
    }
    this.#apiKey = apiKey;
    this.#model = model;
    this.#workspaceId = workspaceId;
  }

  get model() {
    return this.#model;
  }

  async complete({ system, messages, temperature = 0.7, maxTokens = 1024 }) {
    const body = {
      model: this.#model,
      max_tokens: maxTokens,
      temperature,
      messages: messages.map(({ role, content }) => ({ role, content })),
    };
    if (system) body.system = system;

    const headers = {
      "x-api-key": this.#apiKey,
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
    };
    // Identity-linked keys must name the workspace they act in; workspace-scoped
    // keys don't, and the header is harmless to omit for them.
    if (this.#workspaceId) headers["anthropic-workspace-id"] = this.#workspaceId;

    let response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      throw new LlmError(
        timedOut
          ? `Request to Anthropic timed out after ${TIMEOUT_MS}ms`
          : `Could not reach Anthropic: ${err?.message ?? String(err)}`,
        timedOut ? 408 : 0
      );
    }

    const raw = await response.text();

    if (!response.ok) {
      throw new LlmError(errorMessageFrom(raw, response.status), response.status);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new LlmError("Anthropic returned a response that was not JSON", response.status);
    }

    return {
      text: extractText(data.content),
      model: data.model ?? this.#model,
    };
  }
}

/**
 * Flatten Anthropic's content blocks into plain text. Non-text blocks
 * (tool_use, thinking, …) are skipped here, so supporting them later is a
 * change to this helper and nothing above it.
 *
 * @param {Array<{ type: string, text?: string }>} [blocks]
 * @returns {string}
 */
function extractText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

/**
 * Pull the provider's own error message out of a failed response body,
 * falling back to something readable.
 *
 * @param {string} raw
 * @param {number} status
 * @returns {string}
 */
function errorMessageFrom(raw, status) {
  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.error?.message;
    if (message) return message;
  } catch {
    // fall through to the raw body
  }
  const snippet = raw?.trim().slice(0, 200);
  return snippet ? `HTTP ${status}: ${snippet}` : `HTTP ${status}`;
}

/**
 * A provider that never leaves the process: no key, no network. Useful for
 * exercising the app and the Agent offline.
 */
export class FakeProvider extends LlmProvider {
  #delayMs;
  #reply;

  constructor({ delayMs = 400, reply } = {}) {
    super();
    this.#delayMs = delayMs;
    this.#reply = reply;
  }

  async complete({ messages }) {
    await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const text =
      this.#reply ??
      `(fake reply) You said: "${lastUser?.content ?? ""}". ` +
        `No API key is configured, so nothing was sent to a real model.`;
    return { text, model: "fake-provider" };
  }
}
