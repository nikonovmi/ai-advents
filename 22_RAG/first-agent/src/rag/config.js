import path from "node:path";

/**
 * **Retrieval settings for the Knowledge agent and `eval:rag`, from the environment.**
 *
 * | env | default | |
 * | --- | --- | --- |
 * | `RAG_K` | 5 | chunks per question |
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

export function docIndexDir(env = process.env) {
  return path.resolve(PROJECT_DIR, env.DOC_INDEX_DIR || path.join("..", "doc_index"));
}

/** @returns {{ k: number, strategy: string, collections: string[], minScore: number | null }} */
export function ragSettings(env = process.env) {
  const k = Number(env.RAG_K || 5);
  if (!Number.isInteger(k) || k < 1 || k > 50) throw new Error(`RAG_K must be an integer from 1 to 50, got "${env.RAG_K}"`);
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
  return { k, strategy, collections, minScore };
}
