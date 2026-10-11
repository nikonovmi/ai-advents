import path from "node:path";
import { pathToFileURL } from "node:url";

import { docIndexDir } from "./config.js";
import { RetrievalError } from "./retriever.js";

/**
 * **The cross-encoder, from doc_index, loaded on the first reranked question.**
 *
 * Like the retriever: the module and the model are imported lazily, so the
 * server and the tests never load them. The first call loads the model (the
 * very first run also downloads it), logs one line, and every later call
 * reuses it. A failure is a `RetrievalError` with one readable sentence, and
 * is not cached, so the next question tries again.
 */

/**
 * @param {{ dir?: string, log?: (line: string) => void }} [options]
 * @returns {{ score(query: string, passages: string[]): Promise<number[]>, ready(): boolean }}
 */
export function createReranker({ dir = docIndexDir(), log = console.log } = {}) {
  let loading = null;
  let ready = false;
  const load = () =>
    (loading ??= (async () => {
      const startedAt = Date.now();
      const { loadReranker } = await import(pathToFileURL(path.join(dir, "src", "rerank.js")).href);
      const reranker = await loadReranker();
      ready = true;
      log(`[rag] reranker ready: ${reranker.modelId} (${reranker.dtype}) in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
      return reranker;
    })().catch((err) => {
      loading = null;
      throw err;
    }));

  return {
    ready: () => ready,
    async score(query, passages) {
      try {
        return await (await load()).score(query, passages);
      } catch (err) {
        if (err?.code === "ERR_MODULE_NOT_FOUND") {
          throw new RetrievalError("doc_index is not installed next to first-agent, or is older than Day 23. Run: cd doc_index && npm install", { cause: err });
        }
        throw new RetrievalError("Reranking failed: " + String(err?.message ?? err).split("\n")[0].slice(0, 200), { cause: err });
      }
    },
  };
}

/** What doc_index loads unless `RERANK_MODEL` says otherwise; named here for the report. */
export const DEFAULT_RERANK_MODEL = process.env.RERANK_MODEL || "onnx-community/bge-reranker-v2-m3-ONNX";

let shared;
/** The one real reranker per process. */
export function sharedReranker() {
  return (shared ??= createReranker());
}
