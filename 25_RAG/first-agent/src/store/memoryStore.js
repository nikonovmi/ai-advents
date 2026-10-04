import { agentOf } from "../agents.js";
import {
  ConversationStore,
  emptyUsage,
  isValidSessionId,
  memoryOf,
  normaliseMessages,
  normaliseRecord,
  normaliseUsage,
  ragModeOf,
  ragOptionsOf,
  explicitTitle,
  titleFrom,
  UNTITLED,
} from "./conversationStore.js";
import { taskMemoryOf } from "../rag/taskMemory.js";
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

  async save(sessionId, messages, usage, extra) {
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
      // An explicit title (a scheduled chat's prompt) wins over both.
      title: explicitTitle(extra?.title) ?? (existing?.title && existing.title !== UNTITLED ? existing.title : titleFrom(turns)),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      usage: usage ? normaliseUsage(usage) : (existing?.usage ?? emptyUsage()),
      // An absent field means "unchanged", not "cleared". A caller that does
      // not know invariants exist must not silently move the conversation to
      // another rule set, and one that is only writing a message must not wipe
      // the memory state or forget where the conversation was forked from.
      project: projectOf(extra?.project ?? existing?.project),
      agentId: agentOf(extra?.agentId ?? existing?.agentId),
      forkedFrom: extra?.forkedFrom ?? existing?.forkedFrom ?? null,
      // Only a Knowledge chat has one; nothing else grows the field.
      ...(ragModeOf(extra?.ragMode ?? existing?.ragMode) ? { ragMode: ragModeOf(extra?.ragMode ?? existing?.ragMode) } : {}),
      ...(ragOptionsOf(extra?.ragOptions ?? existing?.ragOptions) ? { ragOptions: ragOptionsOf(extra?.ragOptions ?? existing?.ragOptions) } : {}),
      memory: memoryOf(extra?.memory ?? existing?.memory),
      // Day 25: only a Knowledge chat with RAG has one.
      ...((extra?.taskMemory ?? existing?.taskMemory) ? { taskMemory: taskMemoryOf(extra?.taskMemory ?? existing?.taskMemory) } : {}),
      messages: turns,
    };

    this.#records.set(sessionId, record);
    return clone(record);
  }

  async clear(sessionId) {
    assertValid(sessionId);
    this.#records.delete(sessionId);
  }

  async listSessions({ agentId } = {}) {
    return [...this.#records.values()]
      .filter((record) => !agentId || record.agentId === agentId)
      .map((record) => ({
        id: record.id,
        title: record.title,
        updatedAt: record.updatedAt,
        messageCount: record.messages.length,
        agentId: record.agentId,
        forkedFrom: record.forkedFrom ?? null,
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
