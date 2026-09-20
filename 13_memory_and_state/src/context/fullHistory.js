import { toWire } from "./boundaries.js";
import { ContextStrategy, NO_OVERHEAD } from "./strategy.js";

/**
 * Everything, every turn.
 *
 * The recall ceiling and the cost baseline in one: nothing can remember more
 * than this, and nothing that re-sends the whole conversation on every turn
 * can be cheap. Its input grows linearly with the conversation and its
 * cumulative cost therefore grows quadratically, which is the curve the other
 * three exist to flatten.
 *
 * It is a real option, not a straw man. Below some length it is genuinely the
 * right answer, and knowing where that crossover falls is the only reason to
 * measure any of this.
 */
export class FullHistoryStrategy extends ContextStrategy {
  /**
   * The window is accepted and then ignored — nothing is cropped. Taking it
   * keeps the registry uniform: every strategy is built the same way.
   *
   * @param {{ contextMessages?: number }} [params]
   */
  constructor({ contextMessages = 10 } = {}) {
    super();
    this.contextMessages = contextMessages;
  }

  get id() {
    return "full";
  }

  get label() {
    return "Full history";
  }

  get description() {
    return "Every message, every turn. Perfect recall, and the bill grows with the square of the conversation.";
  }

  async buildPayload({ history, systemPrompt }) {
    return {
      system: systemPrompt,
      messages: toWire(history),
      state: {},
      meta: {
        ...NO_OVERHEAD,
        note: `no overhead — all ${history.length} message${history.length === 1 ? "" : "s"} sent`,
        droppedMessages: 0,
      },
    };
  }

  panel() {
    return {
      kind: "none",
      title: "No auxiliary block",
      note:
        "There is nothing to summarise or extract, because nothing is left out. The cost of that " +
        "is on the input side of every single turn: the whole conversation is re-sent and re-read " +
        "each time you say anything.",
    };
  }
}
