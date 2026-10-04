import path from "node:path";
import { pathToFileURL } from "node:url";

import { docIndexDir } from "./config.js";

/**
 * **Retrieval: `search()` from doc_index, loaded on the first RAG question.**
 *
 * Nothing here ranks or embeds; it is doc_index's own `search()`, imported
 * lazily so that starting the server (and every test) never loads the
 * embedding model. The first call loads it (a few seconds), logs one line, and
 * every later call reuses it.
 *
 * Whatever goes wrong underneath — no index yet, an index built with another
 * model, doc_index not installed — comes out as a `RetrievalError` with one
 * sentence that says what to run, never a stack trace.
 */

export class RetrievalError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RetrievalError";
  }
}

/** The sentence a person sees for a retrieval failure. */
export function readableRetrievalError(err) {
  const message = String(err?.message ?? err ?? "");
  if (err?.name === "IndexMismatchError" || /different embedding settings/.test(message)) {
    const diff = /\(([^)]*)\)/.exec(message)?.[1];
    return `The document index was built with a different embedding model${diff ? ` (${diff})` : ""}. Rebuild it: cd doc_index && npm run index -- --rebuild`;
  }
  if (/no index at/.test(message)) return "The document index is missing. Build it first: cd doc_index && npm run index";
  if (/no "(\w+)" chunks/.test(message)) {
    return `The document index has no "${/no "(\w+)" chunks/.exec(message)[1]}" chunks. Build them: cd doc_index && npm run index`;
  }
  if (err?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find (package|module)/.test(message)) {
    return "doc_index is not installed next to first-agent. Run: cd doc_index && npm install && npm run index";
  }
  return "Retrieval failed: " + message.split("\n")[0].slice(0, 200);
}

/**
 * The real retriever, over doc_index's default index and model.
 *
 * @param {{ dir?: string, log?: (line: string) => void }} [options]
 * @returns {{ search(question: string, o: { k: number, strategy: string, collections?: string[] }): Promise<object[]>, ready(): boolean }}
 */
export function createRetriever({ dir = docIndexDir(), log = console.log } = {}) {
  let modules = null;
  let ready = false;
  const load = () =>
    (modules ??= Promise.all([
      import(pathToFileURL(path.join(dir, "src", "search.js")).href),
      import(pathToFileURL(path.join(dir, "src", "config.js")).href),
    ]).catch((err) => {
      modules = null;
      throw err;
    }));

  return {
    ready: () => ready,
    async search(question, { k, strategy, collections }) {
      const startedAt = Date.now();
      try {
        const [{ search }, { embedSettings }] = await load();
        const hits = await search(question, { k, strategy, collections });
        if (!ready) {
          ready = true;
          const { modelId, dtype, dims } = embedSettings();
          log(`[rag] embedding model ready: ${modelId} (${dtype}, ${dims} dims) in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
        }
        return hits;
      } catch (err) {
        throw new RetrievalError(readableRetrievalError(err), { cause: err });
      }
    },
  };
}

let shared;
/** The one real retriever per process: the model is loaded once and reused by every chat. */
export function sharedRetriever() {
  return (shared ??= createRetriever());
}
