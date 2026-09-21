import { DEFAULT_STRATEGY, createStrategy, isStrategyId } from "./context/index.js";
import { exchangeStarts, takeLastExchanges } from "./context/boundaries.js";
import { estimateCost } from "./llm/pricing.js";
import { LlmError } from "./llm/provider.js";
import {
  MAIN_BRANCH,
  appendMessage,
  deleteBranch,
  describeBranch,
  emptyBranch,
  forkBranch,
  getBranchHistory,
} from "./store/branches.js";
import { emptyUsage } from "./store/conversationStore.js";

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
 * A conversational agent: it owns a persona and a branching conversation
 * history, and it delegates every model call to an injected provider, every
 * read or write of that history to an injected store, and every decision about
 * *what goes on the wire* to an injected context strategy.
 *
 * It has no idea which vendor is behind that provider, no idea how or where
 * the store keeps a conversation, no idea that HTTP requests exist — and,
 * since the strategies were pulled out, no idea whether the model is being
 * sent a summary, a table of facts, the last ten exchanges or everything ever
 * said. It hands the strategy a history and receives a payload.
 *
 * The strategy's `state` passes through this class untouched and uninspected.
 * That is the whole point of the split: a fifth strategy is a new file and a
 * line in the registry, not a new branch in `run()`.
 */
export class Agent {
  #provider;
  #store;
  /** @type {import("./context/strategy.js").ContextStrategy} */
  #strategy;
  /**
   * The pool, the branch map and the pointer to the live branch — the shape
   * `branches.js` operates on, held in one object so those helpers can take it
   * whole rather than three arguments that must agree.
   */
  #record = {
    messages: [],
    branches: { [MAIN_BRANCH]: emptyBranch() },
    activeBranchId: MAIN_BRANCH,
  };
  /** @type {import("./store/conversationStore.js").ConversationUsage} */
  #usage = emptyUsage();

  /**
   * @param {object} params
   * @param {import("./llm/provider.js").LlmProvider} params.provider
   * @param {import("./store/conversationStore.js").ConversationStore} params.store
   * @param {string} params.sessionId - Which conversation this agent is.
   * @param {string} [params.name]
   * @param {string} [params.systemPrompt]
   * @param {number} [params.temperature]
   * @param {number} [params.maxTokens]
   * @param {number} [params.contextMessages] - The window, in exchanges. What
   *   it means is the strategy's business: a hard crop for `sliding` and
   *   `facts`, a high-water mark for `summary`, and nothing at all for `full`.
   * @param {string | import("./context/strategy.js").ContextStrategy} [params.strategy]
   *   A registry id, or an instance — which is how a test injects a fake.
   * @param {object} [params.strategyOptions] - Passed to the registry when a
   *   strategy is named rather than handed over.
   */
  constructor({
    provider,
    store,
    sessionId,
    name = "Assistant",
    systemPrompt = personas.helpful,
    temperature = 0.7,
    maxTokens = 1024,
    contextMessages = 10,
    strategy = DEFAULT_STRATEGY,
    strategyOptions = {},
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
    this.strategyOptions = strategyOptions;
    /**
     * Whose long-term memory the next turn writes to, or null for the
     * strategy's own default. Set per request by the route, the same way the
     * window and the token ceiling are — the Agent does not know what a
     * profile is, only that the strategy might.
     */
    this.profileUser = strategyOptions.user ?? null;
    /**
     * Which project's invariants the next turn is subject to, or null for the
     * strategy's own default. A live control like the profile and the window:
     * the Agent does not know what an invariant is, only that the strategy
     * might, and the record is what remembers the answer between sessions.
     */
    this.project = strategyOptions.project ?? null;
    this.strategy = strategy;
  }

  /**
   * The strategy is validated exactly the way the provider is: a name has to
   * be one the registry knows, and an object has to have the two methods. An
   * agent that accepted an unknown strategy would fail on the first turn, with
   * the user's message already appended.
   */
  set strategy(value) {
    if (typeof value === "string") {
      if (!isStrategyId(value)) {
        throw new Error(`Agent got an unknown context strategy: "${value}"`);
      }
      // Re-creating on every assignment would throw away a strategy's cached
      // summarizer or extractor for no reason.
      if (this.#strategy?.id !== value) {
        this.#strategy = createStrategy(value, {
          contextMessages: this.contextMessages,
          ...this.strategyOptions,
        });
      }
      return;
    }
    if (!value || typeof value.buildPayload !== "function" || typeof value.afterTurn !== "function") {
      throw new Error("Agent requires a strategy with buildPayload() and afterTurn() methods");
    }
    this.#strategy = value;
  }

  /** @returns {import("./context/strategy.js").ContextStrategy} */
  get strategy() {
    return this.#strategy;
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
    if (conversation) {
      agent.#record = {
        messages: conversation.messages ?? [],
        branches: conversation.branches ?? { [MAIN_BRANCH]: emptyBranch() },
        activeBranchId: conversation.activeBranchId ?? MAIN_BRANCH,
      };
    }
    if (conversation?.usage) agent.#usage = { ...agent.#usage, ...conversation.usage };
    // The record remembers which project this conversation belongs to, so
    // reopening it does not silently put it under another set of rules.
    if (conversation?.project) agent.project = conversation.project;
    return agent;
  }

  /**
   * Take one user turn on one branch and produce one assistant turn.
   *
   * The shape is always the same five steps, whichever strategy is loaded:
   * read the branch, ask the strategy for a payload, call the model, append
   * the reply, let the strategy update its state.
   *
   * @param {string} userInput
   * @param {{ branchId?: string }} [options]
   * @returns {Promise<{ text: string, meta: object }>}
   */
  async run(userInput, { branchId = this.#record.activeBranchId } = {}) {
    const text = typeof userInput === "string" ? userInput.trim() : "";
    if (!text) throw new Error("Agent.run() needs a non-empty message");

    const branch = this.#record.branches[branchId];
    if (!branch) throw new Error(`No such branch: ${branchId}`);

    const startedAt = Date.now();
    const strategy = this.#strategy;
    // Live controls in the UI, so they are pushed onto the strategy per turn
    // rather than frozen into it at construction.
    strategy.contextMessages = this.contextMessages;
    // Optional on purpose: the Agent's contract with a strategy is still the
    // two methods it validates on assignment, and four of the five strategies
    // inherit a no-op for this one. Requiring it would make "has a profile"
    // part of what it means to be a strategy at all.
    strategy.useProfile?.(this.profileUser);
    strategy.useProject?.(this.project);

    const userMessage = appendMessage(this.#record, branchId, { role: "user", content: text });
    const history = getBranchHistory(this.#record, branchId);

    // Each branch owns its own state, and each strategy owns its own slot
    // inside that. Switching strategy mid-conversation therefore parks the old
    // one's state rather than discarding it — switching back is not a reset.
    const state = branch.strategyState[strategy.id] ?? strategy.emptyState();
    const built = await this.#buildPayload({ strategy, history, state });

    // The exact system string and message array that go on the wire — measured
    // and sent, so the "tokens sent" figure can never drift from what was
    // actually sent.
    const injecting = built.system !== this.systemPrompt;
    const [requestTokens, sentTokens, withoutBlock] = await Promise.all([
      this.#count({ messages: [{ role: "user", content: text }] }),
      this.#count({ system: built.system, messages: built.messages }),
      injecting ? this.#count({ system: this.systemPrompt, messages: built.messages }) : null,
    ]);
    const blockTokens = injecting ? difference(sentTokens, withoutBlock) : 0;

    let result;
    try {
      result = await this.#callWithRetry({ system: built.system, messages: built.messages });
    } catch (err) {
      // Don't leave a dangling user turn behind after a failure.
      this.#record.messages.pop();
      branch.headId = userMessage.parentId;
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

    const after = await this.#afterTurn({ strategy, state: built.state, text, reply: result.text });
    branch.strategy = strategy.id;
    branch.strategyState = { ...branch.strategyState, [strategy.id]: after.state };

    const strategyMeta = {
      id: strategy.id,
      label: strategy.label,
      overheadTokens: (built.meta.overheadTokens ?? 0) + (after.usage ? sum(after.usage.inputTokens, after.usage.outputTokens) ?? 0 : 0),
      overheadCost: addCosts(built.meta.overheadCost, after.cost),
      overheadMs: (built.meta.overheadMs ?? 0) + (after.ms ?? 0),
      overheadCalls: (built.meta.overheadCalls ?? 0) + (after.usage ? 1 : 0),
      blockTokens,
      note: built.meta.note ?? "",
      droppedMessages: built.meta.droppedMessages ?? 0,
      changedKeys: built.meta.changedKeys ?? [],
      degraded: Boolean(built.degraded),
    };

    userMessage.tokens = { request: requestTokens };
    const reply = appendMessage(this.#record, branchId, {
      role: "assistant",
      content: result.text,
      tokens,
      cost: { input: cost.inputCost, output: cost.outputCost, total: cost.totalCost },
      model: result.model,
      ms,
      stopReason: result.stopReason,
      strategy: strategyMeta,
      ...(truncated ? { truncated: true } : {}),
    });

    const overheadUsage = mergeUsage(built.meta.usage, after.usage);
    this.#usage = {
      ...this.#usage,
      totalInputTokens: this.#usage.totalInputTokens + (inputTokens ?? 0),
      totalOutputTokens: this.#usage.totalOutputTokens + (outputTokens ?? 0),
      totalCostUsd: this.#usage.totalCostUsd + (cost.totalCost ?? 0),
      turnCount: this.#usage.turnCount + 1,
      overheadInputTokens: this.#usage.overheadInputTokens + (overheadUsage.inputTokens ?? 0),
      overheadOutputTokens: this.#usage.overheadOutputTokens + (overheadUsage.outputTokens ?? 0),
      overheadCostUsd: this.#usage.overheadCostUsd + (strategyMeta.overheadCost ?? 0),
      overheadCalls: this.#usage.overheadCalls + strategyMeta.overheadCalls,
    };

    await this.#persist();

    const start = built.meta.droppedMessages ?? 0;
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
        strategy: {
          ...strategyMeta,
          panel: strategy.panel(after.state, { turns: this.#turnsOn(branchId) }),
        },
        window: {
          contextMessages: this.contextMessages,
          droppedCount: start,
          storedMessages: history.length + 1,
          verbatimExchanges: built.meta.verbatimExchanges ?? exchangeStarts(history, start).length,
          messagesSent: built.messages.length,
        },
        branch: {
          id: branchId,
          name: branch.name,
          userMessageId: userMessage.id,
          replyMessageId: reply.id,
        },
        branches: this.branches,
      },
    };
  }

  /** Forget the conversation so far, here and in the store. */
  async reset() {
    this.#record = {
      messages: [],
      branches: { [MAIN_BRANCH]: emptyBranch() },
      activeBranchId: MAIN_BRANCH,
    };
    this.#usage = emptyUsage();
    await this.#store.clear(this.sessionId);
  }

  // ---- branches ------------------------------------------------------------

  /** Which branch a plain `run()` goes to. */
  get activeBranchId() {
    return this.#record.activeBranchId;
  }

  /** Every branch, described for the routes and the UI. */
  get branches() {
    return Object.keys(this.#record.branches).map((id) => describeBranch(this.#record, id));
  }

  /** The strategy a branch was last spoken to with. */
  branchStrategy(branchId = this.#record.activeBranchId) {
    return this.#record.branches[branchId]?.strategy ?? DEFAULT_STRATEGY;
  }

  /** A copy of one branch's conversation — callers cannot mutate our state. */
  history(branchId = this.#record.activeBranchId) {
    return getBranchHistory(this.#record, branchId).map((turn) => ({ ...turn }));
  }

  /** The active branch's conversation so far. */
  get transcript() {
    return this.history();
  }

  /**
   * Fork at a message. The new branch replays everything up to it and carries
   * a *copy* of the parent's strategy state, so the two can diverge without
   * either one seeing the other's facts.
   */
  async fork({ fromMessageId, name } = {}) {
    const branch = forkBranch(this.#record, { fromMessageId, name });
    await this.#persist();
    return describeBranch(this.#record, branch.id);
  }

  async activateBranch(branchId) {
    if (!this.#record.branches[branchId]) throw new Error("No such branch.");
    this.#record.activeBranchId = branchId;
    await this.#persist();
    return describeBranch(this.#record, branchId);
  }

  async removeBranch(branchId) {
    deleteBranch(this.#record, branchId);
    await this.#persist();
  }

  /** Cumulative token and cost totals for this conversation. */
  get usage() {
    return { ...this.#usage };
  }

  /** The strategy's own view of its state on a branch, for the right column. */
  /**
   * @param {string} [branchId]
   * @param {object} [context] - Anything the strategy's panel wants that only
   *   the caller could have read — the profile and the project's rules, for
   *   instance. Opaque here, exactly like `strategyState`: the Agent does not
   *   know what is in it, only that the strategy might.
   */
  panel(branchId = this.#record.activeBranchId, context = {}) {
    const branch = this.#record.branches[branchId];
    const id = branch?.strategy ?? this.#strategy.id;
    const state = branch?.strategyState?.[id];
    return createStrategy(id).panel(state ?? {}, { turns: this.#turnsOn(branchId), ...context });
  }

  /** How many exchanges a branch holds — the only thing a panel needs from us. */
  #turnsOn(branchId) {
    return exchangeStarts(getBranchHistory(this.#record, branchId)).length;
  }

  // ---- internals -----------------------------------------------------------

  /**
   * Ask the strategy for a payload, and survive it failing.
   *
   * A strategy handles its own expected failures internally — a summarizer
   * that times out, an extractor that returns nonsense — and degrades. This
   * catch is for the unexpected kind, and it degrades the same way: to the
   * plain window, which needs nothing and can always be built. A broken
   * strategy costs the turn its context, never the turn itself.
   */
  async #buildPayload({ strategy, history, state }) {
    try {
      const built = await strategy.buildPayload({
        history,
        systemPrompt: this.systemPrompt,
        state,
        provider: this.#provider,
        model: undefined,
      });
      return { ...built, meta: built.meta ?? {} };
    } catch (err) {
      console.error(`[agent] strategy "${strategy.id}" failed to build a payload:`, err?.message ?? err);
      const { start, messages } = takeLastExchanges(history, this.contextMessages);
      return {
        system: this.systemPrompt,
        messages,
        state,
        degraded: true,
        meta: {
          overheadTokens: 0,
          overheadCost: 0,
          overheadMs: 0,
          overheadCalls: 0,
          droppedMessages: start,
          note: `${strategy.id} failed — fell back to the last ${this.contextMessages} exchanges`,
        },
      };
    }
  }

  /** The same contract on the way out: a failure here loses state, not the reply. */
  async #afterTurn({ strategy, state, text, reply }) {
    try {
      const result = await strategy.afterTurn({
        history: getBranchHistory(this.#record, this.#record.activeBranchId),
        state,
        provider: this.#provider,
        model: undefined,
        userMessage: text,
        reply,
      });
      const usage = result?.usage ?? null;
      return {
        state: result?.state ?? state,
        usage,
        ms: result?.ms ?? 0,
        cost: usage
          ? estimateCost({
              model: undefined,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            }).totalCost
          : null,
      };
    } catch (err) {
      console.error(`[agent] strategy "${strategy.id}" failed after the turn:`, err?.message ?? err);
      return { state, usage: null, ms: 0, cost: null };
    }
  }

  /** The whole conversation goes to the store, never the cropped view. */
  async #persist() {
    try {
      await this.#store.save(this.sessionId, this.#record.messages, this.#usage, {
        branches: this.#record.branches,
        activeBranchId: this.#record.activeBranchId,
        project: this.project,
      });
    } catch (err) {
      // A store that is down is a degraded agent, not a lost reply.
      console.error("[agent] could not persist the conversation:", err);
    }
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
    if (!messages?.length) return null;
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
  async #callWithRetry({ system, messages }) {
    let lastError;

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await this.#provider.complete({
          system,
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

/** Subtracts two counts, but only if we actually have both. */
function difference(a, b) {
  return typeof a === "number" && typeof b === "number" ? a - b : null;
}

/**
 * Two costs added, where an unpriced model contributes nothing but must not
 * turn the other half into null — "we could not price one call" is not the
 * same claim as "this cost nothing".
 */
function addCosts(a, b) {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

function mergeUsage(a, b) {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
