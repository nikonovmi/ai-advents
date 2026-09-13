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
 * @typedef {{ id: string, title: string, createdAt: string, updatedAt: string, messages: Message[] }} Conversation
 * @typedef {{ id: string, title: string, updatedAt: string, messageCount: number }} ConversationSummary
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
   * @param {Message[]} messages
   * @returns {Promise<Conversation>} The record as persisted.
   */
  // eslint-disable-next-line no-unused-vars
  async save(sessionId, messages) {
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
 * @param {Message[]} messages
 * @returns {string}
 */
export function titleFrom(messages) {
  const first = messages?.find?.((m) => m?.role === "user")?.content ?? "";
  const text = String(first).replace(/\s+/g, " ").trim();
  if (!text) return "New conversation";
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1).trimEnd() + "…" : text;
}
