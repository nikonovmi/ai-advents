import { Summarizer } from "../summarizer.js";
import { exchangeStarts, foldTo, snapToUserMessage, toWire } from "./boundaries.js";
import { ContextStrategy, NO_OVERHEAD, overheadFrom } from "./strategy.js";

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
 * A running summary in the system prompt, plus everything since its edge.
 *
 * This is the scheme the previous version built, relocated and otherwise
 * untouched. `contextMessages` is a **high-water mark** rather than a sliding
 * window: verbatim exchanges pile up until there are that many, and then the
 * oldest half of them is folded into the summary in one go.
 *
 * **The two edges touch, and that is the whole point.** `summarizedThrough` is
 * both where the summary ends and where the verbatim messages begin, so every
 * stored message is either folded in or on the wire. There is never a turn
 * where a message is in neither — which is exactly the hole a "crop now,
 * summarise eventually" design leaves open, and it swallows the most recent of
 * the dropped messages, the ones most likely to still matter.
 *
 * The edge is also what makes the scheme incremental (the Summarizer only ever
 * sees the previous summary plus the exchanges being folded now) and
 * idempotent (a turn that does not move the edge changes nothing).
 */
export class SummarizationStrategy extends ContextStrategy {
  #summarizer;
  #cachedFor = null;

  /**
   * @param {object} [params]
   * @param {number} [params.contextMessages]
   * @param {number | null} [params.foldSize] - How many exchanges each fold
   *   takes, if you want something other than half the window.
   * @param {string} [params.model] - Send compression to a cheaper model.
   * @param {import("../summarizer.js").Summarizer} [params.summarizer]
   */
  constructor({ contextMessages = 10, foldSize = null, model, summarizer } = {}) {
    super();
    this.contextMessages = contextMessages;
    this.foldSize = foldSize;
    this.model = model;
    this.#summarizer = summarizer ?? null;
  }

  get id() {
    return "summary";
  }

  get label() {
    return "Rolling summary";
  }

  get description() {
    return "Old exchanges are folded into a running summary in the system prompt. One extra call every window/2 turns.";
  }

  emptyState() {
    return { summary: null, summarizedThrough: 0, summaryUpdatedAt: null };
  }

  /**
   * How many exchanges each compression folds in — half the window, rounded
   * down, unless told otherwise.
   *
   * Half is the useful default because it makes compression self-pacing: fold
   * too little and it runs almost every turn, fold too much and the verbatim
   * region collapses to nothing right after each one. Halving means the region
   * oscillates between half the window and the whole of it, and the summarizer
   * runs once per half-window of conversation rather than once per turn.
   *
   * That coupling is also the cost dial, and it runs the wrong way from
   * intuition: **halving the window doubles how often you pay for compression.**
   */
  get fold() {
    const explicit = Number(this.foldSize);
    if (Number.isFinite(explicit) && explicit >= 1) return Math.floor(explicit);
    return Math.max(1, Math.floor(this.contextMessages / 2));
  }

  async buildPayload({ history, systemPrompt, state, provider, model }) {
    // The edge is an index into a history that came off disk — or, since
    // branching, one that was copied from a parent branch and may reach past
    // the end of this one. It is snapped and clamped rather than trusted: a
    // stale edge must not be able to make the payload open on an assistant turn.
    const current = {
      ...this.emptyState(),
      ...state,
      summarizedThrough: snapToUserMessage(history, state?.summarizedThrough ?? 0),
    };

    const compressed = await this.#maybeCompress({ history, state: current, provider, model });
    const next = compressed.state;
    const start = Math.min(Math.max(0, next.summarizedThrough), history.length);

    return {
      system: systemPrompt + summaryBlock(next.summary),
      messages: toWire(history.slice(start)),
      state: next,
      meta: {
        ...(compressed.overhead ?? NO_OVERHEAD),
        note: compressed.ran
          ? `folded ${compressed.foldedExchanges} exchange${compressed.foldedExchanges === 1 ? "" : "s"} into the summary`
          : next.summary
            ? "no overhead this turn — the summary already covers everything older"
            : "no overhead yet — nothing has reached the fold mark",
        droppedMessages: start,
        summarizedThrough: next.summarizedThrough,
        foldedThisTurn: compressed.ran,
        foldedMessages: compressed.foldedMessages ?? 0,
        foldedExchanges: compressed.foldedExchanges ?? 0,
        verbatimExchanges: exchangeStarts(history, start).length,
      },
    };
  }

  panel(state) {
    const summary = state?.summary ?? null;
    return {
      kind: "summary",
      title: "Summary",
      text: summary,
      covers: state?.summarizedThrough ?? 0,
      updatedAt: state?.summaryUpdatedAt ?? null,
      note: summary
        ? ""
        : "Nothing has been summarized yet — no exchange has reached the fold mark.",
    };
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
   * Failure is deliberately non-fatal. If the summarizer throws we keep the
   * previous summary and leave the edge where it was — so the same exchanges
   * are still verbatim, the model can still see them, and the fold is simply
   * retried next turn.
   */
  async #maybeCompress({ history, state, provider, model }) {
    const held = exchangeStarts(history, state.summarizedThrough).length;
    // A window of one cannot fold anything and still have a question left to
    // answer, so two is the smallest mark that means anything.
    const mark = Math.max(2, Math.floor(this.contextMessages));
    if (held < mark) return { ran: false, state };

    const boundary = foldTo(history, state.summarizedThrough, this.fold);
    if (boundary <= state.summarizedThrough) return { ran: false, state };

    const from = state.summarizedThrough;
    const foldedExchanges = held - exchangeStarts(history, boundary).length;
    const slice = toWire(history.slice(from, boundary));

    const startedAt = Date.now();
    try {
      const result = await this.#summarizerFor(provider).summarize({
        previousSummary: state.summary,
        messages: slice,
      });

      return {
        ran: true,
        state: {
          summary: result.text,
          summarizedThrough: boundary,
          summaryUpdatedAt: new Date().toISOString(),
        },
        foldedMessages: slice.length,
        foldedExchanges,
        overhead: overheadFrom({
          usage: result.usage,
          model: result.model ?? model,
          ms: result.ms ?? Date.now() - startedAt,
        }),
      };
    } catch (err) {
      console.error(
        "[summary] summarization failed, keeping the previous summary:",
        err?.message ?? err
      );
      return {
        ran: false,
        state,
        overhead: { ...NO_OVERHEAD, overheadMs: Date.now() - startedAt },
      };
    }
  }

  /**
   * The default summarizer speaks to the same provider the conversation does.
   * Passing one in is how you send compression to a cheaper model, or hand the
   * strategy a fake in a test.
   */
  #summarizerFor(provider) {
    if (this.#summarizer && this.#cachedFor === null) return this.#summarizer;
    if (this.#cachedFor !== provider) {
      this.#summarizer = new Summarizer({ provider, model: this.model });
      this.#cachedFor = provider;
    }
    return this.#summarizer;
  }
}
