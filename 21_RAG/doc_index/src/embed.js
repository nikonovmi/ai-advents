import { embedSettings } from "./config.js";

/**
 * **The only module that turns text into vectors.**
 *
 * EmbeddingGemma is trained with task prefixes, and it gives noticeably worse
 * neighbours without them, so they live here and nowhere else: a document is
 * embedded as `title: {title} | text: {text}`, a query as
 * `task: search result | query: {text}`. Nothing outside this file builds those
 * strings, and nothing can reach the model without going through them.
 *
 * Vectors come out L2-normalised, so cosine similarity is a dot product. With
 * `dims` below 768 the vector is truncated (the model is trained for Matryoshka
 * truncation) and normalised again.
 *
 * `createEmbedder` wraps any raw `embedRaw(strings) → number[][]` function, so
 * the tests can plug in a deterministic fake behind the exact same prefixes,
 * truncation and normalisation. `loadEmbedder` plugs in the real model.
 */

export const formatDocument = ({ title, text }) => `title: ${title?.trim() || "none"} | text: ${text}`;
export const formatQuery = (text) => `task: search result | query: ${text}`;

export const PREFIXES = Object.freeze({
  document: "title: {title} | text: {text}",
  query: "task: search result | query: {text}",
});

/** Truncate to `dims` and L2-normalise, into a fresh Float32Array. */
export function toUnitVector(values, dims) {
  const out = Float32Array.from(values.length > dims ? values.slice(0, dims) : values);
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/**
 * @param {object} o
 * @param {string} o.modelId
 * @param {string} o.dtype
 * @param {number} o.dims
 * @param {{ count(text: string): number }} o.tokenizer
 * @param {(strings: string[]) => Promise<ArrayLike<number>[]>} o.embedRaw
 * @param {number} [o.batchSize]
 * @param {() => Promise<void>} [o.ready] loads whatever embedRaw needs (the model weights)
 */
export function createEmbedder({ modelId, dtype, dims, tokenizer, embedRaw, batchSize = 16, ready = async () => {} }) {
  const embedStrings = async (strings, onBatch) => {
    const vectors = [];
    for (let i = 0; i < strings.length; i += batchSize) {
      const raw = await embedRaw(strings.slice(i, i + batchSize));
      for (const v of raw) vectors.push(toUnitVector(v, dims));
      onBatch?.(Math.min(i + batchSize, strings.length), strings.length);
    }
    return vectors;
  };
  return {
    modelId,
    dtype,
    dims,
    batchSize,
    tokenizer,
    ready,
    formatDocument,
    /** `docs`: [{ title, text }] → one Float32Array per doc, in order. */
    embedDocuments: (docs, { onBatch } = {}) => embedStrings(docs.map(formatDocument), onBatch),
    embedQuery: async (text) => (await embedStrings([formatQuery(text)]))[0],
  };
}

/** A tokenizer that counts the way the model will: no BOS/EOS. */
export function wrapTokenizer(hfTokenizer) {
  return {
    count: (text) => hfTokenizer.encode(text, { add_special_tokens: false }).length,
  };
}

let tokenizerPromise;
/** Just the EmbeddingGemma tokenizer (small, no model weights). */
export async function loadTokenizer(settings = embedSettings()) {
  tokenizerPromise ??= import("@huggingface/transformers").then(({ AutoTokenizer }) =>
    AutoTokenizer.from_pretrained(settings.modelId),
  );
  return wrapTokenizer(await tokenizerPromise);
}

/**
 * The real model, loaded once. The first embed downloads it into the
 * transformers.js cache; every later run works offline.
 */
export async function loadEmbedder(settings = embedSettings()) {
  const { AutoModel, AutoTokenizer } = await import("@huggingface/transformers");
  tokenizerPromise ??= AutoTokenizer.from_pretrained(settings.modelId);
  const hfTokenizer = await tokenizerPromise;
  // The weights load on the first embed, so a run that only needs to count
  // tokens (nothing changed) never pays for them.
  let model;
  const ready = () => (model ??= AutoModel.from_pretrained(settings.modelId, { dtype: settings.dtype }));
  const embedRaw = async (strings) => {
    const inputs = await hfTokenizer(strings, { padding: true, truncation: true });
    const { sentence_embedding } = await (await ready())(inputs);
    return sentence_embedding.tolist();
  };
  return createEmbedder({ ...settings, tokenizer: wrapTokenizer(hfTokenizer), embedRaw, ready: async () => void (await ready()) });
}
