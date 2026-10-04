import { RAG_MAX_TOKENS, ragSettings } from "./config.js";
import { BASE_SYSTEM, RAG_SYSTEM, buildRagPrompt } from "./prompt.js";
import { RetrievalError, readableRetrievalError, sharedRetriever } from "./retriever.js";

/**
 * **One question, answered with RAG or without.** The Knowledge chat and
 * `eval:rag` both call this, so what the eval measures is what the chat does.
 *
 * - `plain`: `BASE_SYSTEM`, the history, the question. Search is never called.
 * - `rag`: search with the question alone (never the history), keep the hits
 *   at or above `minScore`, number them 1…n, and send `RAG_SYSTEM` plus the
 *   history plus `buildRagPrompt(question, chunks)` as the latest user message.
 *
 * Same model, max tokens and `temperature: 0` in both.
 */

const realSearch = (question, options) => sharedRetriever().search(question, options);

/** One line per retrieval, so a `minScore` can be picked from real numbers later. */
function logScores(log, question, hits, { k, strategy, minScore }) {
  const scores = hits.map((h) => h.score.toFixed(3)).join(" ");
  const kept = minScore == null ? "" : ` · minScore ${minScore} kept ${hits.filter((h) => h.score >= minScore).length}`;
  log(`[rag] ${strategy} k=${k} "${question.slice(0, 60)}" → ${scores || "no hits"}${kept}`);
}

/**
 * @param {string} question
 * @param {object} options
 * @param {"rag" | "plain"} [options.mode]
 * @param {Array<{ role: "user" | "assistant", content: string }>} [options.history] - short-term only
 * @param {number} [options.k]
 * @param {string} [options.strategy]
 * @param {string[]} [options.collections] - empty or absent: all
 * @param {number | null} [options.minScore] - null: off
 * @param {import("../llm/provider.js").LlmProvider} options.provider
 * @param {string} [options.model] - absent: the provider's default (what the chat agents use)
 * @param {number} [options.maxTokens]
 * @param {(question: string, o: object) => Promise<object[]>} [options.search] - tests pass a fake
 * @param {(line: string) => void} [options.log]
 */
export async function answerQuestion(question, options = {}) {
  const defaults = ragSettings();
  const {
    mode = "rag",
    history = [],
    k = defaults.k,
    strategy = defaults.strategy,
    collections = defaults.collections,
    minScore = defaults.minScore,
    provider,
    model,
    maxTokens = RAG_MAX_TOKENS,
    search = realSearch,
    log = console.log,
  } = options;
  if (mode !== "rag" && mode !== "plain") throw new Error(`mode must be "rag" or "plain", got "${mode}"`);
  if (!provider) throw new Error("answerQuestion needs a provider");

  let chunks = [];
  let retrieveMs = 0;
  let content = question;
  if (mode === "rag") {
    const startedAt = Date.now();
    let hits;
    try {
      hits = await search(question, { k, strategy, collections });
    } catch (err) {
      throw err instanceof RetrievalError ? err : new RetrievalError(readableRetrievalError(err), { cause: err });
    }
    retrieveMs = Date.now() - startedAt;
    logScores(log, question, hits, { k, strategy, minScore });
    chunks = hits
      .filter((hit) => minScore == null || hit.score >= minScore)
      .map((hit, i) => ({
        n: i + 1,
        score: hit.score,
        source: hit.source,
        section: hit.section ?? "",
        title: hit.title ?? "",
        chunk_id: hit.chunk_id,
        text: hit.text,
      }));
    content = buildRagPrompt(question, chunks);
  }

  const startedAt = Date.now();
  const completion = await provider.complete({
    system: mode === "rag" ? RAG_SYSTEM : BASE_SYSTEM,
    messages: [...history.map(({ role, content }) => ({ role, content })), { role: "user", content }],
    temperature: 0,
    maxTokens,
    ...(model ? { model } : {}),
  });

  return {
    answer: completion.text,
    mode,
    chunks,
    usage: completion.usage,
    model: completion.model,
    stopReason: completion.stopReason,
    timings: { retrieveMs, llmMs: Date.now() - startedAt },
  };
}
