import { pickGraph } from "./branches.js";
import {
  ConversationStore,
  emptyUsage,
  isValidSessionId,
  normaliseMessages,
  normaliseRecord,
  normaliseUsage,
  titleFrom,
  UNTITLED,
} from "./conversationStore.js";
import { projectOf } from "./invariantStore.js";

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

  async save(sessionId, messages, usage, graph) {
    assertValid(sessionId);

    const now = new Date().toISOString();
    const existing = this.#records.get(sessionId);
    const turns = normaliseMessages(messages);

    const record = {
      id: sessionId,
      // Derived once and preserved afterwards — a conversation that keeps
      // renaming itself is disorienting. But the **placeholder is not a
      // title**, and a record saved before its first message carries one, so
      // it is re-derived until there is something real to derive it from.
      // That also heals any conversation already stuck with the placeholder.
      title: existing?.title && existing.title !== UNTITLED ? existing.title : titleFrom(turns),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      usage: usage ? normaliseUsage(usage) : (existing?.usage ?? emptyUsage()),
      ...(graph ?? pickGraph(existing)),
      project: projectOf(graph?.project ?? existing?.project),
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
        branchCount: Object.keys(record.branches ?? {}).length,
        totalCostUsd: record.usage?.totalCostUsd ?? 0,
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
  return { ...record, ...normaliseRecord(record) };
}
