import { clarifyQuestion } from "./clarify.js";
import { RAG_CONTRACT_MAX_TOKENS, RAG_MAX_TOKENS, ragSettings } from "./config.js";
import { answerWithContract, dontKnowText } from "./contract.js";
import { BASE_SYSTEM, RAG_SYSTEM, buildRagPrompt } from "./prompt.js";
import { sharedReranker } from "./reranker.js";
import { RetrievalError, readableRetrievalError, sharedRetriever } from "./retriever.js";
import { rewriteQuery } from "./rewrite.js";

/**
 * **One question, answered with RAG or without.** The Knowledge chat and
 * `eval:rag` both call this, so what the eval measures is what the chat does.
 *
 * ```
 * question → [rewrite] → vector search (kRetrieve) → [rerank + cutoff] → top kFinal → LLM
 * ```
 *
 * - `plain`: `BASE_SYSTEM`, the history, the question. Search is never called.
 * - `rag`: search, keep the hits at or above `minScore`, number them 1…n, and
 *   send `RAG_SYSTEM` plus the history plus `buildRagPrompt(question, chunks)`
 *   as the latest user message. With both switches off this is Day 22 exactly:
 *   the question alone, top `kFinal` by vector score.
 *   - `rewrite`: one model call turns the question into 1–3 search queries;
 *     each is searched and the results are merged by `chunk_id` (best score).
 *   - `rerank`: `kRetrieve` candidates per query, scored by the cross-encoder
 *     against the **original** question; below `rerankThreshold` they are
 *     dropped, and the top `kFinal` of the rest go to the model. If none pass,
 *     the answering model is not called: one small call writes a clarifying
 *     question from the best rejected chunks (`clarify.js`), and the result is
 *     "I don't know" with `dontKnow.reason: "low_relevance"`.
 *
 * Every RAG answer goes through the contract of `contract.js`: a forced
 * `submit_answer` call with `[cN]` markers and verbatim quotes, verified in
 * code, retried once, then repaired or downgraded. Its sources are derived
 * from the cited chunk_ids. The model can also return `dont_know` itself
 * (`reason: "model"`), and a failed verification can end in one
 * (`"verification_failed"`). Plain mode is a free-text answer, as on Day 22.
 *
 * The answering model always gets the original question. Same model and
 * `temperature: 0` in every mode.
 */

const realSearch = (question, options) => sharedRetriever().search(question, options);
const realRerank = (query, passages) => sharedReranker().score(query, passages);
/** How many rejected candidates a declined answer shows. */
export const REJECTED_SHOWN = 3;

/** `plain`, `rag`, `rag+rerank`, `rag+rewrite`, `rag+rewrite+rerank`: the badge and the eval column. */
export function modeLabel({ mode = "rag", rerank = false, rewrite = false } = {}) {
  if (mode !== "rag") return "plain";
  return ["rag", rewrite && "rewrite", rerank && "rerank"].filter(Boolean).join("+");
}

/** The reverse: a label → the options it stands for, or null if it is not one. */
export function parseModeLabel(label) {
  if (label === "plain") return { mode: "plain", rerank: false, rewrite: false };
  const parts = String(label).split("+");
  if (parts[0] !== "rag" || parts.slice(1).some((p) => p !== "rerank" && p !== "rewrite")) return null;
  const options = { mode: "rag", rerank: parts.includes("rerank"), rewrite: parts.includes("rewrite") };
  return modeLabel(options) === label ? options : null;
}

/** One line per retrieval, so a cutoff can be picked from real numbers. */
function logScores(log, question, hits, { k, strategy, minScore }) {
  const scores = hits.map((h) => h.score.toFixed(3)).join(" ");
  const kept = minScore == null ? "" : ` · minScore ${minScore} kept ${hits.filter((h) => h.score >= minScore).length}`;
  log(`[rag] ${strategy} k=${k} "${question.slice(0, 60)}" → ${scores || "no hits"}${kept}`);
}

const addUsage = (a, b) => ({ inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0), outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0) });

/**
 * Every query's hits, merged by `chunk_id` with each chunk's best score, best
 * first. `queryIndex` is the query that gave the best score.
 */
export function mergeHits(lists) {
  const byId = new Map();
  lists.forEach((hits, queryIndex) => {
    for (const hit of hits) {
      const seen = byId.get(hit.chunk_id);
      if (!seen || hit.score > seen.score) byId.set(hit.chunk_id, { ...hit, queryIndex });
    }
  });
  return [...byId.values()].sort((a, b) => b.score - a.score);
}

/**
 * @param {string} question
 * @param {object} options
 * @param {"rag" | "plain"} [options.mode]
 * @param {boolean} [options.rerank] - cross-encoder + cutoff (rag only)
 * @param {boolean} [options.rewrite] - 1–3 search queries from one model call (rag only)
 * @param {Array<{ role: "user" | "assistant", content: string }>} [options.history] - short-term only
 * @param {number} [options.kFinal] - chunks sent to the model
 * @param {number} [options.kRetrieve] - vector candidates per query when reranking
 * @param {number} [options.rerankThreshold] - 0–1
 * @param {string} [options.strategy]
 * @param {string[]} [options.collections] - empty or absent: all
 * @param {number | null} [options.minScore] - on the vector score; null: off
 * @param {import("../llm/provider.js").LlmProvider} options.provider
 * @param {string} [options.model] - absent: the provider's default (what the chat agents use)
 * @param {number} [options.maxTokens]
 * @param {(question: string, o: object) => Promise<object[]>} [options.search] - tests pass a fake
 * @param {(query: string, passages: string[]) => Promise<number[]>} [options.rerankScores] - 0–1 per passage; tests pass a fake
 * @param {(question: string, o: object) => Promise<{ queries: string[], usage?: object }>} [options.rewriter] - tests pass a fake
 * @param {(line: string) => void} [options.log]
 * @param {string[]} [options.queries] - Day 25: the search queries, given (the router's); no rewrite call
 * @param {string} [options.rerankQuestion] - Day 25: what the reranker and the clarifying call see (the standalone question); default `question`
 * @param {string} [options.system] - Day 25: the answering system prompt; default `RAG_SYSTEM`
 * @param {(chunks: object[]) => string} [options.buildPrompt] - Day 25: the latest user message; default `buildRagPrompt(question, chunks)`
 */
export async function answerQuestion(question, options = {}) {
  const defaults = ragSettings();
  const {
    mode = "rag",
    rerank = false,
    rewrite = false,
    history = [],
    kFinal = defaults.kFinal,
    kRetrieve = defaults.kRetrieve,
    rerankThreshold = defaults.rerankThreshold,
    strategy = defaults.strategy,
    collections = defaults.collections,
    minScore = defaults.minScore,
    provider,
    model,
    maxTokens = RAG_MAX_TOKENS,
    search = realSearch,
    rerankScores = realRerank,
    rewriter = rewriteQuery,
    log = console.log,
    queries: givenQueries,
    rerankQuestion = question,
    system = RAG_SYSTEM,
    buildPrompt = (chunks) => buildRagPrompt(question, chunks),
  } = options;
  if (mode !== "rag" && mode !== "plain") throw new Error(`mode must be "rag" or "plain", got "${mode}"`);
  if (!provider) throw new Error("answerQuestion needs a provider");
  const isRag = mode === "rag";
  const useRerank = isRag && Boolean(rerank);
  const useRewrite = isRag && Boolean(rewrite) && !(Array.isArray(givenQueries) && givenQueries.length);

  const timings = { rewriteMs: 0, retrieveMs: 0, rerankMs: 0, clarifyMs: 0, llmMs: 0 };
  const usageByStage = { rewrite: null, clarify: null, llm: null };
  let queries = [];
  let candidates = [];
  let chunks = [];
  let rejected = [];
  let declined = false;
  let content = question;

  if (isRag) {
    // 1. rewrite
    queries = [question];
    if (Array.isArray(givenQueries) && givenQueries.length) {
      queries = givenQueries;
    } else if (useRewrite) {
      const startedAt = Date.now();
      const rewritten = await rewriter(question, { provider, model });
      timings.rewriteMs = Date.now() - startedAt;
      queries = rewritten.queries?.length ? rewritten.queries : [question];
      usageByStage.rewrite = rewritten.usage ?? null;
      log(`[rag] rewrite "${question.slice(0, 60)}" → ${queries.map((q) => JSON.stringify(q)).join(" · ")}`);
    }

    // 2. vector search, once per query
    const k = useRerank ? kRetrieve : kFinal;
    let startedAt = Date.now();
    const lists = [];
    try {
      for (const query of queries) {
        const hits = await search(query, { k, strategy, collections });
        logScores(log, query, hits, { k, strategy, minScore });
        lists.push(hits);
      }
    } catch (err) {
      throw err instanceof RetrievalError ? err : new RetrievalError(readableRetrievalError(err), { cause: err });
    }
    timings.retrieveMs = Date.now() - startedAt;
    const pool = mergeHits(lists)
      .filter((hit) => minScore == null || hit.score >= minScore)
      .map((hit, i) => ({ ...hit, vectorRank: i + 1 }));

    // 3. rerank + cutoff, against the original question
    let kept;
    if (useRerank) {
      startedAt = Date.now();
      let scores;
      try {
        scores = pool.length ? await rerankScores(rerankQuestion, pool.map((hit) => hit.text)) : [];
      } catch (err) {
        throw err instanceof RetrievalError ? err : new RetrievalError("Reranking failed: " + String(err?.message ?? err).split("\n")[0], { cause: err });
      }
      timings.rerankMs = Date.now() - startedAt;
      const ranked = pool.map((hit, i) => ({ ...hit, rerankScore: scores[i] })).sort((a, b) => b.rerankScore - a.rerankScore);
      kept = ranked.filter((hit) => hit.rerankScore >= rerankThreshold).slice(0, kFinal);
      const keptIds = new Set(kept.map((hit) => hit.chunk_id));
      candidates = ranked.map((hit, i) => ({ ...hit, rerankRank: i + 1, kept: keptIds.has(hit.chunk_id) }));
      log(`[rag] rerank threshold ${rerankThreshold} → ${ranked.map((h) => h.rerankScore.toFixed(3)).join(" ") || "no candidates"} · kept ${kept.length}`);
      if (!kept.length) {
        declined = true;
        rejected = ranked.slice(0, REJECTED_SHOWN).map(chunkOf);
      }
    } else {
      kept = pool.slice(0, kFinal);
      candidates = pool.map((hit, i) => ({ ...hit, rerankRank: null, kept: i < kFinal }));
    }
    chunks = kept.map((hit, i) => ({ n: i + 1, ...chunkOf(hit) }));
    candidates = candidates.map(({ chunk_id, source, section, score, rerankScore, vectorRank, rerankRank, kept: isKept, queryIndex }) => ({
      chunk_id,
      source,
      section: section ?? "",
      vectorScore: score,
      rerankScore: rerankScore ?? null,
      vectorRank,
      rerankRank,
      kept: isKept,
      ...(queries.length > 1 || useRewrite ? { query: queryIndex } : {}),
    }));
    content = buildPrompt(chunks);
  }

  const messages = [...history.map(({ role, content }) => ({ role, content })), { role: "user", content }];
  let completion = null;
  let contract = null;
  let clarifying = "";
  if (declined) {
    // Low relevance: no answering call, one small clarifying one.
    const startedAt = Date.now();
    const clarified = await clarifyQuestion(rerankQuestion, rejected, { provider, model });
    timings.clarifyMs = Date.now() - startedAt;
    usageByStage.clarify = clarified.usage;
    clarifying = clarified.clarifyingQuestion;
  } else if (isRag) {
    const startedAt = Date.now();
    contract = await answerWithContract({ provider, system, messages, chunks, model, maxTokens: maxTokens === RAG_MAX_TOKENS ? RAG_CONTRACT_MAX_TOKENS : maxTokens });
    timings.llmMs = Date.now() - startedAt;
    usageByStage.llm = contract.usage;
    const v = contract.verification;
    log(
      `[rag] contract ${contract.status}${contract.dontKnow ? ` (${contract.dontKnow.reason})` : ""} · ${contract.citations.length} citation(s)` +
        `${v.retried ? " · retried" : ""}${v.fabricatedFirstAttempt.length ? ` · ${v.fabricatedFirstAttempt.length} fabricated on attempt 1` : ""}` +
        `${v.droppedCitations.length ? ` · dropped ${v.droppedCitations.length}` : ""}${v.downgraded ? " · downgraded" : ""}`,
    );
  } else {
    const startedAt = Date.now();
    completion = await provider.complete({ system: BASE_SYSTEM, messages, temperature: 0, maxTokens, ...(model ? { model } : {}) });
    timings.llmMs = Date.now() - startedAt;
    usageByStage.llm = completion.usage ?? null;
  }

  const ragFields = !isRag
    ? {}
    : declined
      ? { status: "dont_know", citations: [], sources: [], clarifyingQuestion: clarifying, dontKnow: { reason: "low_relevance" }, verification: null }
      : {
          status: contract.status,
          citations: contract.citations,
          sources: contract.sources,
          clarifyingQuestion: contract.clarifyingQuestion,
          dontKnow: contract.dontKnow,
          verification: contract.verification,
        };
  const answer = !isRag ? completion.text : ragFields.status === "dont_know" ? dontKnowText(ragFields.clarifyingQuestion) : contract.answer;

  return {
    answer,
    mode,
    label: modeLabel({ mode, rerank: useRerank, rewrite: useRewrite }),
    rerank: useRerank,
    rewrite: useRewrite,
    queries,
    candidates,
    chunks,
    declined,
    rejected,
    ...ragFields,
    usage: addUsage(addUsage(usageByStage.rewrite, usageByStage.clarify), usageByStage.llm),
    usageByStage,
    model: completion?.model ?? contract?.model ?? provider.model ?? null,
    stopReason: completion?.stopReason ?? contract?.stopReason ?? "declined",
    timings,
  };
}

/** A hit as the model and the Sources panel see it. `rerankScore` only when reranked, so a Day 22 chunk is unchanged. */
function chunkOf(hit) {
  return {
    score: hit.score,
    ...(hit.rerankScore !== undefined ? { rerankScore: hit.rerankScore } : {}),
    source: hit.source,
    section: hit.section ?? "",
    title: hit.title ?? "",
    chunk_id: hit.chunk_id,
    text: hit.text,
  };
}
