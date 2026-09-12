import { ConversationStore, isValidSessionId, titleFrom } from "./conversationStore.js";

/**
 * The same contract, backed by a Map. Tests get persistence semantics with no
 * disk access, and the server can fall back to it when the data directory
 * turns out to be unwritable.
 */
export class MemoryStore extends ConversationStore {
  /** @type {Map<string, import("./conversationStore.js").Conversation>} */
  #records = new Map();

  async load(sessionId) {
    assertValid(sessionId);
    const record = this.#records.get(sessionId);
    return record ? clone(record) : null;
  }

  async save(sessionId, messages) {
    assertValid(sessionId);

    const now = new Date().toISOString();
    const existing = this.#records.get(sessionId);
    const turns = (messages ?? []).map(({ role, content }) => ({ role, content }));

    const record = {
      id: sessionId,
      title: existing?.title ?? titleFrom(turns),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messages: turns,
    };

    this.#records.set(sessionId, record);
    return clone(record);
  }

  async clear(sessionId) {
    assertValid(sessionId);
    this.#records.delete(sessionId);
  }

  async listSessions() {
    return [...this.#records.values()]
      .map((record) => ({
        id: record.id,
        title: record.title,
        updatedAt: record.updatedAt,
        messageCount: record.messages.length,
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
}

function assertValid(sessionId) {
  if (!isValidSessionId(sessionId)) {
    throw new Error("Invalid sessionId: expected a UUID v4");
  }
}

/** Callers get a copy, so they cannot mutate what the store is holding. */
function clone(record) {
  return { ...record, messages: record.messages.map((turn) => ({ ...turn })) };
}
