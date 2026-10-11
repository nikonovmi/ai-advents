import path from "node:path";
import { pathToFileURL } from "node:url";

import Ajv from "ajv";

import { LlmProvider, LlmError } from "./provider.js";

/**
 * **The local implementation of the LLM abstraction (Day 27).**
 *
 * A model served by Ollama on this machine, reached through Day 26's client
 * (`../local_llm/src/ollama.js`), imported the way `../doc_index` is: from a
 * directory next to first-agent, on the first call, so a missing checkout is a
 * readable error on a local chat rather than a crash at startup.
 *
 * Same contract as `AnthropicProvider`: `complete()` takes a system string and
 * neutral messages and returns a `Completion`. Two things are added to it and
 * nothing else changes shape:
 *
 *   - `provider: "local"` and `metrics` (Ollama's own timings, see
 *     `localMetrics`), which the routes store on the reply;
 *   - **forced tool use becomes a JSON-schema `format`**. A caller that names
 *     `toolChoice` wants the tool's input back as structured output; Ollama
 *     gets the tool's `inputSchema` as `format`, the reply is parsed and
 *     validated (ajv), and an invalid one is retried once with the errors. The
 *     caller still receives a `tool_use` block, so it never knows the
 *     difference.
 *
 * Always `think: false`: thinking tokens are slow on this hardware and none of
 * the app's prompts need them.
 */

export const LOCAL_PROVIDER = "local";
export const PROJECT_DIR = path.join(import.meta.dirname, "..", "..");

/**
 * | env | default | |
 * | --- | --- | --- |
 * | `OLLAMA_URL` | `http://localhost:11434` | where Ollama listens |
 * | `LOCAL_NUM_CTX` | 8192 | context window, set on every call |
 * | `LOCAL_NUM_PREDICT` | 1024 | ceiling on generated tokens per call |
 * | `LOCAL_TIMEOUT_MS` | 180000 | per call, model load included |
 * | `LOCAL_LLM_DIR` | `../local_llm` | where the Day 26 client lives |
 * | `LOCAL_RAG_NUM_CTX` | 16384 | Day 28: the context window of every call in a Knowledge RAG chat |
 * | `LOCAL_RAG_NUM_PREDICT` | 2048 | Day 28: the RAG calls' output ceiling (a `submit_answer` carries quotes: about twice a free-text answer) |
 */
export function localSettings(env = process.env) {
  const int = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}, got "${raw}"`);
    return value;
  };
  return {
    url: (env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, ""),
    numCtx: int("LOCAL_NUM_CTX", 8192, 512, 262144),
    numPredict: int("LOCAL_NUM_PREDICT", 1024, 1, 32768),
    timeoutMs: int("LOCAL_TIMEOUT_MS", 180000, 1000, 3600000),
    ragNumCtx: int("LOCAL_RAG_NUM_CTX", 16384, 2048, 262144),
    ragNumPredict: int("LOCAL_RAG_NUM_PREDICT", 2048, 1, 32768),
    dir: path.resolve(PROJECT_DIR, env.LOCAL_LLM_DIR || path.join("..", "local_llm")),
  };
}

const clients = new Map();

/** Day 26's `ollama.js`, imported once per directory. */
export function loadOllamaModule(dir) {
  if (!clients.has(dir)) {
    const loading = import(pathToFileURL(path.join(dir, "src", "ollama.js")).href).catch((err) => {
      clients.delete(dir);
      throw localError(
        `The local LLM client isn't installed next to first-agent (${path.join(dir, "src", "ollama.js")}: ${err?.code ?? err?.message}). ` +
          "Check out local_llm beside first-agent, or set LOCAL_LLM_DIR.",
        { status: 500, code: "client_missing" },
      );
    });
    clients.set(dir, loading);
  }
  return clients.get(dir);
}

/** An `LlmError` the routes pass through as it is: it was written to be read. */
export function localError(message, { status = 0, code = "error" } = {}) {
  const err = new LlmError(message, status);
  err.local = true;
  err.code = code;
  return err;
}

/**
 * Day 26's `OllamaError` → `LlmError`, keeping its sentence (which already says
 * what to run) and picking a status that `completeWithRetry` will not retry
 * pointlessly: an unreachable server is 0, a missing model 404, a timeout 408.
 */
export function fromOllamaError(err, { model, timeoutMs }) {
  if (err?.local) return err;
  const said = String(err?.message ?? err);
  switch (err?.code) {
    case "unreachable":
      return localError(`Local model unavailable. ${said}`, { status: 0, code: "unreachable" });
    case "model_missing":
      return localError(`Local model unavailable. ${said}`, { status: 404, code: "model_missing" });
    case "timeout":
      return localError(
        `${model} didn't finish within ${Math.round(timeoutMs / 1000)} s (LOCAL_TIMEOUT_MS). ` +
          "A cold model takes a few seconds to load and long answers are slow on this machine: try again, ask for less, or raise LOCAL_TIMEOUT_MS.",
        { status: 408, code: "timeout" },
      );
    default:
      return localError(`Local model call failed: ${said.split("\n")[0].slice(0, 300)}`, { status: 502, code: err?.code ?? "error" });
  }
}

/**
 * Neutral → Ollama: the system prompt becomes the first message, and content
 * blocks are flattened to text (Ollama's `content` is a string). A tool call
 * or result reads as a line saying what it was, so nothing silently vanishes
 * from a history that once had them.
 *
 * @param {string | undefined} system
 * @param {import("./provider.js").Message[]} messages
 * @returns {{ role: string, content: string }[]}
 */
export function toOllamaMessages(system, messages = []) {
  const wire = system ? [{ role: "system", content: String(system) }] : [];
  for (const { role, content } of messages) wire.push({ role, content: flatten(content) });
  return wire;
}

/** One message's content as text. */
export function flatten(content) {
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((block) => {
      if (block?.type === "tool_use") return `[called ${block.name} with ${JSON.stringify(block.input ?? {})}]`;
      if (block?.type === "tool_result") return `[${block.isError ? "tool error" : "tool result"}] ${String(block.content ?? "")}`;
      return String(block?.text ?? "");
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * What each local reply records: Day 26's derived metrics, in this app's
 * camelCase. `ttftMs` is Ollama's load + prompt-eval time (a non-streaming call
 * cannot see the first token); `wallMs` is the whole HTTP call from here.
 */
export function localMetrics(metrics = {}) {
  return {
    ttftMs: metrics.ttft_ms ?? null,
    genTps: metrics.gen_tps ?? null,
    totalMs: metrics.total_ms ?? null,
    wallMs: metrics.wall_ms ?? null,
    loadMs: metrics.load_ms ?? null,
    promptTokens: metrics.prompt_tokens ?? null,
    cachedPromptTokens: metrics.cached_prompt_tokens ?? null,
    outputTokens: metrics.gen_tokens ?? null,
    promptTps: metrics.prompt_tps ?? null,
    promptEvalMs: metrics.prompt_eval_ms ?? null,
    evalMs: metrics.eval_ms ?? null,
  };
}

/**
 * Several calls' metrics as one (Day 28: a structured retry, or the contract's
 * second attempt): time to first token is the first call's, everything else
 * adds up, and tokens/s is recomputed over all the generation time.
 */
export function combineMetrics(list) {
  const all = list.filter(Boolean);
  if (!all.length) return null;
  if (all.length === 1) return all[0];
  const add = (key) => (all.some((m) => typeof m[key] === "number") ? all.reduce((a, m) => a + (m[key] ?? 0), 0) : null);
  const outputTokens = add("outputTokens");
  const evalMs = add("evalMs");
  return {
    ...all[0],
    genTps: outputTokens && evalMs ? Math.round((10 * outputTokens) / (evalMs / 1000)) / 10 : all[0].genTps,
    totalMs: add("totalMs"),
    wallMs: add("wallMs"),
    loadMs: add("loadMs"),
    promptTokens: add("promptTokens"),
    cachedPromptTokens: add("cachedPromptTokens"),
    outputTokens,
    promptEvalMs: add("promptEvalMs"),
    evalMs,
    calls: all.length,
  };
}

/** A prompt this close to `num_ctx` may have been cut by Ollama, which does not say so. */
export const TRUNCATION_MARGIN = 0.1;
export function nearContextLimit(promptTokens, numCtx) {
  return typeof promptTokens === "number" && typeof numCtx === "number" && promptTokens >= numCtx * (1 - TRUNCATION_MARGIN);
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new WeakMap();
function validatorFor(schema) {
  if (!validators.has(schema)) validators.set(schema, ajv.compile(schema));
  return validators.get(schema);
}

/**
 * The reply as a JSON value, or why it is not one. Tolerates a code fence
 * around it, since a model asked for JSON sometimes adds one anyway.
 *
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function parseStructured(text, schema) {
  const raw = String(text ?? "").trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1");
  let value;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `not valid JSON (${err.message})` };
  }
  const validate = validatorFor(schema);
  if (!validate(value)) {
    return { ok: false, error: ajv.errorsText(validate.errors, { dataVar: "reply" }) };
  }
  return { ok: true, value };
}

export class OllamaProvider extends LlmProvider {
  #model;
  #settings;
  #fetch;
  #client = null;
  #log;

  /** The last few request bodies as sent, newest last, for tests to read. */
  calls = [];

  /**
   * @param {object} params
   * @param {string} params.model - The Ollama tag, e.g. `qwen3.5:9b`.
   * @param {Partial<ReturnType<typeof localSettings>>} [params.settings]
   * @param {typeof fetch} [params.fetch] - Tests pass a fake.
   */
  constructor({ model, settings = {}, fetch, log = console.warn } = {}) {
    super();
    if (!model) throw new Error("OllamaProvider requires a model (an Ollama tag such as qwen3.5:9b).");
    this.#model = model;
    this.#settings = { ...localSettings({}), ...settings };
    this.#fetch = fetch;
    this.#log = log;
  }

  get model() {
    return this.#model;
  }

  get provider() {
    return LOCAL_PROVIDER;
  }

  get settings() {
    return { ...this.#settings };
  }

  async client() {
    if (!this.#client) {
      const { createOllama } = await loadOllamaModule(this.#settings.dir);
      this.#client = createOllama({
        url: this.#settings.url,
        timeoutMs: this.#settings.timeoutMs,
        ...(this.#fetch ? { fetch: this.#fetch } : {}),
      });
    }
    return this.#client;
  }

  /**
   * `model` is accepted for the interface but a Claude id is never sent to
   * Ollama: anything that is not a local tag falls back to this provider's own
   * model. (An agent's `model` names a Claude model; only Claude-only agents
   * have one.)
   */
  async complete({ system, messages, temperature = 0.7, maxTokens, model, tools, toolChoice }) {
    const id = model && !/^claude-/.test(model) ? model : this.#model;
    const forced = tools?.length && toolChoice?.name ? tools.find((tool) => tool.name === toolChoice.name) : null;
    if (tools?.length && !forced) {
      throw localError(
        "Tool calling isn't supported for local models yet: this agent answers with Claude only.",
        { status: 400, code: "tools_unsupported" },
      );
    }
    const numPredict = Math.min(maxTokens ?? this.#settings.numPredict, this.#settings.numPredict);
    const base = { model: id, temperature, num_predict: numPredict, num_ctx: this.#settings.numCtx, think: false };
    const wire = toOllamaMessages(forced ? structuredSystem(system, forced) : system, messages);

    if (!forced) {
      const res = await this.#chat({ ...base, messages: wire });
      const completion = this.#completion(res, { text: res.text.trim(), content: [{ type: "text", text: res.text.trim() }] });
      return this.#nearLimit(res) ? { ...completion, possible_truncation: true } : completion;
    }

    // Structured output: the tool's schema as `format`, validated, one retry.
    const schema = forced.inputSchema ?? { type: "object" };
    const first = await this.#chat({ ...base, messages: wire, format: schema });
    let parsed = parseStructured(first.text, schema);
    const responses = [first];
    const errors = parsed.ok ? [] : [parsed.error];
    if (!parsed.ok) {
      const retry = [
        ...wire,
        { role: "assistant", content: first.text },
        { role: "user", content: `That reply was rejected: ${parsed.error}. Reply again with only the JSON object for ${forced.name}, matching the schema exactly.` },
      ];
      const second = await this.#chat({ ...base, messages: retry, format: schema });
      responses.push(second);
      parsed = parseStructured(second.text, schema);
      if (!parsed.ok) errors.push(parsed.error);
    }
    const last = responses.at(-1);
    const usage = {
      inputTokens: sumTokens(...responses.map((r) => r.metrics.prompt_tokens)),
      outputTokens: sumTokens(...responses.map((r) => r.metrics.gen_tokens)),
    };
    // Day 28: what the eval counts — how many replies were not valid JSON for the schema.
    const structured = { tool: forced.name, attempts: responses.length, invalid: errors.length, errors };
    if (!parsed.ok) {
      const err = localError(`${id} didn't return valid JSON for ${forced.name} after one retry: ${parsed.error}`, { status: 422, code: "invalid_json" });
      err.structured = structured;
      err.metrics = combineMetrics(responses.map((r) => this.#completion(r, { text: "", content: [] }).metrics));
      err.usage = usage;
      err.possible_truncation = responses.some((r) => this.#nearLimit(r));
      throw err;
    }
    const use = { type: "tool_use", id: `toolu_local_${Date.now().toString(36)}`, name: forced.name, input: parsed.value };
    const completion = this.#completion(last, { text: "", content: [use] });
    return {
      ...completion,
      stopReason: "tool_use",
      usage,
      attempts: responses.length,
      structured,
      metrics: combineMetrics(responses.map((r) => this.#completion(r, { text: "", content: [] }).metrics)),
      ...(responses.some((r) => this.#nearLimit(r)) ? { possible_truncation: true } : {}),
    };
  }

  /** Ollama has no token-counting endpoint; the Agent shows "unknown" rather than a guess. */
  async countTokens() {
    return { inputTokens: null };
  }

  async #chat(request) {
    let client;
    try {
      client = await this.client();
    } catch (err) {
      throw err?.local ? err : fromOllamaError(err, { model: request.model, timeoutMs: this.#settings.timeoutMs });
    }
    this.calls.push(request);
    if (this.calls.length > 20) this.calls.shift();
    try {
      return await client.chat(request);
    } catch (err) {
      throw fromOllamaError(err, { model: request.model, timeoutMs: this.#settings.timeoutMs });
    }
  }

  /**
   * Day 28: Ollama cuts a prompt that does not fit `num_ctx` and says nothing,
   * so a prompt within 10 % of the window is logged and flagged on the result.
   */
  #nearLimit(res) {
    const prompt = res.metrics?.prompt_tokens;
    if (!nearContextLimit(prompt, this.#settings.numCtx)) return false;
    this.#log(`[local] possible truncation: ${res.model ?? this.#model} prompt ${prompt} tokens, num_ctx ${this.#settings.numCtx}`);
    return true;
  }

  #completion(res, { text, content }) {
    return {
      text,
      content,
      model: res.model ?? this.#model,
      stopReason: res.done_reason === "length" ? "max_tokens" : "end_turn",
      usage: { inputTokens: res.metrics?.prompt_tokens ?? 0, outputTokens: res.metrics?.gen_tokens ?? 0 },
      provider: LOCAL_PROVIDER,
      metrics: { ...localMetrics(res.metrics), numCtx: this.#settings.numCtx },
    };
  }
}

/** The system prompt for a structured call: the caller's, plus what the tool is and that only JSON comes back. */
function structuredSystem(system, tool) {
  return [
    system ?? "",
    `Reply with one JSON object: the input for "${tool.name}"${tool.description ? ` (${tool.description})` : ""}.`,
    "It must match the JSON schema you are given. No prose and no code fences around it.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function sumTokens(...counts) {
  return counts.reduce((a, b) => a + (b ?? 0), 0);
}
