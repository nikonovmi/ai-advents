/**
 * The compressor.
 *
 * When messages fall out of the context window they are not thrown away — they
 * are folded into a running summary that rides along in the system prompt. This
 * class is the thing that does the folding, and like the Agent it is handed a
 * provider rather than knowing which vendor is behind it.
 *
 * Two properties matter more than the wording of the prompt below:
 *
 *   1. It is **incremental**. Each call sees the previous summary plus only the
 *      messages that have just left the window. Re-summarising the whole
 *      conversation every time would cost more than the cropping saves, which
 *      would defeat the point of doing it at all.
 *
 *   2. It is **structured**. A free-form paragraph is exactly the shape that
 *      loses "the port is 8080" and keeps "we discussed configuration". The
 *      sections below, and the instruction to preserve values verbatim, are
 *      what a recall test actually measures.
 */

/** The sections every summary comes back in, in this order. */
export const SUMMARY_SECTIONS = [
  "## Facts about the user",
  "## Decisions made",
  "## Preferences and constraints",
  "## Open questions",
  "## Discarded / superseded",
];

const SYSTEM_PROMPT = [
  "You maintain a running summary of a long conversation. The messages you are",
  "shown have scrolled out of the assistant's context window: after this call",
  "they are gone from the request forever, and your summary is the only thing",
  "standing in for them.",
  "",
  "You are given the summary so far and the messages that have just dropped out.",
  "Return the updated summary — the old material and the new material merged into",
  "one document. Do not append a changelog and do not describe what you changed.",
  "",
  "Return exactly these sections, in this order, and keep a section's header even",
  "when it has nothing under it (write '- none' in that case):",
  "",
  ...SUMMARY_SECTIONS,
  "",
  "Rules:",
  "- Keep names, numbers, file paths, versions, port numbers, dates and other",
  "  identifiers **exactly** as they were stated. Never round, rename or",
  "  paraphrase a specific value.",
  "- When you have to choose, drop narrative and keep the specific value. Nobody",
  "  ever needed to recall that the conversation 'moved on to deployment'; they",
  "  needed the hostname.",
  "- Prefer short bullets over sentences.",
  "- When new material contradicts or supersedes something already in the summary,",
  "  move the old version to '## Discarded / superseded' rather than deleting it,",
  "  so a later reversal is still answerable.",
  "- Write about the user in the third person ('the user'), never as if you were",
  "  quoting yourself.",
  "- Keep the whole thing under roughly 400 words. Compress the oldest, least",
  "  specific material first.",
].join("\n");

export class Summarizer {
  #provider;

  /**
   * @param {object} params
   * @param {import("./llm/provider.js").LlmProvider} params.provider
   * @param {string} [params.model] - Optional override; the provider's own
   *   model is used when this is absent. A cheaper model here is a reasonable
   *   trade, which is why it is a knob at all.
   * @param {number} [params.maxTokens]
   */
  constructor({ provider, model, maxTokens = 600 } = {}) {
    if (!provider || typeof provider.complete !== "function") {
      throw new Error("Summarizer requires a provider with a complete() method");
    }
    this.#provider = provider;
    this.model = model;
    this.maxTokens = maxTokens;
  }

  /**
   * Fold newly-dropped messages into the existing summary.
   *
   * The `usage` this returns is the summarizer's own consumption and is handed
   * straight back to the caller rather than swallowed: compression is not free,
   * and a number that is hidden is a number that gets forgotten when the saving
   * is claimed.
   *
   * @param {object} params
   * @param {string | null} [params.previousSummary]
   * @param {import("./llm/provider.js").Message[]} params.messages - Exactly the
   *   messages that have just left the window, oldest first.
   * @returns {Promise<{ text: string, usage: import("./llm/provider.js").Usage, model: string | null, ms: number }>}
   */
  async summarize({ previousSummary = null, messages = [] } = {}) {
    if (!messages.length) {
      throw new Error("Summarizer.summarize() needs at least one message to fold in");
    }

    const startedAt = Date.now();
    const result = await this.#provider.complete({
      model: this.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: promptFor(previousSummary, messages) }],
      // Nothing about this task benefits from variety, and a summary that
      // rewords itself every turn makes the panel in the UI flicker for no
      // reason.
      temperature: 0,
      maxTokens: this.maxTokens,
    });

    const text = String(result?.text ?? "").trim();
    if (!text) throw new Error("Summarizer got an empty summary back");

    return {
      text,
      usage: result.usage ?? { inputTokens: 0, outputTokens: 0 },
      model: result.model ?? null,
      ms: Date.now() - startedAt,
    };
  }
}

/** The one user message: what we had, and what has just fallen off the end. */
function promptFor(previousSummary, messages) {
  const previous = String(previousSummary ?? "").trim();
  return [
    "SUMMARY SO FAR:",
    previous || "(none — this is the first compression of this conversation)",
    "",
    `MESSAGES THAT HAVE JUST LEFT THE CONTEXT WINDOW (${messages.length}):`,
    ...messages.map((m) => `[${m.role}] ${m.content}`),
    "",
    "Return the updated summary.",
  ].join("\n");
}
