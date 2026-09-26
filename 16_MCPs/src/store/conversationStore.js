/**
 * The conversation-storage abstraction.
 *
 * Everything above this boundary (the Agent, the routes) speaks only in the
 * neutral shapes defined here: a session id, a `{ role, content }` message
 * array — the very same one `LlmProvider` takes — and a conversation record.
 * Nothing storage-specific — no paths, no file handles, no SQL — is allowed to
 * cross it.
 *
 * A record holds a conversation as a flat list of messages, each with an `id`,
 * plus the strategy's `memory` state for it. There was a period when it held a
 * **pool** of messages and a map of branches pointing into it; forking now
 * produces a separate conversation instead, so `flatten()` below reads those
 * files back as the one branch that was active in them.
 */

import { agentOf } from "../agents.js";
import { projectOf } from "./invariantStore.js";

/**
 * @typedef {import("../llm/provider.js").Message} Message
 * @typedef {{ request?: number | null, sent?: number | null, input?: number | null, output?: number | null, total?: number | null }} TurnTokens
 * @typedef {{ id: string, label: string, overheadTokens: number, overheadCost: number | null, overheadMs: number | null, overheadCalls: number, blockTokens: number | null, note: string }} TurnStrategy
 * @typedef {Message & { id: string, tokens?: TurnTokens, strategy?: TurnStrategy }} StoredMessage
 * @typedef {{ totalInputTokens: number, totalOutputTokens: number, totalCostUsd: number, turnCount: number, overheadInputTokens: number, overheadOutputTokens: number, overheadCostUsd: number, overheadCalls: number }} ConversationUsage
 * @typedef {{ conversationId: string, messageId: string }} ForkOrigin
 * @typedef {{ memory?: object, project?: string, agentId?: string, forkedFrom?: ForkOrigin | null }} ConversationExtra
 * @typedef {{ id: string, title: string, createdAt: string, updatedAt: string, usage: ConversationUsage, project: string, agentId: string, forkedFrom: ForkOrigin | null, memory: object, messages: StoredMessage[] }} Conversation
 * @typedef {{ id: string, title: string, updatedAt: string, messageCount: number, agentId: string, forkedFrom: ForkOrigin | null, totalCostUsd: number }} ConversationSummary
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
   * @param {StoredMessage[]} messages - The whole conversation, oldest first.
   * @param {ConversationUsage} [usage] - Cumulative totals for the conversation.
   * @param {ConversationExtra} [extra] - The strategy's memory state, the
   *   project and agent the conversation belongs to, and where it was forked
   *   from. Each
   *   field is optional, and an absent one means *unchanged* rather than
   *   *cleared* — a caller that does not know a field exists must not wipe it.
   * @returns {Promise<Conversation>} The record as persisted.
   */
  // eslint-disable-next-line no-unused-vars
  async save(sessionId, messages, usage, extra) {
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

  /**
   * @param {{ agentId?: string }} [filter] - Which agent's conversations to
   *   list. Each agent has its own list, so an absent filter means *every*
   *   conversation rather than every agent's default.
   * @returns {Promise<ConversationSummary[]>} Newest first.
   */
  // eslint-disable-next-line no-unused-vars
  async listSessions(filter) {
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
 * Every message gets an `id`, because that is what a fork is taken at and what
 * the page hangs its fork button on. A message from a file old enough not to
 * have one is numbered by its position, which is the id it would have been
 * given had it been written today.
 *
 * @param {StoredMessage[]} [messages]
 * @returns {StoredMessage[]}
 */
export function normaliseMessages(messages) {
  return withIds(messages ?? []).map((message) => {
    const stored = { role: message.role, content: message.content, id: message.id };
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
  const flat = flatten(data);
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
    // **Which agent answers this conversation.** It is on the record rather
    // than chosen per request because the transcript below was written by one
    // persona, and a dropdown that silently re-pointed an open chat at another
    // would make the two halves of it disagree for no stated reason. A record
    // written before this field existed reads back as the default agent, which
    // is the honest answer for a conversation nobody ever assigned.
    agentId: agentOf(data?.agentId),
    // **Which conversation this one was split off from**, or null. It is a
    // provenance note and nothing more: a fork is a conversation in its own
    // right from the moment it exists, and deleting its parent does not
    // orphan it, because it holds its own copy of everything.
    forkedFrom: forkOriginOf(data?.forkedFrom),
    ...flat,
  };
}

/** A fork's origin, or null for a conversation that was started rather than split. */
function forkOriginOf(value) {
  const conversationId = text(value?.conversationId);
  const messageId = text(value?.messageId);
  return conversationId && messageId ? { conversationId, messageId } : null;
}

/**
 * The messages and the memory state, however the file on disk spells them.
 *
 * There are three shapes in the wild. The current one is a flat `messages`
 * array and a top-level `memory`. Before forks became conversations there was a
 * pool of messages with `parentId` links and a `branches` map, where the
 * memory lived at `branches[x].strategyState.memory` — that reads back as
 * whichever branch was active, because that is the conversation the person was
 * actually in. Anything older is a flat array with no ids and no memory at all.
 *
 * Non-active branches are not reachable this way, on purpose: turning one into
 * its own conversation means *writing a new record*, which a read must not do.
 * `scripts/migrate-conversations.js` does that, once, on demand.
 */
function flatten(data) {
  const raw = Array.isArray(data?.messages) ? data.messages : [];
  const branches = data?.branches;

  if (!branches || typeof branches !== "object" || Array.isArray(branches)) {
    return { memory: memoryOf(data?.memory), messages: normaliseMessages(raw) };
  }

  const activeId = text(data?.activeBranchId);
  const branch = branches[activeId] ?? branches.main ?? Object.values(branches)[0];
  const chained = withIds(raw);
  return {
    memory: memoryOf(branch?.strategyState?.memory ?? data?.memory),
    messages: normaliseMessages(walkBack(chained, branch?.headId)),
  };
}

/**
 * The path from a branch head back to the root, reversed — the walk the branch
 * map used to need on every read.
 *
 * The loop is bounded by the size of the pool, so a file with a `parentId`
 * cycle in it produces a short conversation rather than a hung server. A head
 * that names nothing yields the whole pool in file order, which is the right
 * answer for a record whose branch map was written but never pointed anywhere.
 */
function walkBack(messages, headId) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  if (!headId || !byId.has(headId)) return messages;

  const path = [];
  const seen = new Set();
  let cursor = headId;
  while (cursor && byId.has(cursor) && !seen.has(cursor) && path.length <= messages.length) {
    seen.add(cursor);
    const message = byId.get(cursor);
    path.push(message);
    cursor = message.parentId ?? null;
  }
  return path.reverse();
}

/**
 * Give every message an id, keeping the ones it already has. Sequential and
 * readable in a JSON file, which a UUID per message would not be.
 */
function withIds(messages) {
  const used = new Set();
  const out = [];
  for (const message of messages) {
    const existing = String(message?.id ?? "");
    const id = /^m\d+$/.test(existing) && !used.has(existing) ? existing : nextMessageId(out);
    used.add(id);
    out.push({ ...message, id });
  }
  return out;
}

/** The id the next message appended to a conversation should carry. */
export function nextMessageId(messages) {
  let highest = 0;
  for (const message of messages ?? []) {
    const match = /^m(\d+)$/.exec(String(message?.id ?? ""));
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return "m" + (highest + 1);
}

/** The strategy's state, or an empty object — never undefined. */
export function memoryOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : {};
}

/**
 * Split a conversation at a message: everything up to and including it, plus a
 * **copy** of the memory state.
 *
 * The copy is the whole point. Sharing the state would let something
 * established down one side show up on the other, and it would not present as
 * a storage bug — it would present as the model remembering something nobody
 * ever said in that conversation.
 *
 * @param {Conversation} record
 * @param {string} fromMessageId
 * @returns {{ messages: StoredMessage[], memory: object, forkedFrom: ForkOrigin }}
 */
export function forkFrom(record, fromMessageId) {
  const messages = record?.messages ?? [];
  const index = messages.findIndex((message) => message.id === fromMessageId);
  if (index < 0) throw new Error("No such message to fork from.");

  return {
    messages: messages.slice(0, index + 1).map((message) => ({ ...message })),
    memory: memoryOf(record.memory),
    forkedFrom: { conversationId: record.id, messageId: fromMessageId },
  };
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
