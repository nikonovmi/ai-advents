import { DEFAULT_AGENT, agentFor, agentOf, isValidAgent } from "./agents.js";
import { DEFAULT_STRATEGY, createStrategy, isStrategyId } from "./context/index.js";
import { exchangeStarts, takeLastExchanges } from "./context/boundaries.js";
import { estimateCost } from "./llm/pricing.js";
import { emptyUsage, memoryOf, nextMessageId } from "./store/conversationStore.js";
import { completeWithRetry, runToolLoop } from "./toolLoop.js";

// Where they have always been imported from; the loop itself now lives in
// `toolLoop.js`, shared with the scheduled runner.
export { MAX_TOOL_ROUNDS, TOOL_ROUNDS_FALLBACK } from "./toolLoop.js";

/**
 * A conversational agent: it owns a persona and one conversation's history,
 * and it delegates every model call to an injected provider, every
 * read or write of that history to an injected store, and every decision about
 * *what goes on the wire* to an injected context strategy.
 *
 * It has no idea which vendor is behind that provider, no idea how or where
 * the store keeps a conversation, no idea that HTTP requests exist — and, since
 * the strategy was pulled out, no idea what the model is actually being sent.
 * It hands the strategy a history and receives a payload.
 *
 * The strategy's `state` passes through this class untouched and uninspected.
 * That is the whole point of the split: what memory is stays entirely inside
 * the strategy, and never becomes a branch in `run()`.
 */
export class Agent {
  #provider;
  #store;
  /** Where an agent with `mcpServers` gets and calls its tools. @type {import("./mcp/toolbox.js").McpToolbox | null} */
  #toolbox;
  /** @type {import("./context/strategy.js").ContextStrategy} */
  #strategy;
  /**
   * The conversation and the strategy's state for it, in one object because
   * they are saved and loaded together and must never disagree about which
   * conversation they belong to.
   */
  #record = { messages: [], memory: {} };
  /** @type {import("./store/conversationStore.js").ConversationUsage} */
  #usage = emptyUsage();

  /**
   * @param {object} params
   * @param {import("./llm/provider.js").LlmProvider} params.provider
   * @param {import("./store/conversationStore.js").ConversationStore} params.store
   * @param {string} params.sessionId - Which conversation this agent is.
   * @param {string} [params.name]
   * @param {string} [params.agentId] - Which agent answers. Its persona and its
   *   model come from the registry; an explicit `systemPrompt` overrides both,
   *   which is how a test pins a prompt without inventing an agent.
   * @param {string} [params.systemPrompt]
   * @param {number} [params.temperature]
   * @param {number} [params.maxTokens]
   * @param {number} [params.contextMessages] - The window, in exchanges. What
   *   it means is the strategy's business: for `memory` it is the high-water
   *   mark at which the oldest exchanges are folded into the digest.
   * @param {string | import("./context/strategy.js").ContextStrategy} [params.strategy]
   *   The strategy id, or an instance — which is how a test injects a fake.
   * @param {object} [params.strategyOptions] - Passed to the constructor when a
   *   strategy is named rather than handed over.
   * @param {{ toolsFor: Function, call: Function } | null} [params.toolbox] -
   *   The MCP tools, for an agent whose definition lists `mcpServers`. Any
   *   other agent never touches it.
   */
  constructor({
    provider,
    store,
    sessionId,
    name = "Assistant",
    agentId = DEFAULT_AGENT,
    systemPrompt,
    temperature = 0.7,
    maxTokens = 1024,
    contextMessages = 10,
    strategy = DEFAULT_STRATEGY,
    strategyOptions = {},
    toolbox = null,
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
    this.#toolbox = toolbox;
    this.sessionId = sessionId;
    this.name = name;
    /**
     * Which agent answers this conversation. Assigning it repoints the persona
     * and the model, because those *are* the agent — but only where no explicit
     * `systemPrompt` was given, which a test may do.
     */
    this.agentId = agentId;
    this.pinnedPrompt = typeof systemPrompt === "string" ? systemPrompt : null;
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
    /**
     * Which conversation this one was split off from, or null. Provenance only:
     * a fork holds its own copy of everything, so nothing here depends on the
     * parent still existing.
     * @type {{ conversationId: string, messageId: string } | null}
     */
    this.forkedFrom = null;
    this.strategy = strategy;
  }

  /**
   * The strategy is validated exactly the way the provider is: a name has to be
   * one that exists, and an object has to have the two methods. An agent that
   * accepted an unknown strategy would fail on the first turn, with the user's
   * message already appended.
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
   * The persona on the wire: the agent's, unless one was pinned at construction.
   *
   * Derived rather than stored because the agent is what is recorded, and a copy
   * of its prompt taken at construction would go stale the moment the registry
   * changed — silently, and only for conversations that happened to be cached.
   */
  get systemPrompt() {
    return this.pinnedPrompt ?? agentFor(this.agentId).systemPrompt;
  }

  set systemPrompt(value) {
    this.pinnedPrompt = typeof value === "string" ? value : null;
  }

  /** The model this agent asks for, or nothing — meaning the provider's own. */
  get model() {
    return agentFor(this.agentId).model;
  }

  /**
   * Let a request name the agent — but only while nothing has been said.
   *
   * "The record wins over the dropdown" protects a transcript from being
   * answered by two personas. An empty conversation has no transcript to
   * protect, and it can exist before its first message: the page opens a new
   * chat and asks for its panel before anything is sent, which builds and
   * caches an Agent with no agent named. Without this, that first request
   * decides, and the one that actually carries the choice is ignored.
   *
   * @param {unknown} wanted
   * @returns {boolean} Whether the agent changed.
   */
  adoptAgent(wanted) {
    if (this.#record.messages.length || !isValidAgent(wanted)) return false;
    const id = agentOf(wanted);
    if (id === this.agentId) return false;
    this.agentId = id;
    return true;
  }

  /** The MCP servers this agent opted into, by id. Usually none. */
  get mcpServers() {
    return agentFor(this.agentId).mcpServers ?? [];
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
        memory: memoryOf(conversation.memory),
      };
      agent.forkedFrom = conversation.forkedFrom ?? null;
    }
    if (conversation?.usage) agent.#usage = { ...agent.#usage, ...conversation.usage };
    // The record remembers which project this conversation belongs to, so
    // reopening it does not silently put it under another set of rules.
    if (conversation?.project) agent.project = conversation.project;
    // And which agent answered it. **The record wins over the caller**: the
    // transcript below was written by one persona, and letting a dropdown
    // repoint an existing conversation would make its two halves disagree.
    if (conversation?.agentId) agent.agentId = conversation.agentId;
    return agent;
  }

  /**
   * Take one user turn and produce one assistant turn.
   *
   * The shape is always the same five steps: read the history, ask the strategy
   * for a payload, call the model, append the reply, let the strategy update
   * its state.
   *
   * @param {string} userInput
   * @returns {Promise<{ text: string, meta: object }>}
   */
  async run(userInput) {
    const text = typeof userInput === "string" ? userInput.trim() : "";
    if (!text) throw new Error("Agent.run() needs a non-empty message");

    const startedAt = Date.now();
    const strategy = this.#strategy;
    // Live controls in the UI, so they are pushed onto the strategy per turn
    // rather than frozen into it at construction.
    strategy.contextMessages = this.contextMessages;
    // Optional on purpose: the Agent's contract with a strategy is still the
    // two methods it validates on assignment, and the base class inherits a
    // no-op for this one. Requiring it would make "has a profile" part of what
    // it means to be a strategy at all.
    strategy.useProfile?.(this.profileUser);
    strategy.useProject?.(this.project);

    const userMessage = this.#append({ role: "user", content: text });
    // Everything said so far, the new user message included. The strategy is
    // handed the real array for speed and must not mutate it.
    const history = this.#record.messages;

    const state = Object.keys(this.#record.memory).length
      ? this.#record.memory
      : strategy.emptyState();
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

    let answer;
    try {
      answer = await this.#answer({ system: built.system, messages: built.messages });
    } catch (err) {
      // Don't leave a dangling user turn behind after a failure.
      this.#record.messages.pop();
      throw err;
    }
    const { result, toolCalls, toolRounds, toolsCapped, toolsUnavailable } = answer;

    const ms = Date.now() - startedAt;
    // Every model call of the turn, tool rounds included: that is what it cost.
    const inputTokens = answer.usage.inputTokens;
    const outputTokens = answer.usage.outputTokens;
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
    /**
     * **The reply as it will be stored and shown.**
     *
     * A strategy may hand back the reply with its own bookkeeping taken out of
     * it, and `memory` does: it asks the answering model to close an answered
     * question on a fenced line at the end of the message, because that is the
     * only way to read the reply without paying for a second call to read it.
     * Those lines are addressed to the store, not to the reader, so what gets
     * appended and returned is what came back without them.
     *
     * Optional, like `useProfile`: a strategy that returns nothing here keeps
     * the reply exactly as the provider sent it. The Agent still does not know
     * what was taken out or why — only that the strategy is the one allowed to
     * say.
     */
    const replyText = typeof after.reply === "string" && after.reply.trim() ? after.reply : result.text;
    this.#record.memory = after.state;

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
    const reply = this.#append({
      role: "assistant",
      content: replyText,
      tokens,
      cost: { input: cost.inputCost, output: cost.outputCost, total: cost.totalCost },
      model: result.model,
      ms,
      stopReason: result.stopReason,
      strategy: strategyMeta,
      ...(truncated ? { truncated: true } : {}),
      // What the tools did, beside the text they informed. Never the raw
      // tool_use / tool_result blocks: the record stays a list of plain
      // user/assistant strings, which is what every boundary rule and the
      // digest fold assume.
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(toolsCapped ? { toolRoundsExceeded: true } : {}),
      ...(toolsUnavailable.length ? { toolsUnavailable } : {}),
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
      text: replyText,
      meta: {
        agent: this.name,
        model: result.model,
        ms,
        stopReason: result.stopReason,
        truncated,
        tokens,
        cost: { input: cost.inputCost, output: cost.outputCost, total: cost.totalCost },
        toolCalls,
        toolRounds,
        ...(toolsCapped ? { toolRoundsExceeded: true } : {}),
        ...(toolsUnavailable.length ? { toolsUnavailable } : {}),
        strategy: {
          ...strategyMeta,
          panel: strategy.panel(after.state, { turns: this.#turns() }),
        },
        window: {
          contextMessages: this.contextMessages,
          droppedCount: start,
          storedMessages: history.length,
          verbatimExchanges: built.meta.verbatimExchanges ?? exchangeStarts(history, start).length,
          messagesSent: built.messages.length,
        },
        turn: {
          userMessageId: userMessage.id,
          replyMessageId: reply.id,
        },
      },
    };
  }

  /** Forget the conversation so far, here and in the store. */
  async reset() {
    this.#record = { messages: [], memory: {} };
    this.#usage = emptyUsage();
    await this.#store.clear(this.sessionId);
  }

  /** A copy of the conversation — callers cannot mutate our state. */
  history() {
    return this.#record.messages.map((turn) => ({ ...turn }));
  }

  /** The conversation so far. */
  get transcript() {
    return this.history();
  }

  /** Cumulative token and cost totals for this conversation. */
  get usage() {
    return { ...this.#usage };
  }

  /**
   * The strategy's own view of its state, for the right column.
   *
   * @param {object} [context] - Anything the strategy's panel wants that only
   *   the caller could have read — the profile and the project's rules, for
   *   instance. Opaque here, exactly like the memory state: the Agent does not
   *   know what is in it, only that the strategy might.
   */
  panel(context = {}) {
    return this.#strategy.panel(this.#record.memory, { turns: this.#turns(), ...context });
  }

  /** How many exchanges the conversation holds — all a panel needs from us. */
  #turns() {
    return exchangeStarts(this.#record.messages).length;
  }

  /**
   * Append one message and give it an id. Sequential rather than random,
   * because these end up in a JSON file a person reads.
   */
  #append(message) {
    const stored = { ...message, id: nextMessageId(this.#record.messages) };
    this.#record.messages.push(stored);
    return stored;
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
        history: this.#record.messages,
        state,
        provider: this.#provider,
        model: undefined,
        userMessage: text,
        reply,
      });
      const usage = result?.usage ?? null;
      return {
        state: result?.state ?? state,
        reply: typeof result?.reply === "string" ? result.reply : null,
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
      // The reply is not the strategy's to lose. A failure here keeps the raw
      // text, fences and all: a visible artefact is a bug report, a swallowed
      // reply is a lost turn.
      return { state, reply: null, usage: null, ms: 0, cost: null };
    }
  }

  /** The whole conversation goes to the store, never the cropped view. */
  async #persist() {
    try {
      await this.#store.save(this.sessionId, this.#record.messages, this.#usage, {
        memory: this.#record.memory,
        project: this.project,
        agentId: this.agentId,
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
   * **One answer, however many model calls it takes.**
   *
   * An agent without MCP servers makes exactly the one call it always made.
   * One with them offers its tools and goes round the shared tool loop
   * (`toolLoop.js`): tool_use → tool_result → model, at most
   * `MAX_TOOL_ROUNDS` times. The extended messages live only in there. The
   * history gets the final text.
   */
  async #answer({ system, messages }) {
    const servers = this.mcpServers;
    const offered =
      servers.length && this.#toolbox ? await this.#toolbox.toolsFor(servers) : { tools: [], unavailable: [] };
    for (const { server, error } of offered.unavailable) {
      console.warn(`[agent] MCP server "${server}" is unavailable this turn: ${error}`);
    }

    const loop = await runToolLoop({
      complete: (request) => this.#callWithRetry(request),
      system,
      messages,
      tools: offered.tools,
      call: (name, input) => this.#toolbox.call(name, input),
    });
    return { ...loop, toolsUnavailable: offered.unavailable };
  }

  /**
   * Up to three attempts, backing off on failures that are worth retrying
   * (rate limits and server-side errors). Everything else fails immediately.
   */
  #callWithRetry({ system, messages, tools }) {
    return completeWithRetry(this.#provider, {
      system,
      messages,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      // Absent unless the agent asks for one, and the provider reads that
      // as "your default" rather than as a missing argument.
      model: this.model,
      // Absent unless the agent opted into MCP servers — the call is then
      // byte-for-byte the one it was before tools.
      ...(tools ? { tools } : {}),
    });
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
