import { estimateCost } from "../llm/pricing.js";

/**
 * The context-management abstraction.
 *
 * `LlmProvider` answers "who is the model?" and `ConversationStore` answers
 * "where does the conversation live?". This one answers the third question the
 * Agent should not have an opinion about: **given everything that has been
 * said, what actually goes on the wire?**
 *
 * A strategy owns two things and nothing else:
 *
 *   - `buildPayload` — turn a history into the exact system string and message
 *     array for this turn. It must never mutate `history`; the Agent hands it
 *     the real array for speed, and a strategy that edits it corrupts the
 *     conversation for every other strategy that will ever run on it.
 *   - `state` — whatever it needs to remember between turns. It is
 *     JSON-serialisable, it is owned by the strategy, it is persisted by the
 *     store, and it is never inspected by the Agent. That last part is what
 *     makes a fifth strategy a new file rather than a new `if`.
 *
 * Two rules hold for every implementation:
 *
 *   - **Strategy calls are billed separately.** A strategy that calls a model
 *     to do its own work reports that usage in its own `meta`, never folded
 *     into the conversation's totals. A saving whose cost has been added to
 *     the thing it is being compared against is not a measurement.
 *   - **Failure is non-fatal.** A summary that could not be written or facts
 *     that could not be extracted degrade the payload. They do not cost the
 *     user their turn. Log it, keep the previous state, answer anyway.
 */
export class ContextStrategy {
  /**
   * The window, in exchanges. A live control in the UI, so the Agent writes it
   * on the strategy before every turn rather than the strategy capturing it at
   * construction.
   */
  contextMessages = 10;

  /**
   * Whose long-term memory this turn belongs to.
   *
   * A live control in exactly the sense `contextMessages` is: the topbar can
   * change it between two turns of the same conversation, so the Agent pushes
   * it onto the strategy before every turn rather than the strategy capturing
   * it at construction. Four of the five strategies have no long-term memory
   * and no opinion about whose turn this is, so the default does nothing —
   * which is what keeps this one line out of `run()`'s list of special cases.
   *
   * @param {string | null} user
   */
  // eslint-disable-next-line no-unused-vars
  useProfile(user) {}

  /** @returns {"sliding" | "facts" | "summary" | "full"} */
  get id() {
    throw new Error("Not implemented");
  }

  /** @returns {string} Short human name, for the selector and the tables. */
  get label() {
    throw new Error("Not implemented");
  }

  /** @returns {string} One line under the selector: what it does and what it costs. */
  get description() {
    return "";
  }

  /**
   * Build this turn's request. Called after the new user message has been
   * appended to `history` and before the provider is called, so a strategy
   * that has work to do — folding, extracting — does it here and the turn is
   * answered with the result rather than with the previous turn's.
   *
   * @param {object} params
   * @param {import("../store/conversationStore.js").StoredMessage[]} params.history
   *   The whole branch, oldest first, new user message last. Read-only.
   * @param {string} params.systemPrompt - The persona, with nothing appended.
   * @param {object} params.state - This strategy's state for this branch.
   * @param {import("../llm/provider.js").LlmProvider} params.provider
   * @param {string} [params.model] - For the strategy's own calls, if it makes any.
   * @returns {Promise<{ system: string, messages: import("../llm/provider.js").Message[], state: object, meta: object }>}
   */
  // eslint-disable-next-line no-unused-vars
  async buildPayload({ history, systemPrompt, state, provider, model }) {
    throw new Error("Not implemented");
  }

  /**
   * A chance to update state now that the reply exists.
   *
   * The four strategies shipped here all do their work in `buildPayload`,
   * because a fact or a summary is only worth paying for if the turn that
   * established it can already see it. What is left for this hook is
   * bookkeeping that genuinely cannot be known before the answer — which is
   * why the default is to change nothing.
   *
   * @param {object} params
   * @param {import("../store/conversationStore.js").StoredMessage[]} params.history
   * @param {object} params.state
   * @param {import("../llm/provider.js").LlmProvider} params.provider
   * @param {string} [params.model]
   * @param {string} params.userMessage
   * @param {string} params.reply
   * @returns {Promise<{ state: object, usage: import("../llm/provider.js").Usage | null, ms: number }>}
   */
  // eslint-disable-next-line no-unused-vars
  async afterTurn({ history, state, provider, model, userMessage, reply }) {
    return { state, usage: null, ms: 0 };
  }

  /**
   * What this strategy's state looks like when nothing has happened yet.
   * @returns {object}
   */
  emptyState() {
    return {};
  }

  /**
   * The right-hand column, described by the only object that understands the
   * state: `{ kind, ... }`, where `kind` picks the renderer.
   *
   * Without this the Agent or the UI would have to reach into `state` and read
   * fields belonging to a specific strategy — exactly the coupling the state
   * being opaque is meant to prevent.
   *
   * @param {object} state
   * @param {{ turns?: number }} [context] - How many exchanges the branch being
   *   described actually holds. State is copied when a branch forks, so a
   *   strategy that stamps its entries needs this to tell what is really its
   *   own. The two that keep no state ignore it.
   * @returns {{ kind: string } & Record<string, unknown>}
   */
  // eslint-disable-next-line no-unused-vars
  panel(state, context) {
    return { kind: "none", note: "" };
  }
}

/** A turn on which the strategy did no work at all, and charged for none. */
export const NO_OVERHEAD = Object.freeze({
  overheadTokens: 0,
  overheadCost: 0,
  overheadMs: 0,
  overheadCalls: 0,
});

/**
 * One strategy call, priced. Every strategy that talks to a model reports its
 * bill through here, so the four of them cannot drift into four different
 * ideas of what "overhead" means.
 *
 * An unpriced model (the offline `FakeProvider`) gives a null cost and a real
 * token count — the shape the rest of the app already handles.
 *
 * @param {{ usage?: import("../llm/provider.js").Usage, model?: string, ms?: number, calls?: number }} params
 */
export function overheadFrom({ usage, model, ms = 0, calls = 1 } = {}) {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const cost = estimateCost({ model, inputTokens, outputTokens });
  return {
    overheadTokens: inputTokens + outputTokens,
    overheadCost: cost.totalCost,
    overheadMs: ms,
    overheadCalls: calls,
    usage: { inputTokens, outputTokens },
  };
}
