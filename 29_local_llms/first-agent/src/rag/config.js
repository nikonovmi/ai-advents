import path from "node:path";

/**
 * **Retrieval settings for the Knowledge agent and `eval:rag`, from the environment.**
 *
 * | env | default | |
 * | --- | --- | --- |
 * | `RAG_K_FINAL` | 5 | chunks sent to the model (`RAG_K` is read as a fallback) |
 * | `RAG_K_RETRIEVE` | 20 | vector-search candidates when rerank is on (per query when rewriting) |
 * | `RAG_RERANK_THRESHOLD` | 0.02 | cutoff on the 0–1 rerank score (see `reports/rag_notes.md`) |
 * | `RAG_STRATEGY` | `structural` | `structural` or `fixed` (doc_index chunking) |
 * | `RAG_COLLECTIONS` | all | comma list: `knowledge`, `projects`, `downloads` |
 * | `RAG_MIN_SCORE` | off | drop chunks scoring below this (0–1) |
 * | `DOC_INDEX_DIR` | `../doc_index` | where the index project lives |
 */

export const PROJECT_DIR = path.join(import.meta.dirname, "..", "..");
export const REPORTS_DIR = path.join(PROJECT_DIR, "reports");
export const RAG_QUESTIONS_PATH = path.join(PROJECT_DIR, "eval", "rag", "questions.json");
export const STRATEGIES = ["structural", "fixed"];
/** Both modes answer with this ceiling, so a long answer is not a mode's advantage. */
export const RAG_MAX_TOKENS = 1024;
/**
 * The `submit_answer` call's ceiling. Its output is the answer plus a chunk_id
 * and a one-to-two-sentence quote per citation, so the same answer text takes
 * about twice the tokens of a Day 22 free-text reply.
 */
export const RAG_CONTRACT_MAX_TOKENS = 2048;

export function docIndexDir(env = process.env) {
  return path.resolve(PROJECT_DIR, env.DOC_INDEX_DIR || path.join("..", "doc_index"));
}

/**
 * Chosen once from the reranker's scores on doc_index's 20 retrieval questions
 * (not the answer eval); the numbers are in `reports/rag_notes.md`.
 */
export const DEFAULT_RERANK_THRESHOLD = 0.02;

const integer = (env, name, fallback, max = 50) => {
  const raw = env[name];
  const value = Number(raw || fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer from 1 to ${max}, got "${raw}"`);
  return value;
};

/**
 * @returns {{ kFinal: number, kRetrieve: number, rerankThreshold: number, strategy: string, collections: string[], minScore: number | null }}
 */
export function ragSettings(env = process.env) {
  const kFinal = env.RAG_K_FINAL ? integer(env, "RAG_K_FINAL", 5) : integer(env, "RAG_K", 5);
  const kRetrieve = integer(env, "RAG_K_RETRIEVE", 20, 100);
  if (kRetrieve < kFinal) throw new Error(`RAG_K_RETRIEVE (${kRetrieve}) must be at least RAG_K_FINAL (${kFinal})`);
  let rerankThreshold = DEFAULT_RERANK_THRESHOLD;
  if (env.RAG_RERANK_THRESHOLD !== undefined && env.RAG_RERANK_THRESHOLD !== "") {
    rerankThreshold = Number(env.RAG_RERANK_THRESHOLD);
    if (!(rerankThreshold >= 0 && rerankThreshold <= 1)) throw new Error(`RAG_RERANK_THRESHOLD must be a number from 0 to 1, got "${env.RAG_RERANK_THRESHOLD}"`);
  }
  const strategy = env.RAG_STRATEGY || "structural";
  if (!STRATEGIES.includes(strategy)) throw new Error(`RAG_STRATEGY must be one of ${STRATEGIES.join(", ")}, got "${strategy}"`);
  const collections = String(env.RAG_COLLECTIONS ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  let minScore = null;
  if (env.RAG_MIN_SCORE !== undefined && env.RAG_MIN_SCORE !== "") {
    minScore = Number(env.RAG_MIN_SCORE);
    if (!Number.isFinite(minScore)) throw new Error(`RAG_MIN_SCORE must be a number, got "${env.RAG_MIN_SCORE}"`);
  }
  return { kFinal, kRetrieve, rerankThreshold, strategy, collections, minScore };
}

/**
 * **The Day 25 chat's settings.**
 *
 * | env | default | |
 * | --- | --- | --- |
 * | `RAG_ROUTER_MODEL` | `claude-haiku-4-5-20251001` | the router's model (one forced `route` call per message) |
 * | `RAG_HISTORY_TURNS` | 6 | recent messages the router and the answering call see |
 *
 * @returns {{ routerModel: string, historyTurns: number }}
 */
export function chatSettings(env = process.env) {
  return {
    routerModel: env.RAG_ROUTER_MODEL || "claude-haiku-4-5-20251001",
    historyTurns: integer(env, "RAG_HISTORY_TURNS", 6, 40),
  };
}
