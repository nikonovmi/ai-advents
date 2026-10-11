import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

/**
 * **Every path, setting and size in one place.**
 *
 * Paths are relative to this project (`doc_index/`), never absolute, so the
 * repo can live anywhere. Environment variables (all optional, see
 * `.env.example`) override the embedding settings and the knowledge folder.
 *
 * `CHUNKER_CONFIG` is stored with the index: when it changes, the next
 * `npm run index` re-chunks everything and drops the old chunks; only texts
 * whose embedded string really changed get embedded again.
 */

export const PROJECT_DIR = path.join(import.meta.dirname, "..");
dotenv.config({ path: path.join(PROJECT_DIR, ".env"), quiet: true });

export const SOURCES_PATH = path.join(PROJECT_DIR, "corpus", "sources.json");
export const RAW_DIR = path.join(PROJECT_DIR, "corpus", "raw");
export const PROJECTS_RAW_DIR = path.join(RAW_DIR, "projects");
export const DATA_DIR = path.join(PROJECT_DIR, "data");
export const DEFAULT_DB_PATH = path.join(DATA_DIR, "index.sqlite");
export const REPORTS_DIR = path.join(PROJECT_DIR, "reports");
export const QUESTIONS_PATH = path.join(PROJECT_DIR, "eval", "questions.json");

/** ~3,000 characters of text count as one page. */
export const CHARS_PER_PAGE = 3000;
export const MIN_CORPUS_PAGES = 30;

export const STRATEGIES = ["fixed", "structural"];

export const CHUNKER_CONFIG = Object.freeze({
  fixed: Object.freeze({ size: 300, overlap: 50 }),
  structural: Object.freeze({ minTokens: 40, maxTokens: 500 }),
});

export const DEFAULT_MODEL = "onnx-community/embeddinggemma-300m-ONNX";
export const DTYPES = ["q8", "fp32"];
export const DIMS = [768, 512, 256, 128];

/** The embedding settings, from the environment, validated. */
export function embedSettings(env = process.env) {
  const modelId = env.EMBED_MODEL || DEFAULT_MODEL;
  const dtype = env.EMBED_DTYPE || "q8";
  const dims = Number(env.EMBED_DIMS || 768);
  const batchSize = Number(env.EMBED_BATCH || 16);
  if (!DTYPES.includes(dtype)) {
    throw new Error(`EMBED_DTYPE must be one of ${DTYPES.join(", ")} (EmbeddingGemma does not support fp16), got "${dtype}"`);
  }
  if (!DIMS.includes(dims)) throw new Error(`EMBED_DIMS must be one of ${DIMS.join(", ")}, got "${env.EMBED_DIMS}"`);
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error(`EMBED_BATCH must be a positive integer, got "${env.EMBED_BATCH}"`);
  return { modelId, dtype, dims, batchSize };
}

export function loadSources(sourcesPath = SOURCES_PATH) {
  return JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
}

/** Where `knowledge_database/` is: KNOWLEDGE_DIR, else sources.json, relative to doc_index/. */
export function knowledgeDir(sources = loadSources(), env = process.env) {
  return path.resolve(PROJECT_DIR, env.KNOWLEDGE_DIR || sources.knowledge.dir);
}
