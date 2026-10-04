import { CHUNKER_CONFIG, STRATEGIES } from "./config.js";
import { chunkDocument } from "./chunkers/index.js";
import { PREFIXES } from "./embed.js";

/**
 * **Documents → chunks (per strategy) → vectors → the store.**
 *
 * Every run re-chunks from the documents (cheap) and replaces the strategy's
 * chunks, then embeds only the chunks whose `content_hash` has no cached vector
 * for this model/dtype/dims. So a run with no changes embeds nothing, and a
 * changed chunker config re-chunks everything but re-embeds only the texts that
 * actually changed.
 *
 * @param {object} o
 * @param {object[]} o.documents normalised documents (with `collection`)
 * @param {ReturnType<import("./embed.js").createEmbedder>} o.embedder
 * @param {ReturnType<import("./store.js").openStore>} o.store
 * @param {string[]} [o.strategies]
 * @param {boolean} [o.rebuild] drop everything first, the embedding cache too
 */
export async function buildIndex({ documents, embedder, store, strategies = STRATEGIES, rebuild = false, config = CHUNKER_CONFIG, log = console.log }) {
  const settings = { modelId: embedder.modelId, dtype: embedder.dtype, dims: embedder.dims };
  if (rebuild) {
    log("rebuild: dropping the index and the embedding cache");
    store.clear();
  }
  store.assertCompatible(settings);

  const storedChunker = store.getMeta("chunker") ?? {};
  store.replaceDocuments(documents);
  const embedStats = store.getMeta("embed_stats") ?? {};
  const summary = {};

  for (const strategy of strategies) {
    if (storedChunker[strategy] && JSON.stringify(storedChunker[strategy]) !== JSON.stringify(config[strategy])) {
      log(`${strategy}: chunker config changed (${JSON.stringify(storedChunker[strategy])} → ${JSON.stringify(config[strategy])}), rebuilding its chunks`);
    }
    const chunks = documents.flatMap((doc) => chunkDocument(doc, embedder.tokenizer, strategy, config));
    store.replaceChunks(strategy, chunks);

    const ready = [];
    const missing = new Map(); // content_hash → chunks sharing it
    for (const c of chunks) {
      const vector = store.cachedVector(c.content_hash, settings);
      if (vector) ready.push({ ...c, vector });
      else missing.set(c.content_hash, [...(missing.get(c.content_hash) ?? []), c]);
    }
    store.putVectors(ready, settings);

    const todo = [...missing.values()].map((group) => group[0]);
    if (todo.length) await embedder.ready(); // model loading is not embedding time
    const startedAt = performance.now();
    if (todo.length) {
      for (let i = 0; i < todo.length; i += embedder.batchSize) {
        const batch = todo.slice(i, i + embedder.batchSize);
        const vectors = await embedder.embedDocuments(batch);
        store.putVectors(
          batch.flatMap((c, j) => missing.get(c.content_hash).map((same) => ({ ...same, vector: vectors[j] }))),
          settings,
        );
        log(`${strategy} ${Math.min(i + batch.length, todo.length)}/${todo.length}`);
      }
    }
    const ms = Math.round(performance.now() - startedAt);
    const tokens = chunks.reduce((n, c) => n + c.token_count, 0);
    // Timing is only comparable when every chunk of the strategy was embedded.
    if (todo.length && todo.length === new Set(chunks.map((c) => c.content_hash)).size) {
      embedStats[strategy] = { chunks: todo.length, tokens: todo.reduce((n, c) => n + c.token_count, 0), ms, at: new Date().toISOString() };
    }
    summary[strategy] = { chunks: chunks.length, tokens, embedded: todo.length, cached: chunks.length - todo.length, ms };
    log(`${strategy}: ${chunks.length} chunks, ${todo.length} embedded, ${chunks.length - todo.length} from cache${todo.length ? ` (${(ms / 1000).toFixed(1)} s)` : ""}`);
    storedChunker[strategy] = config[strategy];
  }

  store.setMeta("embedding", { ...settings, prefixes: PREFIXES });
  store.setMeta("chunker", storedChunker);
  store.setMeta("embed_stats", embedStats);
  if (!store.getMeta("created_at")) store.setMeta("created_at", new Date().toISOString());
  store.setMeta("updated_at", new Date().toISOString());
  return summary;
}
