import { LlmProvider, LlmError } from "./provider.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const COUNT_URL = "https://api.anthropic.com/v1/messages/count_tokens";
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

    const data = await this.#post(API_URL, body);

    return {
      text: extractText(data.content),
      model: data.model ?? this.#model,
      // `stop_reason` becomes `stopReason` here and nowhere else. Above this
      // line nobody knows Anthropic uses snake_case.
      stopReason: data.stop_reason ?? null,
      usage: neutralUsage(data.usage),
    };
  }

  /**
   * The same body the Messages API takes, minus `max_tokens` (there is no
   * output to cap — the model never runs). Free and unbilled, which is what
   * makes it usable as a pre-flight measurement on every single turn.
   */
  async countTokens({ system, messages }) {
    const body = {
      model: this.#model,
      messages: messages.map(({ role, content }) => ({ role, content })),
    };
    if (system) body.system = system;

    const data = await this.#post(COUNT_URL, body);
    return { inputTokens: data.input_tokens ?? 0 };
  }

  /**
   * One POST, one set of headers, one timeout, one error translation — shared
   * by both endpoints so they cannot drift apart.
   */
  async #post(url, body) {
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
      response = await fetch(url, {
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

    try {
      return JSON.parse(raw);
    } catch {
      throw new LlmError("Anthropic returned a response that was not JSON", response.status);
    }
  }
}

/**
 * Anthropic's `usage` object in neutral clothes. The two cache fields only
 * appear when prompt caching is in play, so they are passed through when
 * present and simply absent otherwise — never faked as zero, which would
 * read as "nothing was cached" rather than "caching was not involved".
 *
 * @param {{ input_tokens?: number, output_tokens?: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number }} [usage]
 * @returns {import("./provider.js").Usage}
 */
function neutralUsage(usage) {
  const neutral = {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
  if (typeof usage?.cache_read_input_tokens === "number") {
    neutral.cacheReadInputTokens = usage.cache_read_input_tokens;
  }
  if (typeof usage?.cache_creation_input_tokens === "number") {
    neutral.cacheCreationInputTokens = usage.cache_creation_input_tokens;
  }
  return neutral;
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
 *
 * Its numbers are synthetic but shaped like the real thing — roughly four
 * characters to a token — so the counters, the cost panel and the truncation
 * warning all behave without a key. They are not billed and not accurate;
 * `fake-provider` is deliberately absent from PRICING, which is also how the
 * unknown-model path gets exercised.
 */
export class FakeProvider extends LlmProvider {
  #delayMs;
  #reply;

  constructor({ delayMs = 400, reply } = {}) {
    super();
    this.#delayMs = delayMs;
    this.#reply = reply;
  }

  get model() {
    return "fake-provider";
  }

  async complete({ system, messages, maxTokens = 1024 }) {
    await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    let text =
      this.#reply ??
      `(fake reply) You said: "${lastUser?.content ?? ""}". ` +
        `No API key is configured, so nothing was sent to a real model.`;

    // Honour the ceiling the same way a real model does: stop mid-sentence and
    // say so, so the truncation path is reachable offline.
    const outputTokens = approximateTokens(text);
    const hitCeiling = outputTokens > maxTokens;
    if (hitCeiling) text = text.slice(0, maxTokens * 4);

    return {
      text,
      model: "fake-provider",
      stopReason: hitCeiling ? "max_tokens" : "end_turn",
      usage: {
        inputTokens: (await this.countTokens({ system, messages })).inputTokens,
        outputTokens: Math.min(outputTokens, maxTokens),
      },
    };
  }

  async countTokens({ system, messages }) {
    const body = (messages ?? []).map((m) => m.content).join("\n");
    // A few tokens of per-message envelope, like the real endpoint charges.
    const envelope = (messages ?? []).length * 3;
    return { inputTokens: approximateTokens(system ?? "") + approximateTokens(body) + envelope };
  }
}

function approximateTokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}
