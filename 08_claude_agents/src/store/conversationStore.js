/**
 * The conversation-storage abstraction.
 *
 * Everything above this boundary (the Agent, the routes) speaks only in the
 * neutral shapes defined here: a session id, a `{ role, content }` message
 * array — the very same one `LlmProvider` takes — and a conversation record.
 * Nothing storage-specific — no paths, no file handles, no SQL — is allowed to
 * cross it.
 */

/**
 * @typedef {import("../llm/provider.js").Message} Message
 * @typedef {{ request?: number | null, sent?: number | null, input?: number | null, output?: number | null, total?: number | null }} TurnTokens
 * @typedef {Message & { tokens?: TurnTokens }} StoredMessage
 * @typedef {{ totalInputTokens: number, totalOutputTokens: number, totalCostUsd: number, turnCount: number }} ConversationUsage
 * @typedef {{ id: string, title: string, createdAt: string, updatedAt: string, usage: ConversationUsage, messages: StoredMessage[] }} Conversation
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
   * @param {StoredMessage[]} messages
   * @param {ConversationUsage} [usage] - Cumulative totals for the conversation.
   * @returns {Promise<Conversation>} The record as persisted.
   */
  // eslint-disable-next-line no-unused-vars
  async save(sessionId, messages, usage) {
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
export function titleFrom(messages) {
  const first = messages?.find?.((m) => m?.role === "user")?.content ?? "";
  const text = String(first).replace(/\s+/g, " ").trim();
  if (!text) return "New conversation";
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1).trimEnd() + "…" : text;
}

/** A conversation that has cost nothing yet. @returns {ConversationUsage} */
export function emptyUsage() {
  return { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, turnCount: 0 };
}

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
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) base[key] = value;
  }
  return base;
}

/**
 * Keep exactly the fields a stored message is allowed to have. `tokens` rides
 * along when a turn was measured and is simply absent when it wasn't — which
 * is the case for every message written before this version.
 *
 * @param {StoredMessage[]} [messages]
 * @returns {StoredMessage[]}
 */
export function normaliseMessages(messages) {
  return (messages ?? []).map((message) => {
    const stored = { role: message.role, content: message.content };
    if (message.tokens) stored.tokens = { ...message.tokens };
    if (message.cost) stored.cost = { ...message.cost };
    if (message.model) stored.model = message.model;
    if (typeof message.ms === "number") stored.ms = message.ms;
    if (message.stopReason) stored.stopReason = message.stopReason;
    if (message.truncated) stored.truncated = true;
    return stored;
  });
}
