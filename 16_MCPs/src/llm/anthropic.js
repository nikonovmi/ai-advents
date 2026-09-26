import { LlmProvider, LlmError } from "./provider.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const COUNT_URL = "https://api.anthropic.com/v1/messages/count_tokens";
const API_VERSION = "2023-06-01";
const TIMEOUT_MS = 30000;

/**
 * Anthropic implementation of the LLM abstraction.
 *
 * This is the only file that knows the endpoint, the header names, the
 * request/response shape, or the API key.
 */
export class AnthropicProvider extends LlmProvider {
  #apiKey;
  #model;
  #workspaceId;

  /**
   * @param {object} params
   * @param {string} params.apiKey
   * @param {string} [params.model]
   * @param {string} [params.workspaceId] - Only needed for identity-linked keys.
   */
  constructor({ apiKey, model = "claude-haiku-4-5-20251001", workspaceId } = {}) {
    super();
    if (!apiKey) {
      throw new Error(
        "AnthropicProvider requires an apiKey. Set ANTHROPIC_API_KEY in your .env file."
      );
    }
    this.#apiKey = apiKey;
    this.#model = model;
    this.#workspaceId = workspaceId;
  }

  get model() {
    return this.#model;
  }

  async complete({ system, messages, temperature = 0.7, maxTokens = 1024, model }) {
    const body = {
      model: model || this.#model,
      max_tokens: maxTokens,
      temperature,
      messages: messages.map(({ role, content }) => ({ role, content })),
    };
    if (system) body.system = system;

    const data = await this.#post(API_URL, body);

    return {
      text: extractText(data.content),
      model: data.model ?? model ?? this.#model,
      // `stop_reason` becomes `stopReason` here and nowhere else. Above this
      // line nobody knows Anthropic uses snake_case.
      stopReason: data.stop_reason ?? null,
      usage: neutralUsage(data.usage),
    };
  }

  /**
   * The same body the Messages API takes, minus `max_tokens` (there is no
   * output to cap — the model never runs). Free and unbilled, which is what
   * makes it usable as a pre-flight measurement on every single turn.
   */
  async countTokens({ system, messages, model }) {
    const body = {
      model: model || this.#model,
      messages: messages.map(({ role, content }) => ({ role, content })),
    };
    if (system) body.system = system;

    const data = await this.#post(COUNT_URL, body);
    return { inputTokens: data.input_tokens ?? 0 };
  }

  /**
   * One POST, one set of headers, one timeout, one error translation — shared
   * by both endpoints so they cannot drift apart.
   */
  async #post(url, body) {
    const headers = {
      "x-api-key": this.#apiKey,
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
    };
    // Identity-linked keys must name the workspace they act in; workspace-scoped
    // keys don't, and the header is harmless to omit for them.
    if (this.#workspaceId) headers["anthropic-workspace-id"] = this.#workspaceId;

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      throw new LlmError(
        timedOut
          ? `Request to Anthropic timed out after ${TIMEOUT_MS}ms`
          : `Could not reach Anthropic: ${err?.message ?? String(err)}`,
        timedOut ? 408 : 0
      );
    }

    const raw = await response.text();

    if (!response.ok) {
      throw new LlmError(errorMessageFrom(raw, response.status), response.status);
    }

    try {
      return JSON.parse(raw);
    } catch {
      throw new LlmError("Anthropic returned a response that was not JSON", response.status);
    }
  }
}

/**
 * Anthropic's `usage` object in neutral clothes. The two cache fields only
 * appear when prompt caching is in play, so they are passed through when
 * present and simply absent otherwise — never faked as zero, which would
 * read as "nothing was cached" rather than "caching was not involved".
 *
 * @param {{ input_tokens?: number, output_tokens?: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number }} [usage]
 * @returns {import("./provider.js").Usage}
 */
function neutralUsage(usage) {
  const neutral = {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
  if (typeof usage?.cache_read_input_tokens === "number") {
    neutral.cacheReadInputTokens = usage.cache_read_input_tokens;
  }
  if (typeof usage?.cache_creation_input_tokens === "number") {
    neutral.cacheCreationInputTokens = usage.cache_creation_input_tokens;
  }
  return neutral;
}

/**
 * Flatten Anthropic's content blocks into plain text. Non-text blocks
 * (tool_use, thinking, …) are skipped here, so supporting them later is a
 * change to this helper and nothing above it.
 *
 * @param {Array<{ type: string, text?: string }>} [blocks]
 * @returns {string}
 */
function extractText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

/**
 * Pull the provider's own error message out of a failed response body,
 * falling back to something readable.
 *
 * @param {string} raw
 * @param {number} status
 * @returns {string}
 */
function errorMessageFrom(raw, status) {
  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.error?.message;
    if (message) return message;
  } catch {
    // fall through to the raw body
  }
  const snippet = raw?.trim().slice(0, 200);
  return snippet ? `HTTP ${status}: ${snippet}` : `HTTP ${status}`;
}

/**
 * A provider that never leaves the process: no key, no network. Useful for
 * exercising the app and the Agent offline.
 *
 * Its numbers are synthetic but shaped like the real thing — roughly four
 * characters to a token — so the counters, the cost panel and the truncation
 * warning all behave without a key. They are not billed and not accurate;
 * `fake-provider` is deliberately absent from PRICING, which is also how the
 * unknown-model path gets exercised.
 *
 * It recognises the system prompts this app sends — the summarizer's, the fact
 * extractor's, the promoter's, the briefer's and the persona's — and answers
 * each in the right shape, so every context strategy, the scenario harness and
 * the lifecycle walk all run offline.
 *
 * **It does not understand anything; it reflects.** Asked a question, it reads
 * back what its own payload contains and nothing else. That makes an offline
 * recall score a measurement of *what reached the context*, which is exactly
 * what the strategies differ on — and an upper bound on what a real model
 * would do with the same payload, never a prediction of it.
 */
export class FakeProvider extends LlmProvider {
  #delayMs;
  #reply;

  constructor({ delayMs = 400, reply } = {}) {
    super();
    this.#delayMs = delayMs;
    this.#reply = reply;
  }

  get model() {
    return "fake-provider";
  }

  async complete({ system, messages, maxTokens = 1024 }) {
    await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    let text = this.#reply ?? fakeAnswer({ system, messages, lastUser: lastUser?.content ?? "" });

    // Honour the ceiling the same way a real model does: stop mid-sentence and
    // say so, so the truncation path is reachable offline.
    const outputTokens = approximateTokens(text);
    const hitCeiling = outputTokens > maxTokens;
    if (hitCeiling) text = text.slice(0, maxTokens * 4);

    return {
      text,
      model: "fake-provider",
      stopReason: hitCeiling ? "max_tokens" : "end_turn",
      usage: {
        inputTokens: (await this.countTokens({ system, messages })).inputTokens,
        outputTokens: Math.min(outputTokens, maxTokens),
      },
    };
  }

  async countTokens({ system, messages }) {
    const body = (messages ?? []).map((m) => m.content).join("\n");
    // A few tokens of per-message envelope, like the real endpoint charges.
    const envelope = (messages ?? []).length * 3;
    return { inputTokens: approximateTokens(system ?? "") + approximateTokens(body) + envelope };
  }
}

function approximateTokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

/** Route the request to whichever of the three shapes it is asking for. */
function fakeAnswer({ system, messages, lastUser }) {
  if (looksLikeSummarisation(system)) return fakeSummary(lastUser);
  // Before the promotion check: both are stage-boundary calls and both open by
  // saying a piece of work has reached an edge, so the more specific test goes
  // first rather than relying on two first lines staying different.
  if (looksLikeBriefing(system)) return fakeBrief(lastUser);
  if (looksLikePromotion(system)) return fakeProposals(lastUser);
  if (looksLikeFactExtraction(system)) return fakeFactOps(lastUser);
  if (looksLikeQuestion(lastUser)) return fakeRecall({ system, messages, lastUser });
  return (
    `(fake reply) You said: "${lastUser}". ` +
    "No API key is configured, so nothing was sent to a real model."
  );
}

/**
 * A question gets the contents of the payload read back at it: the auxiliary
 * block from the system prompt first, then the user messages still on the
 * wire. Whatever the strategy kept, the fake can repeat; whatever it dropped,
 * the fake cannot. That is the only honest thing an offline provider can say
 * about recall.
 */
function fakeRecall({ system, messages, lastUser }) {
  // Every auxiliary block, not just the first: the layered strategy sends four
  // of them, and a fake that read one would make the other three look like
  // they had never been sent at all. `brief` is the newest, and it is the one
  // that most needs reflecting — it is the only thing standing in for a whole
  // conversation that is no longer on the wire.
  const blocks = [
    ...String(system ?? "").matchAll(/<(known_facts|conversation_summary|profile|working|brief)>([\s\S]*?)<\/\1>/g),
  ];
  const visible = (messages ?? [])
    .filter((m) => m.role === "user" && m.content !== lastUser)
    .map((m) => "- " + String(m.content).replace(/\s+/g, " "));

  return [
    "(fake reply) I do not reason — here is everything I can currently see.",
    ...(blocks.length
      ? blocks.flatMap((block) => [
          `From the ${block[1]} block:`,
          // The first line of every block is its own instruction to the model,
          // not content, so it is dropped rather than read back.
          block[2].trim().split("\n").slice(1).join("\n"),
        ])
      : ["There is no auxiliary block in my system prompt."]),
    visible.length ? "From the messages still in my window:" : "No earlier messages are in my window.",
    ...visible,
  ]
    .filter(Boolean)
    .join("\n");
}

/** A question, roughly: the shape the scenario's final turn takes. */
function looksLikeQuestion(text) {
  const said = String(text ?? "");
  return /\?/.test(said) || /\b(what|which|who|when|where|remind|recap|list|read .* back)\b/i.test(said);
}

/**
 * The extractor's system prompt is recognisable by the operation format it
 * demands. The offline answer records **every** user message under a key
 * derived from its own text — a content hash, so the same message always lands
 * on the same key and re-stating something is an idempotent `set` rather than
 * a new fact.
 *
 * This is the most generous extractor imaginable: it makes no judgement about
 * what is worth keeping, which is the hard part of the real task. Offline it
 * measures the plumbing — patching, capping, eviction, the block reaching the
 * system prompt — and nothing about extraction quality.
 */
function fakeFactOps(prompt) {
  const exchange = String(prompt).split("\n");
  const start = exchange.findIndex((line) => line.startsWith("LATEST EXCHANGE:"));
  const said = exchange
    .slice(start + 1)
    .filter((line) => line.startsWith("[user] "))
    .map((line) => line.slice(7).replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (!said.length) return "[]";
  return JSON.stringify(
    said.map((value) => ({ op: "set", key: "decision." + hash(value), value }))
  );
}

function looksLikeFactExtraction(system) {
  return typeof system === "string" && system.includes('{"op":"set"');
}

/**
 * The stage-boundary call that writes the handoff brief.
 *
 * The offline answer is the store, laid out under the headings a real brief
 * uses — and nothing else. A real briefer reads the conversation and writes
 * prose about it; a fake that pretended to would hide the only hard part of
 * the job, which is noticing what was established in the talking and never
 * made it into a key.
 */
function fakeBrief(prompt) {
  const lines = String(prompt).split("\n");
  const start = lines.findIndex((line) => line.startsWith("WHAT PLANNING ESTABLISHED"));
  const stop = lines.findIndex((line) => line.startsWith("THE PLANNING CONVERSATION"));
  const entries = lines.slice(start + 1, stop === -1 ? undefined : stop).filter((line) => line.includes(":"));

  const under = (prefix) =>
    entries.filter((line) => line.startsWith(prefix)).map((line) => "- " + line.slice(line.indexOf(":") + 1).trim());
  const section = (title, rows) => (rows.length ? [title, ...rows, ""] : []);

  return [
    "(offline brief — the store, not a reading of the conversation)",
    "",
    ...section("The task", under("goal")),
    ...section("Constraints", under("constraint")),
    ...section("Decided", [...under("decision"), ...under("agreement")]),
    ...section("Established", under("finding")),
    ...section("Still open", under("open")),
  ].join("\n").trim();
}

function looksLikeBriefing(system) {
  return typeof system === "string" && system.includes("handoff brief");
}

/**
 * The task-boundary call. The offline answer proposes every candidate it was
 * handed, unchanged except for a prefix that makes the one thing it cannot do
 * obvious: a real promoter **rephrases** each value so it stands alone, and a
 * fake that pretended to would hide the only hard part of the job.
 */
function fakeProposals(prompt) {
  const lines = String(prompt).split("\n");
  const start = lines.findIndex((line) => line.startsWith("PROMOTION CANDIDATES:"));
  const candidates = [];

  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) break;
    const at = line.indexOf(":");
    if (at === -1) continue;
    candidates.push({
      key: line.slice(0, at).trim(),
      value: "From a finished task: " + line.slice(at + 1).trim(),
    });
  }

  return JSON.stringify(candidates);
}

function looksLikePromotion(system) {
  return typeof system === "string" && system.startsWith("A piece of work has just finished");
}

/** Small, stable and dependency-free — enough to key a fact by its content. */
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * The Summarizer's system prompt is recognisable by its opening line.
 * Matching on it lets the offline provider return something summary-shaped
 * rather than a canned sentence, so the summary panel can be exercised without
 * a key. The text is still synthetic — it quotes the material back rather than
 * understanding it.
 *
 * It deliberately does not match on the section headers: those also appear in
 * the summary *block*, which rides along in the conversation's own system
 * prompt, and matching them made the agent answer every ordinary turn with a
 * summary of itself.
 */
function looksLikeSummarisation(system) {
  return typeof system === "string" && system.startsWith("You maintain a running summary");
}

/**
 * The offline summary is **incremental**, like the real one: it keeps the
 * bullets already in the summary it was handed and appends the ones that have
 * just fallen out. A fake that rewrote the whole thing from the newest slice
 * would quietly make compression look like forgetting, which is the one thing
 * the strategy is supposed not to do.
 */
function fakeSummary(prompt) {
  const lines = String(prompt).split("\n");
  const from = (header) => {
    const at = lines.findIndex((line) => line.startsWith(header));
    return at === -1 ? [] : lines.slice(at + 1);
  };

  const kept = from("SUMMARY SO FAR:")
    .filter((line) => line.startsWith("- said: "))
    .map((line) => line.trim());
  const dropped = from("MESSAGES THAT HAVE JUST LEFT")
    .filter((line) => line.startsWith("[user] "))
    .map((line) => "- said: " + line.slice(7).replace(/\s+/g, " ").trim().slice(0, 160))
    .filter((line) => line.length > 8);

  const bullets = [...kept, ...dropped];

  return [
    "## Facts about the user",
    ...(bullets.length ? bullets : ["- none"]),
    "",
    "## Decisions made",
    "- none (fake-provider does not read, it only reflects)",
    "",
    "## Preferences and constraints",
    "- none",
    "",
    "## Open questions",
    "- none",
    "",
    "## Discarded / superseded",
    "- none",
  ].join("\n");
}

