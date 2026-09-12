import { LlmError } from "./llm/provider.js";

/** Ready-made system prompts. */
export const personas = {
  helpful: [
    "You are a friendly, concise assistant.",
    "Answer directly, prefer plain language over jargon, and say so when you are unsure.",
    "Keep replies short unless the user asks for detail.",
  ].join(" "),

  pirate: [
    "You are a salty old pirate captain who has somehow ended up doing tech support.",
    "Speak in full pirate voice — 'arr', 'matey', 'ye' — but your advice must still be genuinely correct and useful.",
    "Keep it to a few sentences.",
  ].join(" "),
};

const RETRY_DELAYS_MS = [500, 1000, 2000];

/**
 * A conversational agent: it owns a persona and a rolling conversation
 * history, and it delegates every model call to an injected provider.
 *
 * It has no idea which vendor is behind that provider, and no idea that
 * sessions or HTTP requests exist.
 */
export class Agent {
  #provider;
  #history = [];

  /**
   * @param {object} params
   * @param {import("./llm/provider.js").LlmProvider} params.provider
   * @param {string} [params.name]
   * @param {string} [params.systemPrompt]
   * @param {number} [params.temperature]
   * @param {number} [params.maxTokens]
   * @param {number} [params.historyLimit] - Max turns kept (user + assistant).
   */
  constructor({
    provider,
    name = "Assistant",
    systemPrompt = personas.helpful,
    temperature = 0.7,
    maxTokens = 1024,
    historyLimit = 20,
  } = {}) {
    if (!provider || typeof provider.complete !== "function") {
      throw new Error("Agent requires a provider with a complete() method");
    }
    this.#provider = provider;
    this.name = name;
    this.systemPrompt = systemPrompt;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.historyLimit = historyLimit;
  }

  /**
   * Take one user turn and produce one assistant turn.
   *
   * @param {string} userInput
   * @returns {Promise<{ text: string, meta: { agent: string, model: string, ms: number } }>}
   */
  async run(userInput) {
    const text = typeof userInput === "string" ? userInput.trim() : "";
    if (!text) throw new Error("Agent.run() needs a non-empty message");

    const startedAt = Date.now();
    this.#history.push({ role: "user", content: text });

    let result;
    try {
      result = await this.#callWithRetry();
    } catch (err) {
      // Don't leave a dangling user turn behind after a failure.
      this.#history.pop();
      throw err;
    }

    this.#history.push({ role: "assistant", content: result.text });
    this.#trimHistory();

    return {
      text: result.text,
      meta: {
        agent: this.name,
        model: result.model,
        ms: Date.now() - startedAt,
      },
    };
  }

  /** Forget the conversation so far. */
  reset() {
    this.#history = [];
  }

  /** A copy of the conversation so far — callers cannot mutate our state. */
  get transcript() {
    return this.#history.map((turn) => ({ ...turn }));
  }

  /**
   * Up to three attempts, backing off on failures that are worth retrying
   * (rate limits and server-side errors). Everything else fails immediately.
   */
  async #callWithRetry() {
    let lastError;

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await this.#provider.complete({
          system: this.systemPrompt,
          messages: this.transcript,
          temperature: this.temperature,
          maxTokens: this.maxTokens,
        });
      } catch (err) {
        lastError = err;
        const retryable =
          err instanceof LlmError && (err.status === 429 || err.status >= 500);
        const attemptsLeft = attempt < RETRY_DELAYS_MS.length - 1;
        if (!retryable || !attemptsLeft) throw err;
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }

    throw lastError;
  }

  #trimHistory() {
    if (this.#history.length > this.historyLimit) {
      this.#history = this.#history.slice(-this.historyLimit);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
