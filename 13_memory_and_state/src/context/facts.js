import { exchangeStarts, takeLastExchanges } from "./boundaries.js";
import { ContextStrategy, NO_OVERHEAD, overheadFrom } from "./strategy.js";

/** The namespaces a key may live in. Anything else is discarded on arrival. */
export const FACT_NAMESPACES = ["goal", "constraint", "preference", "decision", "agreement"];

/** `constraint.database`, `preference.tooling`, or a bare `goal`. */
const KEY_PATTERN = new RegExp(
  `^(${FACT_NAMESPACES.join("|")})(\\.[a-z0-9][a-z0-9_-]*){0,2}$`
);

const MAX_VALUE_LENGTH = 240;
/** How many superseded values a key remembers, so the UI can show a change. */
const HISTORY_DEPTH = 3;

const EXTRACTOR_PROMPT = [
  "You maintain a small key-value store of established facts about an ongoing",
  "conversation. You are shown the keys that already exist and the latest exchange.",
  "",
  "Return ONLY the changes the latest exchange makes: a JSON array of operations,",
  "and nothing else.",
  "",
  'Format: [{"op":"set","key":"constraint.database","value":"Postgres 14 on port 8477"},',
  '         {"op":"delete","key":"preference.tooling"}]',
  "",
  "Rules:",
  "- Return [] when the exchange establishes nothing new. Most turns establish nothing.",
  "- Never restate a fact that is already stored and unchanged. This is a patch, not the",
  "  whole store.",
  "- **A reversal is the single most important thing to catch.** When the exchange changes,",
  "  corrects, contradicts or reverses something an existing key stands for, you must emit a",
  "  `set` for that exact key with the new value. 'Actually…', 'correction', 'change of plan',",
  "  'scratch that', 'we decided the opposite' and 'reverse that' all mean a `set`, not nothing.",
  "  A stale fact left in the store is worse than a fact that was never recorded.",
  "- Keys are lowercase and dotted, and must begin with one of: " + FACT_NAMESPACES.join(" "),
  "  (a bare namespace such as `goal` is also a valid key). At most three segments.",
  "- Reuse an existing key when the exchange updates that fact — `set` overwrites it.",
  "  Only invent a key when nothing listed fits.",
  "- Keep names, numbers, file paths, versions, port numbers and dates **exactly** as the",
  "  user stated them. Never round, rename or paraphrase a specific value.",
  "- Values are under 20 words.",
  "- Use `delete` only when the user explicitly withdraws something, never because they",
  "  have stopped mentioning it.",
  "- Record what the USER established. Do not record the assistant's own suggestions.",
  "- Output the JSON array and nothing else: no prose, no explanation, no code fences.",
].join("\n");

/**
 * Wrap the fact store for the system prompt — same placement as the summary,
 * and for the same reason: this is briefing material, not something the model
 * said out loud.
 *
 * An empty store produces an empty string. A header with nothing under it is
 * an invitation to invent what belongs there.
 *
 * @param {Record<string, { value: string }>} facts
 * @returns {string}
 */
export function factsBlock(facts) {
  const lines = sortedKeys(facts).map((key) => `${key}: ${facts[key].value}`);
  if (!lines.length) return "";
  return [
    "",
    "",
    "<known_facts>",
    "Established facts about this conversation. Treat as true unless the user corrects them.",
    ...lines,
    "</known_facts>",
  ].join("\n");
}

/**
 * The extraction call: current keys plus the latest exchange in, a patch out.
 *
 * Separated from the strategy the way `Summarizer` is separated from the
 * summarization strategy — it is the part with a prompt in it, and the part a
 * test wants to replace.
 */
export class FactExtractor {
  #provider;

  /**
   * @param {object} params
   * @param {import("../llm/provider.js").LlmProvider} params.provider
   * @param {string} [params.model]
   * @param {number} [params.maxTokens] - A patch is a handful of short lines.
   *   The ceiling is low because this runs on **every** user message, and a
   *   generous one here is the difference between a rounding error and the
   *   dominant cost of the conversation.
   */
  constructor({ provider, model, maxTokens = 300 } = {}) {
    if (!provider || typeof provider.complete !== "function") {
      throw new Error("FactExtractor requires a provider with a complete() method");
    }
    this.#provider = provider;
    this.model = model;
    this.maxTokens = maxTokens;
  }

  /**
   * @param {object} params
   * @param {string[]} params.keys - Exactly the keys already stored.
   * @param {import("../llm/provider.js").Message[]} params.exchange
   * @returns {Promise<{ ops: object[], usage, model, ms, raw: string }>}
   */
  async extract({ keys = [], exchange = [] } = {}) {
    const startedAt = Date.now();
    const result = await this.#provider.complete({
      model: this.model,
      system: EXTRACTOR_PROMPT,
      messages: [{ role: "user", content: extractionPrompt(keys, exchange) }],
      // A patch that reworded itself every turn would rewrite the store for no
      // reason, and the UI would flash rows that did not actually change.
      temperature: 0,
      maxTokens: this.maxTokens,
    });

    const raw = String(result?.text ?? "");
    return {
      ops: parseOps(raw),
      usage: result?.usage ?? { inputTokens: 0, outputTokens: 0 },
      model: result?.model ?? null,
      ms: Date.now() - startedAt,
      raw,
    };
  }
}

/**
 * Last N exchanges, plus a key-value block of everything that has been
 * established, in the system prompt.
 *
 * The design decision that matters is not the prompt, it is that extraction is
 * **patch-based and never regenerative**. Asking the model for the whole fact
 * set each turn reads as the cheaper option — one call, one source of truth —
 * and it silently drops every fact it did not happen to restate. That is not a
 * degraded summary; it is a fact that was true last turn and is simply gone
 * this turn, with nothing in the output to say so. It is the exact failure
 * this strategy exists to prevent, so the model is only ever allowed to
 * propose `set` and `delete`, and the store is changed deterministically in
 * code.
 *
 * The other thing worth knowing before choosing it: it extracts on **every**
 * user message, where summarization folds once every `window / 2` turns. The
 * per-call bill is much smaller, but the call count is the whole window
 * larger, and which of those wins is a measurement rather than an opinion.
 */
export class FactsStrategy extends ContextStrategy {
  #extractor;
  #cachedFor = null;

  /**
   * @param {object} [params]
   * @param {number} [params.contextMessages]
   * @param {number} [params.maxFacts] - The store is a fixed-size budget, not
   *   a log. Past this many the least recently updated is evicted.
   * @param {number} [params.maxTokens]
   * @param {string} [params.model]
   * @param {FactExtractor} [params.extractor]
   */
  constructor({ contextMessages = 10, maxFacts = 40, maxTokens = 300, model, extractor } = {}) {
    super();
    this.contextMessages = contextMessages;
    this.maxFacts = maxFacts;
    this.maxTokens = maxTokens;
    this.model = model;
    this.#extractor = extractor ?? null;
  }

  get id() {
    return "facts";
  }

  get label() {
    return "Extracted facts";
  }

  get description() {
    return "Last N exchanges plus a key-value block of everything established. One small call on every user message.";
  }

  emptyState() {
    return { facts: {} };
  }

  async buildPayload({ history, systemPrompt, state, provider, model }) {
    // The turn number is derived from the branch rather than counted in state,
    // because state is copied when a branch forks and a counter copied from a
    // longer branch is simply wrong on the shorter one.
    const turn = exchangeStarts(history).length;
    // And for the same reason, a fact stamped with this turn or later did not
    // come from this branch: it was established further down whichever branch
    // this one was forked from. It is dropped rather than shown, because the
    // model repeating something nobody on this branch ever said does not read
    // as a storage bug — it reads as a hallucination.
    const current = { facts: factsAsOf(normaliseState(state).facts, turn - 1) };

    const extracted = await this.#extract({ history, state: current, provider, model, turn });
    const facts = extracted.facts;
    const { start, messages } = takeLastExchanges(history, this.contextMessages);

    return {
      system: systemPrompt + factsBlock(facts),
      messages,
      state: { facts },
      meta: {
        ...(extracted.overhead ?? NO_OVERHEAD),
        note: extracted.note,
        droppedMessages: start,
        factCount: Object.keys(facts).length,
        setKeys: extracted.set,
        deletedKeys: extracted.deleted,
        changedKeys: [...extracted.set, ...extracted.deleted],
        discardedOps: extracted.discarded,
        verbatimExchanges: exchangeStarts(history, start).length,
      },
    };
  }

  panel(state, { turns = Infinity } = {}) {
    const facts = factsAsOf(normaliseState(state).facts, turns);
    return {
      kind: "facts",
      title: "Known facts",
      facts: sortedKeys(facts).map((key) => ({
        key,
        namespace: key.split(".")[0],
        value: facts[key].value,
        updatedAt: facts[key].updatedAt,
        turn: facts[key].turn,
        previous: [...(facts[key].previous ?? [])].reverse(),
      })),
      note: Object.keys(facts).length
        ? ""
        : "Nothing has been established yet — the block is omitted from the system prompt entirely.",
    };
  }

  /**
   * Run the extractor over the latest exchange and apply the patch.
   *
   * It runs **before** the main call so that the turn which establishes a fact
   * is already answered with it in view. The "latest exchange" available at
   * that point is the new user message with the reply before it for context —
   * the assistant's answer to this message does not exist yet, and waiting for
   * it would mean every fact arrived a turn late.
   *
   * Total failure is non-fatal: keep the facts we have, note it, answer the
   * turn. A malformed individual op is discarded on its own and the rest of
   * the patch still applies.
   */
  async #extract({ history, state, provider, model, turn }) {
    const exchange = latestExchange(history);
    if (!exchange.length) {
      return { facts: state.facts, set: [], deleted: [], discarded: 0, note: "nothing to extract from" };
    }

    const startedAt = Date.now();
    let result;
    try {
      result = await this.#extractorFor(provider).extract({
        keys: sortedKeys(state.facts),
        exchange,
      });
    } catch (err) {
      console.error("[facts] extraction failed, keeping the existing facts:", err?.message ?? err);
      return {
        facts: state.facts,
        set: [],
        deleted: [],
        discarded: 0,
        note: "extraction failed — existing facts kept",
        overhead: { ...NO_OVERHEAD, overheadMs: Date.now() - startedAt },
      };
    }

    const applied = applyOps(state.facts, result.ops, { turn, maxFacts: this.maxFacts });

    return {
      ...applied,
      note: describe(applied),
      overhead: overheadFrom({
        usage: result.usage,
        model: result.model ?? model,
        ms: result.ms ?? Date.now() - startedAt,
      }),
    };
  }

  #extractorFor(provider) {
    if (this.#extractor && this.#cachedFor === null) return this.#extractor;
    if (this.#cachedFor !== provider) {
      this.#extractor = new FactExtractor({
        provider,
        model: this.model,
        maxTokens: this.maxTokens,
      });
      this.#cachedFor = provider;
    }
    return this.#extractor;
  }
}

/**
 * Apply a patch to the store, deterministically and in code.
 *
 * Exported because this — not the prompt — is where the strategy's promises
 * live: an unknown key shape is refused, an overwrite keeps what it replaced,
 * and the store never grows past its budget.
 *
 * @param {Record<string, object>} facts
 * @param {unknown[]} ops
 * @param {{ turn: number, maxFacts: number }} params
 */
export function applyOps(facts, ops, { turn = 0, maxFacts = 40 } = {}) {
  const next = { ...facts };
  const set = [];
  const deleted = [];
  let discarded = 0;
  const now = new Date().toISOString();

  for (const op of Array.isArray(ops) ? ops : []) {
    const key = typeof op?.key === "string" ? op.key.trim().toLowerCase() : "";
    const action = typeof op?.op === "string" ? op.op.trim().toLowerCase() : "";

    if (!KEY_PATTERN.test(key)) {
      discarded++;
      continue;
    }

    if (action === "delete") {
      if (key in next) {
        delete next[key];
        deleted.push(key);
      }
      continue;
    }

    if (action !== "set") {
      discarded++;
      continue;
    }

    const value = String(op.value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_VALUE_LENGTH);
    if (!value) {
      discarded++;
      continue;
    }
    // A `set` that changes nothing is not a change: it must not re-stamp the
    // timestamp (which drives eviction) or flash the row in the UI.
    if (next[key]?.value === value) continue;

    const previous = next[key]
      ? [...(next[key].previous ?? []), next[key].value].slice(-HISTORY_DEPTH)
      : [];
    next[key] = { value, updatedAt: now, turn, previous };
    set.push(key);
  }

  return { facts: evict(next, maxFacts), set, deleted, discarded };
}

/** Drop the least recently updated keys until the store fits its budget. */
function evict(facts, maxFacts) {
  const limit = Math.max(1, Math.floor(maxFacts));
  const keys = Object.keys(facts);
  if (keys.length <= limit) return facts;

  const ordered = keys.sort((a, b) => {
    const byTime = String(facts[a].updatedAt ?? "").localeCompare(String(facts[b].updatedAt ?? ""));
    return byTime !== 0 ? byTime : (facts[a].turn ?? 0) - (facts[b].turn ?? 0);
  });

  const kept = { ...facts };
  for (const key of ordered.slice(0, keys.length - limit)) delete kept[key];
  return kept;
}

/** One human line for the per-turn counter. */
function describe({ set, deleted, discarded }) {
  const parts = [];
  if (set.length) parts.push(`${set.length} fact${set.length === 1 ? "" : "s"} set`);
  if (deleted.length) parts.push(`${deleted.length} deleted`);
  if (discarded) parts.push(`${discarded} malformed op${discarded === 1 ? "" : "s"} discarded`);
  return parts.length ? parts.join(", ") : "nothing new established";
}

/**
 * The newest user message, with the reply before it for context. Two messages
 * is enough for "yes, do that" to mean something and small enough that the
 * extraction call stays a rounding error next to the turn it precedes.
 */
function latestExchange(history) {
  const messages = history ?? [];
  const last = messages.length - 1;
  if (last < 0) return [];
  const from = last > 0 && messages[last - 1].role === "assistant" ? last - 1 : last;
  return messages.slice(from).map(({ role, content }) => ({ role, content }));
}

function extractionPrompt(keys, exchange) {
  return [
    "EXISTING KEYS:",
    keys.length ? keys.join("\n") : "(none yet)",
    "",
    "LATEST EXCHANGE:",
    ...exchange.map((m) => `[${m.role}] ${m.content}`),
    "",
    "Return the operations.",
  ].join("\n");
}

/**
 * Pull the JSON array out of whatever came back. A model that ignored "no code
 * fences" or prefixed a sentence has still done the work, and throwing that
 * away would cost the turn a fact for a formatting slip.
 */
function parseOps(raw) {
  const text = String(raw ?? "").replace(/```(?:json)?/gi, "").trim();
  if (!text) return [];

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The store as it stood after `turns` exchanges: everything stamped later
 * belongs to a longer branch this one was forked from, and is not ours.
 *
 * @param {Record<string, object>} facts
 * @param {number} turns
 */
export function factsAsOf(facts, turns) {
  if (!Number.isFinite(turns)) return facts;
  const kept = {};
  for (const [key, entry] of Object.entries(facts ?? {})) {
    if ((entry.turn ?? 0) <= turns) kept[key] = entry;
  }
  return kept;
}

/** Sorted by key, which groups the namespaces together for free. */
function sortedKeys(facts) {
  return Object.keys(facts ?? {}).sort();
}

/** Whatever came off disk, coerced into a state this strategy can work with. */
function normaliseState(state) {
  const facts = {};
  const source = state?.facts;
  if (source && typeof source === "object") {
    for (const [key, entry] of Object.entries(source)) {
      const value = String(entry?.value ?? "").trim();
      if (!KEY_PATTERN.test(key) || !value) continue;
      facts[key] = {
        value,
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
        turn: Number.isInteger(entry.turn) ? entry.turn : 0,
        previous: Array.isArray(entry.previous)
          ? entry.previous.filter((v) => typeof v === "string").slice(-HISTORY_DEPTH)
          : [],
      };
    }
  }
  return { facts };
}
