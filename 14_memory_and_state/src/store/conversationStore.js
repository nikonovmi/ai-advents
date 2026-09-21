/**
 * The conversation-storage abstraction.
 *
 * Everything above this boundary (the Agent, the routes) speaks only in the
 * neutral shapes defined here: a session id, a `{ role, content }` message
 * array — the very same one `LlmProvider` takes — and a conversation record.
 * Nothing storage-specific — no paths, no file handles, no SQL — is allowed to
 * cross it.
 *
 * Since branching, a record holds a **pool** of messages rather than a list:
 * every message names its parent, and a branch is a pointer to the last one on
 * it. A file written before that is a pool with exactly one chain in it, which
 * is why it still loads. See `branches.js`.
 */

import { normaliseGraph } from "./branches.js";
import { projectOf } from "./invariantStore.js";

/**
 * @typedef {import("../llm/provider.js").Message} Message
 * @typedef {{ request?: number | null, sent?: number | null, input?: number | null, output?: number | null, total?: number | null }} TurnTokens
 * @typedef {{ id: string, label: string, overheadTokens: number, overheadCost: number | null, overheadMs: number | null, overheadCalls: number, blockTokens: number | null, note: string }} TurnStrategy
 * @typedef {Message & { id: string, parentId: string | null, tokens?: TurnTokens, strategy?: TurnStrategy }} StoredMessage
 * @typedef {{ totalInputTokens: number, totalOutputTokens: number, totalCostUsd: number, turnCount: number, overheadInputTokens: number, overheadOutputTokens: number, overheadCostUsd: number, overheadCalls: number }} ConversationUsage
 * @typedef {import("./branches.js").Branch} Branch
 * @typedef {{ branches: Record<string, Branch>, activeBranchId: string }} ConversationGraph
 * @typedef {{ id: string, title: string, createdAt: string, updatedAt: string, usage: ConversationUsage, branches: Record<string, Branch>, activeBranchId: string, messages: StoredMessage[] }} Conversation
 * @typedef {{ id: string, title: string, updatedAt: string, messageCount: number, totalCostUsd: number }} ConversationSummary
 */

export class ConversationStore {
  /**
   * @param {string} sessionId
   * @returns {Promise<Conversation | null>} The stored conversation, or null.
   */
  // eslint-disable-next-line no-unused-vars
  async load(sessionId) {
    throw new Error("Not implemented");
  }

  /**
   * @param {string} sessionId
   * @param {StoredMessage[]} messages - The whole pool, every branch.
   * @param {ConversationUsage} [usage] - Cumulative totals for the conversation.
   * @param {ConversationGraph} [graph] - The branch map and which one is live.
   * @returns {Promise<Conversation>} The record as persisted.
   */
  // eslint-disable-next-line no-unused-vars
  async save(sessionId, messages, usage, graph) {
    throw new Error("Not implemented");
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async clear(sessionId) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<ConversationSummary[]>} Newest first. */
  async listSessions() {
    throw new Error("Not implemented");
  }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Session ids arrive from the client, so nothing downstream may treat one as
 * trustworthy until it has passed through here. A canonical UUID v4 contains
 * no separators, no dots and no slashes, which is exactly what makes it safe
 * to use as a filename.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidSessionId(id) {
  return typeof id === "string" && UUID_V4.test(id);
}

const TITLE_MAX = 40;

/**
 * Derive a conversation title from its first user message. Shared by the
 * implementations so every store titles a conversation the same way.
 *
 * @param {StoredMessage[]} messages
 * @returns {string}
 */
/**
 * What a conversation is called before anybody has said anything in it.
 *
 * Exported because it is a **placeholder, not a title**, and the stores have
 * to be able to tell the two apart. A record can now be written before its
 * first message — the memory panel's buttons work on a conversation nobody
 * has spoken in yet — and "titles are derived once and preserved afterwards"
 * quietly became "every conversation is called New conversation forever" the
 * moment that was true.
 */
export const UNTITLED = "New conversation";

export function titleFrom(messages) {
  const first = messages?.find?.((m) => m?.role === "user")?.content ?? "";
  const text = String(first).replace(/\s+/g, " ").trim();
  if (!text) return UNTITLED;
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1).trimEnd() + "…" : text;
}

/**
 * A conversation that has cost nothing yet.
 *
 * A strategy's own calls are counted in their own four fields rather than
 * folded into the conversation totals. Context management is sold as a saving,
 * and a saving whose cost has been quietly added to the thing it is being
 * compared against is not a measurement.
 *
 * @returns {ConversationUsage}
 */
export function emptyUsage() {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    turnCount: 0,
    overheadInputTokens: 0,
    overheadOutputTokens: 0,
    overheadCostUsd: 0,
    overheadCalls: 0,
  };
}

/** Day 9 called the overhead "summarizer", because there was only one kind. */
const LEGACY_USAGE_KEYS = {
  overheadInputTokens: "summarizerInputTokens",
  overheadOutputTokens: "summarizerOutputTokens",
  overheadCostUsd: "summarizerCostUsd",
};

/**
 * Coerce whatever is on disk into a usage record. Conversations written before
 * this existed have no `usage` key at all, and they must keep loading — an old
 * file is a conversation that cost an unknown amount, not a corrupt one.
 *
 * @param {unknown} usage
 * @returns {ConversationUsage}
 */
export function normaliseUsage(usage) {
  const base = emptyUsage();
  if (!usage || typeof usage !== "object") return base;
  for (const key of Object.keys(base)) {
    const value = usage[key] ?? usage[LEGACY_USAGE_KEYS[key]];
    if (typeof value === "number" && Number.isFinite(value)) base[key] = value;
  }
  return base;
}

/**
 * Keep exactly the fields a stored message is allowed to have. `tokens` rides
 * along when a turn was measured and is simply absent when it wasn't — which
 * is the case for every message written before that existed.
 *
 * @param {StoredMessage[]} [messages]
 * @returns {StoredMessage[]}
 */
export function normaliseMessages(messages) {
  return (messages ?? []).map((message) => {
    const stored = { role: message.role, content: message.content };
    if (message.id) stored.id = message.id;
    if (message.parentId) stored.parentId = message.parentId;
    if (message.tokens) stored.tokens = { ...message.tokens };
    if (message.cost) stored.cost = { ...message.cost };
    if (message.model) stored.model = message.model;
    if (typeof message.ms === "number") stored.ms = message.ms;
    if (message.stopReason) stored.stopReason = message.stopReason;
    if (message.truncated) stored.truncated = true;
    // What the strategy did on the turn that produced this message, so a
    // repainted transcript shows the same overhead the live one did.
    if (message.strategy) stored.strategy = { ...message.strategy };
    // Day 9 wrote the same idea under a different name and only ever for one
    // strategy. Kept so an old transcript still shows its own numbers.
    if (message.compression) stored.compression = { ...message.compression };
    return stored;
  });
}

/**
 * The whole record, coerced: usage, messages, and the branch graph.
 *
 * This is the single place a file from any earlier version becomes something
 * the current code can work with. It is called on read and never on write, so
 * an old file is migrated in memory and only takes its new shape the next time
 * something is actually saved to it.
 *
 * @param {object} data
 * @returns {Conversation}
 */
export function normaliseRecord(data) {
  const messages = normaliseMessages(data?.messages);
  const graph = normaliseGraph(data, messages);
  return {
    id: data?.id,
    title: data?.title,
    createdAt: data?.createdAt,
    updatedAt: data?.updatedAt,
    usage: normaliseUsage(data?.usage),
    // **Which project's rules this conversation is subject to.**
    //
    // It lives on the record rather than being folded into the user key
    // because it is a different question: the user key says whose long-term
    // memory to read, this says whose invariants apply. One person has two
    // codebases with two rule sets, and a field that answered both would have
    // to pick one of them and be wrong about the other. A record written
    // before this field existed loads as the default project, which is the
    // honest answer for a conversation nobody ever said belonged anywhere.
    project: projectOf(data?.project),
    ...graph,
  };
}
