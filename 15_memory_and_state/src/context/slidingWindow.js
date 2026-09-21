import { takeLastExchanges } from "./boundaries.js";
import { ContextStrategy, NO_OVERHEAD } from "./strategy.js";

/**
 * Crop and forget: the last N exchanges, nothing else.
 *
 * This is the cost floor. It has no state, it makes no calls of its own, and
 * whatever leaves the window is simply gone — the model will tell you it was
 * never told. Every other strategy is an argument that the recall is worth
 * more than the difference between its bill and this one, so it earns its
 * place in the registry by being the number the others are measured against.
 */
export class SlidingWindowStrategy extends ContextStrategy {
  /** @param {{ contextMessages?: number }} [params] */
  constructor({ contextMessages = 10 } = {}) {
    super();
    this.contextMessages = contextMessages;
  }

  get id() {
    return "sliding";
  }

  get label() {
    return "Sliding window";
  }

  get description() {
    return "The last N exchanges, verbatim. Everything older is gone — cheapest possible, and it forgets.";
  }

  async buildPayload({ history, systemPrompt }) {
    const { start, messages } = takeLastExchanges(history, this.contextMessages);
    const dropped = start;

    return {
      system: systemPrompt,
      messages,
      state: {},
      meta: {
        ...NO_OVERHEAD,
        note: dropped
          ? `no overhead — ${dropped} message${dropped === 1 ? "" : "s"} dropped and unrecoverable`
          : "no overhead — everything still fits in the window",
        droppedMessages: dropped,
      },
    };
  }

  panel() {
    return {
      kind: "none",
      title: "No auxiliary block",
      note:
        "Nothing rides along in the system prompt. Messages that leave the window are not " +
        "written down anywhere the model can reach, so anything established in them is gone " +
        "for good — that is the whole price of the cheapest payload you can send.",
    };
  }
}
