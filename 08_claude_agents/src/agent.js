import { estimateCost } from "./llm/pricing.js";
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
 * history, and it delegates every model call to an injected provider and
 * every read or write of that history to an injected store.
 *
 * It has no idea which vendor is behind that provider, no idea how or where
 * the store keeps a conversation, and no idea that HTTP requests exist.
 */
export class Agent {
  #provider;
  #store;
  /** @type {import("./store/conversationStore.js").StoredMessage[]} */
  #history = [];
  /** @type {import("./store/conversationStore.js").ConversationUsage} */
  #usage = { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, turnCount: 0 };

  /**
   * @param {object} params
   * @param {import("./llm/provider.js").LlmProvider} params.provider
   * @param {import("./store/conversationStore.js").ConversationStore} params.store
   * @param {string} params.sessionId - Which conversation this agent is.
   * @param {string} [params.name]
   * @param {string} [params.systemPrompt]
   * @param {number} [params.temperature]
   * @param {number} [params.maxTokens]
   * @param {number} [params.contextMessages] - How many recent *user* messages
   *   are sent, along with the replies that came after them.
   */
  constructor({
    provider,
    store,
    sessionId,
    name = "Assistant",
    systemPrompt = personas.helpful,
    temperature = 0.7,
    maxTokens = 1024,
    contextMessages = 5,
  } = {}) {
    if (!provider || typeof provider.complete !== "function") {
      throw new Error("Agent requires a provider with a complete() method");
    }
    if (!store || typeof store.save !== "function") {
      throw new Error("Agent requires a store with a save() method");
    }
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("Agent requires a sessionId");
    }
    this.#provider = provider;
    this.#store = store;
    this.sessionId = sessionId;
    this.name = name;
    this.systemPrompt = systemPrompt;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.contextMessages = contextMessages;
  }

  /**
   * Build an agent with its past already in it. Hydration is async and a
   * constructor cannot be, so this is the way to get a resumed conversation.
   *
   * @param {object} params - The constructor options.
   * @returns {Promise<Agent>}
   */
  static async load({ provider, store, sessionId, ...options }) {
    const agent = new Agent({ provider, store, sessionId, ...options });
    const conversation = await store.load(sessionId);
    agent.#history = conversation?.messages ?? [];
    if (conversation?.usage) agent.#usage = { ...conversation.usage };
    return agent;
  }

  /**
   * Take one user turn and produce one assistant turn.
   *
   * @param {string} userInput
   * @returns {Promise<{ text: string, meta: object }>}
   */
  async run(userInput) {
    const text = typeof userInput === "string" ? userInput.trim() : "";
    if (!text) throw new Error("Agent.run() needs a non-empty message");

    const startedAt = Date.now();
    const userMessage = { role: "user", content: text };
    this.#history.push(userMessage);

    // The exact array that goes on the wire — measured and sent, so the
    // "tokens sent" figure can never drift from what was actually sent.
    const payload = this.#payload();

    const [requestTokens, sentTokens] = await Promise.all([
      this.#count({ messages: [userMessage] }),
      this.#count({ system: this.systemPrompt, messages: payload }),
    ]);

    let result;
    try {
      result = await this.#callWithRetry(payload);
    } catch (err) {
      // Don't leave a dangling user turn behind after a failure.
      this.#history.pop();
      throw err;
    }

    const ms = Date.now() - startedAt;
    const inputTokens = result.usage?.inputTokens ?? null;
    const outputTokens = result.usage?.outputTokens ?? null;
    const cost = estimateCost({ model: result.model, inputTokens, outputTokens });
    const truncated = result.stopReason === "max_tokens";

    const tokens = {
      request: requestTokens,
      sent: sentTokens,
      input: inputTokens,
      output: outputTokens,
      total: sum(inputTokens, outputTokens),
    };

    userMessage.tokens = { request: requestTokens };
    this.#history.push({
      role: "assistant",
      content: result.text,
      tokens,
      cost: { input: cost.inputCost, output: cost.outputCost, total: cost.totalCost },
      model: result.model,
      ms,
      stopReason: result.stopReason,
      ...(truncated ? { truncated: true } : {}),
    });

    this.#usage = {
      totalInputTokens: this.#usage.totalInputTokens + (inputTokens ?? 0),
      totalOutputTokens: this.#usage.totalOutputTokens + (outputTokens ?? 0),
      totalCostUsd: this.#usage.totalCostUsd + (cost.totalCost ?? 0),
      turnCount: this.#usage.turnCount + 1,
    };

    try {
      // The whole conversation goes to the store, never the cropped view.
      // Cropping is what the model sees; the store is what the agent knows.
      await this.#store.save(this.sessionId, this.#history, this.#usage);
    } catch (err) {
      // A store that is down is a degraded agent, not a lost reply.
      console.error("[agent] could not persist the conversation:", err);
    }

    return {
      text: result.text,
      meta: {
        agent: this.name,
        model: result.model,
        ms,
        stopReason: result.stopReason,
        truncated,
        tokens,
        cost: { input: cost.inputCost, output: cost.outputCost, total: cost.totalCost },
        window: {
          contextMessages: this.contextMessages,
          droppedCount: this.droppedCount,
          storedMessages: this.#history.length,
        },
      },
    };
  }

  /** Forget the conversation so far, here and in the store. */
  async reset() {
    this.#history = [];
    this.#usage = { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, turnCount: 0 };
    await this.#store.clear(this.sessionId);
  }

  /** A copy of the conversation so far — callers cannot mutate our state. */
  get transcript() {
    return this.#history.map((turn) => ({ ...turn }));
  }

  /** Cumulative token and cost totals for this conversation. */
  get usage() {
    return { ...this.#usage };
  }

  /**
   * How many stored messages sit outside the window — remembered on disk,
   * invisible to the model. Counted in messages, not user turns, because
   * that is what the transcript shows. This number growing is the whole
   * demonstration.
   *
   * @returns {number}
   */
  get droppedCount() {
    return this.#windowStart();
  }

  /**
   * Where the window begins: the index of the `contextMessages`-th most
   * recent user message. Everything from there to the end is in view.
   *
   * The window is measured in user messages rather than in messages outright,
   * so it survives a model that answers in several parts — an assistant reply
   * can never push the user's own question out of the request that contains
   * it.
   */
  #windowStart() {
    const window = Math.max(1, Math.floor(this.contextMessages));
    let seen = 0;
    for (let i = this.#history.length - 1; i >= 0; i--) {
      if (this.#history[i].role !== "user") continue;
      if (++seen === window) return i;
    }
    return 0;
  }

  /**
   * The cropped view: the most recent `contextMessages` user messages and
   * every reply that followed them, stripped back to what a provider is
   * allowed to see. A window of 5 is five exchanges, so the payload is
   * typically nine or ten messages.
   */
  #payload() {
    return this.#history
      .slice(this.#windowStart())
      .map(({ role, content }) => ({ role, content }));
  }

  /**
   * Pre-flight measurement. It is free, but it is still a network call, and a
   * turn that works is worth more than a turn that is measured — so a failure
   * here costs us the number, not the reply.
   *
   * @returns {Promise<number | null>}
   */
  async #count({ system, messages }) {
    if (typeof this.#provider.countTokens !== "function") return null;
    try {
      const { inputTokens } = await this.#provider.countTokens({ system, messages });
      return typeof inputTokens === "number" ? inputTokens : null;
    } catch (err) {
      console.error("[agent] countTokens failed, continuing without it:", err?.message ?? err);
      return null;
    }
  }

  /**
   * Up to three attempts, backing off on failures that are worth retrying
   * (rate limits and server-side errors). Everything else fails immediately.
   */
  async #callWithRetry(messages) {
    let lastError;

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await this.#provider.complete({
          system: this.systemPrompt,
          messages,
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
}

/** Adds two counts, but only if we actually have both. */
function sum(a, b) {
  return typeof a === "number" && typeof b === "number" ? a + b : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
