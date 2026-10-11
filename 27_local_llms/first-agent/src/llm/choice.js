import { LOCAL_PROVIDER, OllamaProvider, fromOllamaError, loadOllamaModule, localSettings } from "./ollama.js";

/**
 * **Which model answers a chat (Day 27).**
 *
 * A chat's choice is a string stored on its record, like the RAG switch:
 * `claude` or `local:<ollama tag>` (`local:qwen3.5:9b`). Only agents marked
 * `local` in `agents.js` may hold a local choice; every other agent answers
 * with the Claude provider whatever the page sends.
 *
 * `createLlms` owns the providers: the Claude one (Anthropic, or the offline
 * FakeProvider when there is no key) and one `OllamaProvider` per local
 * model, built on first use. `providerFor(choice)` is the only way a route
 * gets a provider for a chat, so a local chat cannot reach Claude by
 * accident: there is no fallback path to take.
 *
 * | env | default | |
 * | --- | --- | --- |
 * | `LOCAL_MODELS` | installed `gemma4:*` tags + `qwen3.5:9b` | the models the switch offers (comma list) |
 * | `LOCAL_DEFAULT_MODEL` | the first of them | the local model new chats start on; setting it also makes local the default with a key |
 *
 * Plus the provider's own (`OLLAMA_URL`, `LOCAL_NUM_CTX`, …) in `ollama.js`.
 */

export const CLAUDE = "claude";
const LOCAL_PREFIX = `${LOCAL_PROVIDER}:`;
const TAG = /^[a-z0-9][a-z0-9._\-/]*(:[a-z0-9._-]+)?$/i;
/** Only when nothing is configured and Ollama could not be asked what is installed. */
export const FALLBACK_LOCAL_MODEL = "qwen3.5:9b";

/** @param {unknown} value */
export function isLlmChoice(value) {
  if (value === CLAUDE) return true;
  return typeof value === "string" && value.startsWith(LOCAL_PREFIX) && value.length <= 120 && TAG.test(value.slice(LOCAL_PREFIX.length));
}

/** A stored choice, or null. */
export function llmOf(value) {
  return isLlmChoice(value) ? value : null;
}

export function isLocalChoice(value) {
  return isLlmChoice(value) && value !== CLAUDE;
}

export const localChoice = (model) => `${LOCAL_PREFIX}${model}`;
export const localModelOf = (choice) => (isLocalChoice(choice) ? choice.slice(LOCAL_PREFIX.length) : null);

/** Day 26's default families, narrowed to what this machine runs: every gemma4 tag, and qwen3.5:9b. */
export function defaultLocalModels(installed) {
  const names = installed.map((m) => m.name ?? m.model).filter(Boolean);
  return names.filter((n) => n.startsWith("gemma4:") || n === "qwen3.5:9b").sort();
}

/**
 * @param {object} params
 * @param {import("./provider.js").LlmProvider} params.claude - What a `claude` choice gets.
 * @param {boolean} params.claudeAvailable - False without ANTHROPIC_API_KEY: the switch disables Claude.
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {typeof fetch} [params.fetch] - Passed to every Ollama call (tests, and the verify script's guard).
 */
export function createLlms({ claude, claudeAvailable, env = process.env, fetch } = {}) {
  const settings = localSettings(env);
  const configured = String(env.LOCAL_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const explicitDefault = (env.LOCAL_DEFAULT_MODEL || "").trim() || null;
  const providers = new Map();
  /** What Ollama last said is installed, so a down server still has a list. */
  let lastInstalled = null;

  const local = (model) => {
    if (!providers.has(model)) providers.set(model, new OllamaProvider({ model, settings, fetch }));
    return providers.get(model);
  };

  async function client() {
    const { createOllama } = await loadOllamaModule(settings.dir);
    return createOllama({ url: settings.url, timeoutMs: 5000, ...(fetch ? { fetch } : {}) });
  }

  /** The models the switch offers: LOCAL_MODELS, else the installed defaults (as last seen). */
  async function localModels({ installed } = {}) {
    if (configured.length) return configured;
    if (!installed) {
      try {
        installed = await (await client()).list();
        lastInstalled = installed;
      } catch {
        installed = lastInstalled ?? [];
      }
    }
    return defaultLocalModels(installed);
  }

  async function defaultLocalModel(models) {
    return explicitDefault ?? (models ?? (await localModels()))[0] ?? FALLBACK_LOCAL_MODEL;
  }

  /** New chats: Claude when there is a key and no LOCAL_DEFAULT_MODEL, else the default local model. */
  async function defaultChoice() {
    if (claudeAvailable && !explicitDefault) return CLAUDE;
    return localChoice(await defaultLocalModel());
  }

  return {
    claude,
    claudeAvailable,
    settings,
    local,
    localModels,
    defaultChoice,

    /** The provider for a choice. A local choice can only ever get an OllamaProvider. */
    providerFor(choice) {
      return isLocalChoice(choice) ? local(localModelOf(choice)) : claude;
    },

    /**
     * `GET /local/status`: whether Ollama answers, its version, what is
     * installed and loaded, and what the switch offers. Never throws: a down
     * server is a state the page draws.
     */
    async status() {
      const base = { url: settings.url, numCtx: settings.numCtx, numPredict: settings.numPredict, timeoutMs: settings.timeoutMs, claudeAvailable };
      try {
        const c = await client();
        const [version, installed, running] = await Promise.all([c.version(), c.list(), c.running()]);
        lastInstalled = installed;
        const models = await localModels({ installed });
        const names = installed.map((m) => m.name ?? m.model);
        const loaded = running.map((m) => m.name ?? m.model);
        const defaultModel = await defaultLocalModel(models);
        return {
          ...base,
          reachable: true,
          version,
          installed: names,
          loaded,
          models: models.map((name) => ({ name, installed: names.includes(name), loaded: loaded.includes(name) })),
          defaultModel,
          defaultChoice: claudeAvailable && !explicitDefault ? CLAUDE : localChoice(defaultModel),
        };
      } catch (err) {
        const models = await localModels({ installed: lastInstalled ?? [] });
        const defaultModel = await defaultLocalModel(models);
        return {
          ...base,
          reachable: false,
          error: (err?.local ? err : fromOllamaError(err, { model: defaultModel, timeoutMs: 5000 })).message,
          version: null,
          installed: [],
          loaded: [],
          models: models.map((name) => ({ name, installed: false, loaded: false })),
          defaultModel,
          defaultChoice: claudeAvailable && !explicitDefault ? CLAUDE : localChoice(defaultModel),
        };
      }
    },
  };
}
