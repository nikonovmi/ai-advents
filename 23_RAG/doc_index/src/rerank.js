/**
 * **Second-stage relevance: a cross-encoder scores (query, passage) pairs.**
 *
 * Unlike the embedder, which turns query and chunk into vectors separately,
 * a cross-encoder reads both together and returns one logit per pair. That is
 * slower (one model pass per candidate) but much better at telling "about the
 * same topic" from "answers this question", so it re-orders the few dozen
 * candidates vector search brought back.
 *
 * Logits are mapped to 0–1 with a sigmoid, so a cutoff can be a plain number.
 *
 * `createReranker` wraps any raw `scoreRaw(query, passages) → logits` function,
 * so the tests can plug in a fake; `loadReranker` plugs in the real model.
 */

export const DEFAULT_RERANK_MODEL = "onnx-community/bge-reranker-v2-m3-ONNX";
/** `onnx/model_quantized.onnx` (int8), about a quarter of the fp32 weights. */
export const DEFAULT_RERANK_DTYPE = "q8";

export const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * @param {object} o
 * @param {string} o.modelId
 * @param {string} o.dtype
 * @param {(query: string, passages: string[]) => Promise<number[]>} o.scoreRaw - one logit per passage
 * @param {number} [o.batchSize] - 1 by default: the int8 model quantizes
 *   activations per batch, so a padded batch shifts every pair's logit (by up
 *   to ~0.3 in a test) depending on its neighbours. One pair per pass makes a
 *   chunk's score its own, and on CPU it was also the fastest (no padding).
 */
export function createReranker({ modelId, dtype, scoreRaw, batchSize = 1 }) {
  return {
    modelId,
    dtype,
    /** One 0–1 score per passage, in the given order. */
    async score(query, passages) {
      const out = [];
      for (let i = 0; i < passages.length; i += batchSize) {
        for (const logit of await scoreRaw(query, passages.slice(i, i + batchSize))) out.push(sigmoid(logit));
      }
      return out;
    },
  };
}

/** Passages longer than this many tokens are truncated; structural chunks stay under 500. */
const MAX_PAIR_TOKENS = 1024;

/**
 * The real model, loaded on the first call. The first run downloads it
 * (~570 MB quantized) into the transformers.js cache; later runs are offline.
 */
export async function loadReranker({ modelId = process.env.RERANK_MODEL || DEFAULT_RERANK_MODEL, dtype = process.env.RERANK_DTYPE || DEFAULT_RERANK_DTYPE } = {}) {
  const { AutoModelForSequenceClassification, AutoTokenizer } = await import("@huggingface/transformers");
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(modelId),
    AutoModelForSequenceClassification.from_pretrained(modelId, { dtype }),
  ]);
  const scoreRaw = async (query, passages) => {
    const inputs = tokenizer(new Array(passages.length).fill(query), {
      text_pair: passages,
      padding: true,
      truncation: true,
      max_length: MAX_PAIR_TOKENS,
    });
    const { logits } = await model(inputs);
    return Array.from(logits.data);
  };
  return createReranker({ modelId, dtype, scoreRaw });
}
