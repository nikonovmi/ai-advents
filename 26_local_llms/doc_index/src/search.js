import { DEFAULT_DB_PATH, embedSettings } from "./config.js";
import { loadEmbedder } from "./embed.js";
import { openStore } from "./store.js";

/**
 * **Query → the k most similar chunks of one strategy.**
 *
 * Brute force: vectors are unit length, so the score is a dot product, and a
 * few thousand of them take well under a millisecond. Each strategy's vectors
 * are loaded into memory once, as one flat Float32Array, and reused.
 *
 * The query goes through the embedder's query prefix (see `embed.js`). An index
 * built with another model, dtype or dims is refused instead of searched.
 *
 * ```js
 * import { search } from "doc_index/src/search.js";
 * const hits = await search("how does the planner validate a plan?", { strategy: "structural", k: 5 });
 * // [{ score, chunk_id, source, section, collection, text, … }]
 * await search("what's new in Compose 1.8?", { k: 5, collections: ["knowledge"] });
 * ```
 */

/**
 * A searcher over one index file with one embedder (the tests pass a fake).
 * @param {{ dbPath?: string, embedder: ReturnType<import("./embed.js").createEmbedder> }} o
 */
export function createSearcher({ dbPath = DEFAULT_DB_PATH, embedder }) {
  const store = openStore(dbPath, { readonly: true });
  store.assertCompatible(embedder);
  const loaded = new Map();

  const load = (strategy) => {
    if (!loaded.has(strategy)) {
      const rows = store.chunksWithVectors(strategy);
      if (!rows.length) throw new Error(`no "${strategy}" chunks in ${dbPath}: run npm run index`);
      const dims = rows[0].vector.length;
      const matrix = new Float32Array(rows.length * dims);
      const chunks = rows.map(({ vector, ...chunk }, i) => {
        matrix.set(vector, i * dims);
        return chunk;
      });
      loaded.set(strategy, { chunks, matrix, dims });
    }
    return loaded.get(strategy);
  };

  return {
    meta: () => ({ embedding: store.getMeta("embedding"), chunker: store.getMeta("chunker") }),
    /**
     * `collections` (optional) keeps only chunks whose document is in one of
     * them (`knowledge`, `projects`, `downloads`); absent or empty means all.
     */
    async search(query, { strategy = "structural", k = 5, collections } = {}) {
      const { chunks, matrix, dims } = load(strategy);
      const only = collections?.length ? new Set(collections) : null;
      const q = await embedder.embedQuery(query);
      const scored = [];
      chunks.forEach((chunk, i) => {
        if (only && !only.has(chunk.collection)) return;
        let score = 0;
        const off = i * dims;
        for (let d = 0; d < dims; d++) score += q[d] * matrix[off + d];
        scored.push({ score, chunk });
      });
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, k).map(({ score, chunk }) => ({ ...chunk, score }));
    },
    close: () => store.close(),
  };
}

let defaultSearcher;
/**
 * The default searcher: `data/index.sqlite` and the real model, loaded on first
 * use. A failed load (no index yet, another model) is not cached, so the next
 * call tries again once the index is built.
 */
export async function search(query, options = {}) {
  defaultSearcher ??= loadEmbedder(embedSettings())
    .then((embedder) => createSearcher({ embedder }))
    .catch((err) => {
      defaultSearcher = undefined;
      throw err;
    });
  return (await defaultSearcher).search(query, options);
}
