import { estimateCost } from "./llm/pricing.js";
import { LlmError } from "./llm/provider.js";
import { Summarizer } from "./summarizer.js";

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
 * A short message used only to measure a system prompt. `countTokens` needs at
 * least one message, so the summary block cannot be weighed on its own — it is
 * weighed as the difference two counts of the same payload make.
 */
const PROBE_MESSAGE = { role: "user", content: "." };

/**
 * Wrap the running summary for the system prompt.
 *
 * It goes in the system string and not in the messages array on purpose. As an
 * assistant message a third-person digest ("the user's dog is called Barnaby")
 * would read to the model as something it had said out loud, and it would
 * answer in that register. As part of the system prompt it reads as briefing
 * material, which is what it is.
 *
 * An absent summary produces an empty string, never an empty header: a heading
 * with nothing under it invites the model to invent what belongs there.
 *
 * @param {string | null | undefined} summary
 * @returns {string}
 */
export function summaryBlock(summary) {
  const text = String(summary ?? "").trim();
  if (!text) return "";
  return [
    "",
    "",
    "<conversation_summary>",
    "Summary of earlier parts of this conversation, which are no longer shown in full:",
    text,
    "</conversation_summary>",
  ].join("\n");
}

/**
 * Where the window begins: the index of the `contextMessages`-th most recent
 * user message. Everything from there to the end is in view.
 *
 * The window is measured in user messages rather than in messages outright, so
 * it survives a model that answers in several parts — an assistant reply can
 * never push the user's own question out of the request that contains it.
 *
 * Two boundary rules are enforced here rather than trusted to that arithmetic:
 *
 *   1. **The window must open on a user message.** The API rejects a `messages`
 *      array whose first entry is an assistant turn. Any crop that counts
 *      messages instead of turns lands on one about half the time, so this is
 *      an intermittent 400 waiting to happen.
 *   2. **A turn pair is never split.** A user message whose reply is outside
 *      the window, or a reply whose question is, is worse than not sending
 *      either: the model reads half an exchange as a whole one.
 *
 * Both come out of the same move — walk the boundary back to the user message
 * that opens the turn it landed inside.
 *
 * It is a free function, not a method, because the boundary rules are the part
 * most worth testing and a private method cannot be tested from outside.
 *
 * @param {{ role: string }[]} history
 * @param {number} contextMessages
 * @returns {number} Index into `history`; everything before it is out of view.
 */
export function windowStart(history, contextMessages) {
  const turns = Math.max(1, Math.floor(contextMessages));
  let start = 0;
  let seen = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "user") continue;
    if (++seen === turns) {
      start = i;
      break;
    }
  }

  while (start > 0 && history[start].role !== "user") start--;

  // A history that opens with an assistant turn has no earlier edge to snap
  // back to. Walking forward to the first user message loses a message the
  // model would otherwise have seen; sending a payload the API refuses loses
  // the whole turn.
  if (history.length && history[start].role !== "user") {
    const firstUser = history.findIndex((message) => message.role === "user");
    return firstUser === -1 ? history.length : firstUser;
  }

  return start;
}

/**
 * The index of every user message at or after `from` — one per exchange, since
 * an exchange is a user message and everything that answers it.
 *
 * @param {{ role: string }[]} history
 * @param {number} [from]
 * @returns {number[]}
 */
export function exchangeStarts(history, from = 0) {
  const starts = [];
  for (let i = Math.max(0, from); i < history.length; i++) {
    if (history[i].role === "user") starts.push(i);
  }
  return starts;
}

/**
 * Where the summary's edge moves when the oldest `exchanges` exchanges after
 * `from` are folded into it.
 *
 * The result is always the index of a user message, which is what keeps the
 * two boundary rules true for free: the verbatim messages that follow it open
 * on a user turn, and no exchange is ever cut in half. It also never advances
 * past the last exchange — the turn being answered right now is never folded
 * away underneath the answer.
 *
 * @param {{ role: string }[]} history
 * @param {number} from - The current edge of the summary.
 * @param {number} exchanges - How many to fold in.
 * @returns {number} The new edge.
 */
export function foldTo(history, from, exchanges) {
  const starts = exchangeStarts(history, from);
  const fold = Math.min(Math.max(0, Math.floor(exchanges)), Math.max(0, starts.length - 1));
  return fold === 0 ? from : starts[fold];
}

/**
 * A conversational agent: it owns a persona and a rolling conversation
 * history, and it delegates every model call to an injected provider and
 * every read or write of that history to an injected store.
 *
 * It has no idea which vendor is behind that provider, no idea how or where
 * the store keeps a conversation, and no idea that HTTP requests exist.
 *
 * What it sends is assembled from three zones: the system prompt with the
 * running summary appended, the recent exchanges verbatim, and the new user
 * message. Everything older than the second zone exists only as the summary.
 *
 * The two edges touch. `contextMessages` is a high-water mark rather than a
 * sliding window: verbatim exchanges pile up until there are that many, and
 * then the oldest half of them is folded into the summary. Nothing is ever
 * dropped and left waiting to be summarised later, so there is no window of
 * turns where a message is in neither zone — which is exactly the hole a
 * "crop now, summarise eventually" design leaves open, and it swallows the
 * most recent of the dropped messages, the ones most likely to still matter.
 */
export class Agent {
  #provider;
  #store;
  #summarizer;
  /** @type {import("./store/conversationStore.js").StoredMessage[]} */
  #history = [];
  /** @type {import("./store/conversationStore.js").ConversationUsage} */
  #usage = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    turnCount: 0,
    summarizerInputTokens: 0,
    summarizerOutputTokens: 0,
    summarizerCostUsd: 0,
  };
  /** @type {string | null} */
  #summary = null;
  /**
   * How far into `#history` the summary reaches. Everything before this index
   * is folded in; everything after it is either still summarisable or still in
   * the window. This index is what makes compression incremental (only the
   * gap is ever sent to the Summarizer) and idempotent (a turn that does not
   * move it changes nothing).
   */
  #summarizedThrough = 0;
  /** @type {string | null} */
  #summaryUpdatedAt = null;

  /**
   * @param {object} params
   * @param {import("./llm/provider.js").LlmProvider} params.provider
   * @param {import("./store/conversationStore.js").ConversationStore} params.store
   * @param {string} params.sessionId - Which conversation this agent is.
   * @param {string} [params.name]
   * @param {string} [params.systemPrompt]
   * @param {number} [params.temperature]
   * @param {number} [params.maxTokens]
   * @param {number} [params.contextMessages] - The high-water mark, in
   *   exchanges: verbatim messages accumulate until there are this many user
   *   messages among them, at which point the oldest half is folded in.
   *   Because the fold size is half of it, this also sets how often the
   *   summarizer runs — once every `contextMessages / 2` turns. A small window
   *   is therefore an expensive one.
   * @param {number | null} [params.summarizeEvery] - How many exchanges each
   *   compression folds in, if you want something other than half the window.
   *   Null (the default) means half, rounded down.
   * @param {boolean} [params.compressionEnabled] - False behaves exactly like
   *   the previous version: crop and forget, no summary written and none sent.
   * @param {import("./summarizer.js").Summarizer} [params.summarizer]
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
    summarizeEvery = null,
    compressionEnabled = true,
    summarizer,
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
    // The default summarizer speaks to the same provider the conversation
    // does. Passing one in is how you send compression to a cheaper model, or
    // hand the agent a fake in a test.
    this.#summarizer = summarizer ?? new Summarizer({ provider });
    this.sessionId = sessionId;
    this.name = name;
    this.systemPrompt = systemPrompt;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.contextMessages = contextMessages;
    this.summarizeEvery = summarizeEvery;
    this.compressionEnabled = compressionEnabled;
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
    if (conversation?.usage) agent.#usage = { ...agent.#usage, ...conversation.usage };
    // A summary that did not survive a restart would be a summary that has to
    // be paid for again, so it is loaded with the same care as the messages.
    agent.#summary = conversation?.summary ?? null;
    // The edge is an index into a history that came off disk, so it is snapped
    // back to an exchange boundary rather than trusted. A file written by a
    // different version — or edited by hand — must not be able to make the
    // payload open on an assistant turn.
    agent.#summarizedThrough = snapToExchange(agent.#history, conversation?.summarizedThrough ?? 0);
    agent.#summaryUpdatedAt = conversation?.summaryUpdatedAt ?? null;
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

    // Compression runs before the main call, not after it, so this turn is
    // answered with a summary that already includes everything folded in this
    // turn. The alternative — summarise afterwards — means every turn reasons
    // from a summary one compression out of date.
    const compressed = await this.#maybeCompress();
    const start = this.#verbatimStart();

    // The exact system string and message array that go on the wire — measured
    // and sent, so the "tokens sent" figure can never drift from what was
    // actually sent.
    const system = this.#system();
    const payload = this.#payload(start);
    const injecting = system !== this.systemPrompt;

    const [requestTokens, sentTokens, withoutSummary] = await Promise.all([
      this.#count({ messages: [userMessage] }),
      this.#count({ system, messages: payload }),
      injecting ? this.#count({ system: this.systemPrompt, messages: payload }) : null,
    ]);
    const summaryTokens = injecting ? difference(sentTokens, withoutSummary) : 0;

    let result;
    try {
      result = await this.#callWithRetry({ system, messages: payload });
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

    const compression = {
      enabled: this.compressionEnabled,
      summaryTokens,
      summarizedMessages: this.#summarizedThrough,
      compressedThisTurn: compressed.ran,
      foldedMessages: compressed.folded ?? 0,
      foldedExchanges: compressed.foldedExchanges ?? 0,
      summarizerTokens: compressed.tokens ?? 0,
      summarizerCost: compressed.cost ?? null,
      summarizerMs: compressed.ms ?? null,
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
      compression,
      ...(truncated ? { truncated: true } : {}),
    });

    this.#usage = {
      ...this.#usage,
      totalInputTokens: this.#usage.totalInputTokens + (inputTokens ?? 0),
      totalOutputTokens: this.#usage.totalOutputTokens + (outputTokens ?? 0),
      totalCostUsd: this.#usage.totalCostUsd + (cost.totalCost ?? 0),
      turnCount: this.#usage.turnCount + 1,
    };

    try {
      // The whole conversation goes to the store, never the cropped view.
      // Cropping is what the model sees; the store is what the agent knows.
      await this.#store.save(this.sessionId, this.#history, this.#usage, {
        summary: this.#summary,
        summarizedThrough: this.#summarizedThrough,
        summaryUpdatedAt: this.#summaryUpdatedAt,
      });
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
        tokens: { ...tokens, compression },
        cost: { input: cost.inputCost, output: cost.outputCost, total: cost.totalCost },
        window: {
          contextMessages: this.contextMessages,
          droppedCount: this.droppedCount,
          storedMessages: this.#history.length,
          summarizedThrough: this.#summarizedThrough,
          verbatimExchanges: exchangeStarts(this.#history, start).length,
          foldSize: this.foldSize,
        },
        summary: { text: this.#summary, updatedAt: this.#summaryUpdatedAt },
      },
    };
  }

  /** Forget the conversation so far, here and in the store. */
  async reset() {
    this.#history = [];
    this.#usage = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      turnCount: 0,
      summarizerInputTokens: 0,
      summarizerOutputTokens: 0,
      summarizerCostUsd: 0,
    };
    this.#summary = null;
    this.#summarizedThrough = 0;
    this.#summaryUpdatedAt = null;
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

  /** The running summary, or null if nothing has been compressed yet. */
  get summary() {
    return this.#summary;
  }

  /** How many messages the summary currently stands in for. */
  get summarizedThrough() {
    return this.#summarizedThrough;
  }

  /**
   * How many exchanges each compression folds in — half the window, rounded
   * down, unless `summarizeEvery` says otherwise.
   *
   * Half is the useful default because it makes compression self-pacing: fold
   * too little and it runs almost every turn, fold too much and the verbatim
   * region collapses to nothing right after each one. Halving means the region
   * oscillates between half the window and the whole of it, and the summarizer
   * runs once per half-window of conversation rather than once per turn.
   */
  get foldSize() {
    const explicit = Number(this.summarizeEvery);
    if (Number.isFinite(explicit) && explicit >= 1) return Math.floor(explicit);
    return Math.max(1, Math.floor(this.contextMessages / 2));
  }

  /** How many exchanges are currently being sent verbatim. */
  get verbatimExchanges() {
    return exchangeStarts(this.#history, this.#verbatimStart()).length;
  }

  /**
   * What the summary block costs to inject, measured rather than guessed.
   *
   * `countTokens` needs a message to weigh a system prompt against, so this is
   * the difference the block makes to one small payload. It returns a promise:
   * the count comes from the provider, and there is no honest synchronous
   * answer to give.
   *
   * @returns {Promise<number | null>} Null when the provider cannot count.
   */
  get summaryTokens() {
    if (!this.#summary) return Promise.resolve(0);
    return Promise.all([
      this.#count({ system: this.#system(true), messages: [PROBE_MESSAGE] }),
      this.#count({ system: this.systemPrompt, messages: [PROBE_MESSAGE] }),
    ]).then(([withBlock, without]) => difference(withBlock, without));
  }

  /**
   * How many stored messages are not sent verbatim — remembered on disk, and
   * visible to the model only through the summary. Counted in messages, not
   * exchanges, because that is what the transcript shows.
   *
   * With compression on this is exactly `#summarizedThrough`: every message
   * before the edge is in the summary and every message after it is on the
   * wire. Nothing sits in between.
   *
   * @returns {number}
   */
  get droppedCount() {
    return this.#verbatimStart();
  }

  /**
   * Where zone 2 begins.
   *
   * With compression on, that is the summary's own edge — the two meet, and
   * the verbatim region is however much has piled up since the last fold.
   * With it off there is no summary to meet, so the previous version's sliding
   * window is used instead and the comparison between the two stays honest.
   */
  #verbatimStart() {
    if (!this.compressionEnabled) return windowStart(this.#history, this.contextMessages);
    return Math.min(Math.max(0, this.#summarizedThrough), this.#history.length);
  }

  /**
   * Zone 1: the persona, with the summary appended under its own header.
   *
   * With compression switched off the summary is not sent even if one exists,
   * so the comparison in the UI is between this version and the previous one
   * rather than between two flavours of this one.
   *
   * @param {boolean} [force] - Ignore the switch; used for measurement.
   */
  #system(force = false) {
    if (!force && !this.compressionEnabled) return this.systemPrompt;
    return this.systemPrompt + summaryBlock(this.#summary);
  }

  /**
   * Zones 2 and 3: every exchange since the summary's edge, plus the new user
   * message, stripped back to what a provider is allowed to see.
   */
  #payload(start = this.#verbatimStart()) {
    return this.#history.slice(start).map(({ role, content }) => ({ role, content }));
  }

  /**
   * Fold the oldest half of the verbatim region into the summary, once the
   * region has grown to the full window.
   *
   * The trigger is the size of what is being sent, not the age of what has
   * been dropped — there is nothing dropped to age. A message goes straight
   * from "sent verbatim" to "in the summary" with no turn in between where it
   * is neither.
   *
   * Failure here is deliberately non-fatal. The summary is an optimisation; the
   * user's message is not. If the summarizer throws we keep the previous
   * summary, leave `#summarizedThrough` where it was — so the same exchanges
   * are still verbatim and the fold is simply retried next turn — and answer
   * the turn anyway.
   *
   * @returns {Promise<{ ran: boolean, folded?: number, foldedExchanges?: number, ms?: number, tokens?: number, cost?: number | null }>}
   */
  async #maybeCompress() {
    if (!this.compressionEnabled) return { ran: false };

    const held = exchangeStarts(this.#history, this.#summarizedThrough).length;
    // A window of one cannot fold anything and still have a question left to
    // answer, so two is the smallest mark that means anything.
    const mark = Math.max(2, Math.floor(this.contextMessages));
    if (held < mark) return { ran: false };

    const boundary = foldTo(this.#history, this.#summarizedThrough, this.foldSize);
    if (boundary <= this.#summarizedThrough) return { ran: false };

    const from = this.#summarizedThrough;
    const foldedExchanges = exchangeStarts(this.#history, from).length -
      exchangeStarts(this.#history, boundary).length;
    const slice = this.#history
      .slice(from, boundary)
      .map(({ role, content }) => ({ role, content }));

    const startedAt = Date.now();
    try {
      const { text, usage, model, ms } = await this.#summarizer.summarize({
        previousSummary: this.#summary,
        messages: slice,
      });

      this.#summary = text;
      this.#summarizedThrough = boundary;
      this.#summaryUpdatedAt = new Date().toISOString();

      const cost = estimateCost({
        model,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      });
      this.#usage = {
        ...this.#usage,
        summarizerInputTokens: this.#usage.summarizerInputTokens + (usage?.inputTokens ?? 0),
        summarizerOutputTokens: this.#usage.summarizerOutputTokens + (usage?.outputTokens ?? 0),
        summarizerCostUsd: this.#usage.summarizerCostUsd + (cost.totalCost ?? 0),
      };

      return {
        ran: true,
        folded: slice.length,
        foldedExchanges,
        ms: ms ?? Date.now() - startedAt,
        tokens: sum(usage?.inputTokens, usage?.outputTokens) ?? 0,
        cost: cost.totalCost,
      };
    } catch (err) {
      console.error(
        "[agent] summarization failed, keeping the previous summary:",
        err?.message ?? err
      );
      return { ran: false, ms: Date.now() - startedAt };
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

/**
 * The nearest exchange boundary at or before `index`, so a stored edge always
 * names a user message.
 */
function snapToExchange(history, index) {
  const at = Math.min(Math.max(0, Math.floor(Number(index) || 0)), history.length);
  if (at === 0 || at === history.length) return at;
  let i = at;
  while (i > 0 && history[i].role !== "user") i--;
  return i;
}

/** Adds two counts, but only if we actually have both. */
function sum(a, b) {
  return typeof a === "number" && typeof b === "number" ? a + b : null;
}

/** Subtracts two counts, but only if we actually have both. */
function difference(a, b) {
  return typeof a === "number" && typeof b === "number" ? a - b : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
