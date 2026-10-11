/**
 * **A tiny client for Ollama's native HTTP API** (no SDK, just `fetch`).
 *
 * `createOllama({ url, fetch })` gives `version()`, `list()`, `show(model)`,
 * `chat(options)` and `unload(model)`. Tests pass a fake `fetch`.
 *
 * Every failure comes out as an `OllamaError` whose message says what to do
 * (`ollama serve`, `ollama pull …`), so scripts can print it instead of a
 * stack trace.
 *
 * `chat` is always non-streaming and returns the text with Ollama's own timing
 * fields (nanoseconds) and the metrics derived from them, see `deriveMetrics`.
 */

export const DEFAULT_URL = "http://localhost:11434";

export class OllamaError extends Error {
  /** @param {string} message @param {{ code: string, cause?: unknown }} o */
  constructor(message, { code, cause } = {}) {
    super(message, { cause });
    this.name = "OllamaError";
    this.code = code;
  }
}

const NS_PER_MS = 1e6;
const NS_PER_S = 1e9;

const TIMING_FIELDS = [
  "total_duration",
  "load_duration",
  "prompt_eval_count",
  "prompt_eval_cached_count",
  "prompt_eval_duration",
  "eval_count",
  "eval_duration",
];

const round = (x, digits = 1) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(digits)));
const perSecond = (count, durationNs) => (count > 0 && durationNs > 0 ? count / (durationNs / NS_PER_S) : null);

/**
 * Ollama's nanosecond fields → milliseconds and rates.
 *
 * - `prompt_tps`: prompt tokens per second, counting only the tokens actually
 *   evaluated: (prompt_eval_count − prompt_eval_cached_count) / prompt_eval_duration
 * - `gen_tps`: generated tokens per second (eval_count / eval_duration)
 * - `ttft_ms`: time to first token ≈ load_duration + prompt_eval_duration
 *   (a non-streaming call can't observe the first token, so this is Ollama's
 *   own account of everything that happens before generation starts)
 */
export function deriveMetrics(raw = {}) {
  const ms = (ns) => (ns == null ? null : round(ns / NS_PER_MS));
  const load = raw.load_duration ?? 0;
  const promptEval = raw.prompt_eval_duration ?? 0;
  return {
    total_ms: ms(raw.total_duration),
    load_ms: ms(raw.load_duration),
    prompt_eval_ms: ms(raw.prompt_eval_duration),
    eval_ms: ms(raw.eval_duration),
    ttft_ms: raw.load_duration == null && raw.prompt_eval_duration == null ? null : ms(load + promptEval),
    prompt_tokens: raw.prompt_eval_count ?? null,
    cached_prompt_tokens: raw.prompt_eval_cached_count ?? null,
    gen_tokens: raw.eval_count ?? null,
    prompt_tps: round(perSecond((raw.prompt_eval_count ?? 0) - (raw.prompt_eval_cached_count ?? 0), raw.prompt_eval_duration)),
    gen_tps: round(perSecond(raw.eval_count, raw.eval_duration)),
  };
}

/** The pull command for a model that isn't installed. */
export const pullHint = (model) => `ollama pull ${model}`;

/**
 * @param {object} [o]
 * @param {string} [o.url] defaults to OLLAMA_URL, then http://localhost:11434
 * @param {typeof fetch} [o.fetch]
 * @param {number} [o.timeoutMs] per request (a cold 8 GB model can take a while to load)
 */
export function createOllama({ url = process.env.OLLAMA_URL || DEFAULT_URL, fetch: fetchImpl = globalThis.fetch, timeoutMs = 600_000 } = {}) {
  const base = url.replace(/\/+$/, "");

  async function request(path, { method = "GET", body, model } = {}) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === "TimeoutError") {
        throw new OllamaError(`Ollama at ${base} did not answer ${path} within ${timeoutMs / 1000} s.`, { code: "timeout", cause: err });
      }
      throw new OllamaError(
        `Ollama isn't reachable at ${base} (${err?.cause?.code ?? err?.message ?? "connection failed"}).\n` +
          `Start it with \`ollama serve\` (or open the Ollama app), or set OLLAMA_URL if it runs elsewhere.`,
        { code: "unreachable", cause: err },
      );
    }
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
    if (!res.ok) {
      const detail = data?.error ?? `HTTP ${res.status}`;
      if (res.status === 404 && model) {
        throw new OllamaError(`Model "${model}" isn't installed (${detail}).\nPull it with \`${pullHint(model)}\`.`, { code: "model_missing" });
      }
      throw new OllamaError(`Ollama ${path} failed: ${detail}`, { code: "http_error" });
    }
    return data;
  }

  return {
    url: base,

    /** "0.40.2" */
    version: async () => (await request("/api/version")).version,

    /** Installed models: [{ name, size, digest, details }] */
    list: async () => (await request("/api/tags")).models ?? [],

    /** Models currently loaded in memory. */
    running: async () => (await request("/api/ps")).models ?? [],

    /** /api/show: details (family, parameter_size, quantization_level), capabilities, … */
    show: (model) => request("/api/show", { method: "POST", body: { model }, model }),

    /**
     * One non-streaming chat call.
     *
     * @param {object} o
     * @param {string} o.model
     * @param {{ role: string, content: string }[]} o.messages
     * @param {number} [o.temperature] default 0
     * @param {number} [o.seed]
     * @param {number} [o.num_predict]
     * @param {number} [o.num_ctx]
     * @param {object} [o.format] a JSON schema (or "json")
     * @param {boolean} [o.think] default false
     * @param {string|number} [o.keep_alive]
     */
    async chat({ model, messages, temperature = 0, seed, num_predict, num_ctx, format, think = false, keep_alive }) {
      const options = { temperature };
      if (seed != null) options.seed = seed;
      if (num_predict != null) options.num_predict = num_predict;
      if (num_ctx != null) options.num_ctx = num_ctx;
      const body = { model, messages, stream: false, think, options };
      if (format != null) body.format = format;
      if (keep_alive != null) body.keep_alive = keep_alive;

      const started = performance.now();
      const data = await request("/api/chat", { method: "POST", body, model });
      const wall_ms = round(performance.now() - started);

      const timings = Object.fromEntries(TIMING_FIELDS.map((f) => [f, data[f] ?? null]));
      return {
        model: data.model ?? model,
        text: data.message?.content ?? "",
        thinking: data.message?.thinking ?? null,
        think,
        done_reason: data.done_reason ?? null,
        timings,
        metrics: { ...deriveMetrics(data), wall_ms },
      };
    },

    /** Drop the model from memory now (keep_alive: 0). */
    unload: (model) => request("/api/generate", { method: "POST", body: { model, keep_alive: 0 }, model }),
  };
}
