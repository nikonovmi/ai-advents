import path from "node:path";

/**
 * **The hosted service's settings (Day 30).**
 *
 * What it answers with is fixed — there are no model, RAG or rerank switches:
 * the Knowledge chat with RAG and rerank on, on qwen3.5:9b, with Day 29's
 * adopted settings (num_ctx 8192 on every call, the v1 prompts).
 *
 * The limits come from the environment:
 *
 * | env | default | when exceeded |
 * | --- | --- | --- |
 * | `HOSTED_PORT` | 3100 | — (always bound to 127.0.0.1) |
 * | `HOSTED_CONCURRENCY` | 1 | requests at the model at once; the rest wait in the queue |
 * | `HOSTED_QUEUE_MAX` | 5 | 429 "server busy" with `Retry-After` |
 * | `HOSTED_RATE_LIMIT` | `10/10m` | messages per user per window: 429 with `Retry-After` |
 * | `HOSTED_MAX_MESSAGE_CHARS` | 2000 | 413 with a readable message |
 * | `HOSTED_MAX_OUTPUT_TOKENS` | 1024 | the ceiling on every model call's output |
 * | `HOSTED_REQUEST_TIMEOUT_MS` | 180000 | 504: the request fails, the queue moves on |
 * | `HOSTED_KEEP_ALIVE` | `60m` | how long Ollama keeps qwen loaded after the last call |
 * | `HOSTED_DATA_DIR` | `data/hosted` | one directory of conversations per user |
 *
 * History is `RAG_HISTORY_TURNS` (6 messages) and the retrieval settings are
 * the app's `RAG_*` ones, as in the full app.
 */

export const HOSTED_FIXED = Object.freeze({
  model: "qwen3.5:9b",
  /** Day 29's adopted window, the same for every local call so the model loads once. */
  numCtx: 8192,
  /** Day 29: v2 was not adopted. */
  promptVariant: "v1",
  mode: "rag",
  ragOptions: Object.freeze({ rerank: true, rewrite: false }),
});

const PROJECT_DIR = path.join(import.meta.dirname, "..", "..");

/** @returns {ReturnType<typeof parse>} */
export function hostedSettings(env = process.env) {
  return parse(env);
}

function parse(env) {
  const int = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}, got "${raw}"`);
    return value;
  };
  const rate = rateLimitOf(env.HOSTED_RATE_LIMIT);
  return {
    port: int("HOSTED_PORT", 3100, 1, 65535),
    concurrency: int("HOSTED_CONCURRENCY", 1, 1, 8),
    queueMax: int("HOSTED_QUEUE_MAX", 5, 0, 100),
    rateLimit: rate.limit,
    rateWindowMs: rate.windowMs,
    maxMessageChars: int("HOSTED_MAX_MESSAGE_CHARS", 2000, 1, 20000),
    maxOutputTokens: int("HOSTED_MAX_OUTPUT_TOKENS", 1024, 16, 8192),
    requestTimeoutMs: int("HOSTED_REQUEST_TIMEOUT_MS", 180000, 1000, 3600000),
    keepAlive: env.HOSTED_KEEP_ALIVE || "60m",
    dataDir: path.resolve(PROJECT_DIR, env.HOSTED_DATA_DIR || path.join("data", "hosted")),
  };
}

/** `10/10m` → 10 messages per 600 000 ms. A bare number is per 10 minutes. */
export function rateLimitOf(raw) {
  if (raw === undefined || raw === "") return { limit: 10, windowMs: 600_000 };
  const m = /^\s*(\d+)\s*(?:\/\s*(\d+)\s*(s|m|h))?\s*$/.exec(String(raw));
  if (!m || Number(m[1]) < 1) throw new Error(`HOSTED_RATE_LIMIT must look like 10/10m (messages per window), got "${raw}"`);
  const unit = { s: 1000, m: 60_000, h: 3_600_000 }[m[3] ?? "m"];
  return { limit: Number(m[1]), windowMs: (m[2] ? Number(m[2]) : 10) * unit };
}

/**
 * The local-model settings the hosted server runs with, as the `LOCAL_*` env
 * `createLlms` reads: Day 29's fixed values, the hosted output ceiling and
 * timeout, and only where Ollama is from the real environment.
 */
export function hostedLocalEnv(env, settings) {
  return {
    ...(env.OLLAMA_URL ? { OLLAMA_URL: env.OLLAMA_URL } : {}),
    ...(env.LOCAL_LLM_DIR ? { LOCAL_LLM_DIR: env.LOCAL_LLM_DIR } : {}),
    LOCAL_MODELS: HOSTED_FIXED.model,
    LOCAL_DEFAULT_MODEL: HOSTED_FIXED.model,
    LOCAL_NUM_CTX: String(HOSTED_FIXED.numCtx),
    LOCAL_RAG_NUM_CTX: String(HOSTED_FIXED.numCtx),
    LOCAL_PROMPT_VARIANT: HOSTED_FIXED.promptVariant,
    LOCAL_NUM_PREDICT: String(settings.maxOutputTokens),
    LOCAL_RAG_NUM_PREDICT: String(settings.maxOutputTokens),
    LOCAL_TIMEOUT_MS: String(settings.requestTimeoutMs),
    LOCAL_KEEP_ALIVE: settings.keepAlive,
  };
}
