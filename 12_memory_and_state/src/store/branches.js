/**
 * Branching, as a storage shape.
 *
 * Branching is deliberately **not** a fifth context strategy. It changes what
 * "the history" means, not how a history becomes a payload — so it composes
 * with all four rather than competing with them, and a strategy never needs to
 * know it exists.
 *
 * The change is small and it is all here: messages gain `id` and `parentId`,
 * the record gains a `branches` map and an `activeBranchId`, and a branch's
 * history is the path from its head back to the root, reversed. The flat array
 * every earlier version wrote is the degenerate case — one chain, one branch —
 * which is why those files still load without being rewritten.
 *
 * **Each branch owns its own `strategyState`**, copied from its parent at fork
 * time. Sharing one would let a fact established down one branch appear in the
 * other, and it would not present as a storage bug: it would present as the
 * model hallucinating something nobody ever said on that branch.
 */

import { isStrategyId, DEFAULT_STRATEGY } from "../context/index.js";

export const MAIN_BRANCH = "main";

/**
 * @typedef {{ id: string, name: string, headId: string | null, forkedFromMessageId: string | null, parentBranchId: string | null, strategy: string, strategyState: Record<string, object> }} Branch
 */

/** A conversation with one empty branch and nothing said on it. @returns {Branch} */
export function emptyBranch(id = MAIN_BRANCH, name = "main") {
  return {
    id,
    name,
    headId: null,
    forkedFromMessageId: null,
    parentBranchId: null,
    strategy: DEFAULT_STRATEGY,
    strategyState: {},
  };
}

/**
 * Coerce whatever is on disk into a message pool and a branch map.
 *
 * A Day 8 or Day 9 file has neither: a flat array of `{ role, content }` and a
 * summary at the top level. It loads in memory as a single `main` branch whose
 * messages are chained in the order they were written and whose summary has
 * moved into `main.strategyState.summary`. Nothing is rewritten on disk until
 * the next save, so opening an old conversation read-only leaves it exactly as
 * it was.
 *
 * @param {object} data - A raw record, or anything claiming to be one.
 * @param {import("./conversationStore.js").StoredMessage[]} messages - Already
 *   field-filtered by `normaliseMessages`.
 * @returns {{ messages: import("./conversationStore.js").StoredMessage[], branches: Record<string, Branch>, activeBranchId: string }}
 */
export function normaliseGraph(data, messages) {
  const pool = chain(messages);
  const byId = new Map(pool.map((message) => [message.id, message]));
  const branches = {};

  const source = data?.branches;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    for (const [id, branch] of Object.entries(source)) {
      const key = branchId(id);
      if (!key) continue;
      branches[key] = {
        id: key,
        name: text(branch?.name) || key,
        // A head that does not name a message in the pool is a file that has
        // been edited or half-written. An empty branch is recoverable; a
        // dangling pointer would throw on every read of it.
        headId: byId.has(branch?.headId) ? branch.headId : null,
        forkedFromMessageId: byId.has(branch?.forkedFromMessageId)
          ? branch.forkedFromMessageId
          : null,
        parentBranchId: text(branch?.parentBranchId) || null,
        strategy: isStrategyId(branch?.strategy) ? branch.strategy : DEFAULT_STRATEGY,
        strategyState: normaliseStrategyState(branch?.strategyState),
      };
    }
  }

  if (!branches[MAIN_BRANCH]) {
    // The migration: one branch, holding the whole chain, with the legacy
    // summary fields moved into the strategy that owns them.
    branches[MAIN_BRANCH] = {
      ...emptyBranch(),
      headId: pool.length ? pool[pool.length - 1].id : null,
      strategyState: legacyStrategyState(data),
    };
  }

  // A branch map can exist and still reach nothing: a record saved by a caller
  // that predates branching carries a bare `main` with a null head while the
  // pool underneath it is full. Pointing main at the end of the chain is the
  // same migration as having no branch map at all, and it is the difference
  // between an old conversation loading and an old conversation reading empty.
  if (pool.length && !Object.values(branches).some((branch) => branch.headId)) {
    branches[MAIN_BRANCH] = {
      ...branches[MAIN_BRANCH],
      headId: pool[pool.length - 1].id,
      strategyState: Object.keys(branches[MAIN_BRANCH].strategyState).length
        ? branches[MAIN_BRANCH].strategyState
        : legacyStrategyState(data),
    };
  }

  for (const branch of Object.values(branches)) {
    if (branch.parentBranchId && !branches[branch.parentBranchId]) branch.parentBranchId = null;
  }

  const active = text(data?.activeBranchId);
  return {
    messages: pool,
    branches,
    activeBranchId: active && branches[active] ? active : MAIN_BRANCH,
  };
}

/**
 * A branch's history: the path from its head back to the root, reversed.
 *
 * This is the one function that turns a pool of messages into the linear
 * conversation a strategy is given. The walk is bounded by the size of the
 * pool, so a file with a `parentId` cycle in it produces a short history
 * rather than a hung server.
 *
 * @param {{ messages: import("./conversationStore.js").StoredMessage[], branches: Record<string, Branch> }} record
 * @param {string} [branchId]
 * @returns {import("./conversationStore.js").StoredMessage[]}
 */
export function getBranchHistory(record, branchId = record?.activeBranchId ?? MAIN_BRANCH) {
  const messages = record?.messages ?? [];
  const branch = record?.branches?.[branchId];
  if (!branch?.headId) return [];

  const byId = new Map(messages.map((message) => [message.id, message]));
  const path = [];
  const seen = new Set();
  let cursor = branch.headId;

  while (cursor && byId.has(cursor) && !seen.has(cursor) && path.length <= messages.length) {
    seen.add(cursor);
    const message = byId.get(cursor);
    path.push(message);
    cursor = message.parentId ?? null;
  }

  return path.reverse();
}

/**
 * Append one message to the end of a branch and move its head.
 *
 * @param {object} record
 * @param {string} branchId
 * @param {import("./conversationStore.js").StoredMessage} message
 * @returns {import("./conversationStore.js").StoredMessage} The stored message, with its id.
 */
export function appendMessage(record, branchId, message) {
  const branch = record.branches[branchId];
  if (!branch) throw new Error(`No such branch: ${branchId}`);

  const stored = { ...message, id: nextMessageId(record.messages), parentId: branch.headId ?? null };
  record.messages.push(stored);
  branch.headId = stored.id;
  return stored;
}

/**
 * Fork a new branch at a message. The new branch replays everything up to and
 * including that message, and its own turns go on from there.
 *
 * The parent's strategy and a deep copy of its strategy state come with it, so
 * the fork starts from the same understanding rather than from nothing — and
 * because it is a copy, the two branches can then disagree without either one
 * contaminating the other.
 *
 * @param {object} record
 * @param {{ fromMessageId: string, name?: string }} params
 * @returns {Branch}
 */
export function forkBranch(record, { fromMessageId, name } = {}) {
  const message = record.messages.find((m) => m.id === fromMessageId);
  if (!message) throw new Error("No such message to fork from.");

  const parentId = branchContaining(record, fromMessageId) ?? record.activeBranchId ?? MAIN_BRANCH;
  const parent = record.branches[parentId] ?? emptyBranch();
  const id = nextBranchId(record.branches);

  const branch = {
    id,
    name: text(name) || `branch ${Object.keys(record.branches).length}`,
    headId: fromMessageId,
    forkedFromMessageId: fromMessageId,
    parentBranchId: parentId,
    strategy: parent.strategy,
    strategyState: structuredClone(parent.strategyState ?? {}),
  };

  record.branches[id] = branch;
  return branch;
}

/**
 * Delete a branch and any message only it could reach.
 *
 * `main` and the active branch are refused: deleting the one every other
 * branch forked from would orphan them, and deleting the one you are talking
 * to would leave the next turn with nowhere to go.
 *
 * @param {object} record
 * @param {string} branchId
 */
export function deleteBranch(record, branchId) {
  if (branchId === MAIN_BRANCH) throw new Error("The main branch cannot be deleted.");
  if (branchId === record.activeBranchId) throw new Error("Switch away before deleting a branch.");
  if (!record.branches[branchId]) throw new Error("No such branch.");

  const children = Object.values(record.branches).filter((b) => b.parentBranchId === branchId);
  delete record.branches[branchId];
  // A child branch keeps its messages — they are reachable from its own head —
  // so it is re-parented rather than deleted along with its parent.
  for (const child of children) child.parentBranchId = record.branches[MAIN_BRANCH] ? MAIN_BRANCH : null;

  record.messages = reachable(record);
}

/** Every message any branch can still reach, in their original order. */
export function reachable(record) {
  const keep = new Set();
  for (const id of Object.keys(record.branches ?? {})) {
    for (const message of getBranchHistory(record, id)) keep.add(message.id);
  }
  return (record.messages ?? []).filter((message) => keep.has(message.id));
}

/** Which branch's history contains a message — the deepest one, if several. */
export function branchContaining(record, messageId) {
  let best = null;
  let longest = -1;
  for (const id of Object.keys(record.branches ?? {})) {
    const history = getBranchHistory(record, id);
    if (!history.some((message) => message.id === messageId)) continue;
    if (history.length > longest) {
      longest = history.length;
      best = id;
    }
  }
  return best;
}

/** What a branch looks like to the routes and the UI: no state, just shape. */
export function describeBranch(record, branchId) {
  const branch = record.branches[branchId];
  const history = getBranchHistory(record, branchId);
  return {
    id: branch.id,
    name: branch.name,
    headId: branch.headId,
    forkedFromMessageId: branch.forkedFromMessageId,
    parentBranchId: branch.parentBranchId,
    strategy: branch.strategy,
    messageCount: history.length,
    active: record.activeBranchId === branch.id,
  };
}

/**
 * The branch half of an existing record, or a conversation with one branch.
 * An absent graph on a save means "unchanged", never "flattened".
 */
export function pickGraph(existing) {
  if (existing?.branches) {
    return { branches: existing.branches, activeBranchId: existing.activeBranchId };
  }
  return { branches: { [MAIN_BRANCH]: emptyBranch() }, activeBranchId: MAIN_BRANCH };
}

/** Sequential and readable in a JSON file, which a UUID per message would not be. */
function nextMessageId(messages) {
  let highest = 0;
  for (const message of messages ?? []) {
    const match = /^m(\d+)$/.exec(String(message?.id ?? ""));
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return "m" + (highest + 1);
}

function nextBranchId(branches) {
  let n = 2;
  while (branches[`b${n}`]) n++;
  return `b${n}`;
}

/**
 * Give every message an id and a parent, preserving the order they are in.
 * A flat array from an earlier version comes out of here as one chain — which
 * is exactly what it always was.
 */
function chain(messages) {
  const pool = [];
  const used = new Set();
  let previousId = null;

  for (const message of messages ?? []) {
    const id = /^m\d+$/.test(String(message?.id ?? "")) && !used.has(message.id)
      ? message.id
      : nextMessageId(pool);
    used.add(id);
    // A parent that is not already in the pool would make the message
    // unreachable from any head, so an unknown one falls back to the message
    // written before it.
    const parentId = used.has(message?.parentId) && message.parentId !== id
      ? message.parentId
      : previousId;
    pool.push({ ...message, id, parentId: parentId ?? null });
    previousId = id;
  }

  return pool;
}

/** `{ [strategyId]: state }`, with anything unrecognisable dropped. */
function normaliseStrategyState(state) {
  const clean = {};
  if (!state || typeof state !== "object") return clean;
  for (const [id, value] of Object.entries(state)) {
    if (isStrategyId(id) && value && typeof value === "object") clean[id] = structuredClone(value);
  }
  return clean;
}

/** Day 9's three top-level fields, in their new home. */
function legacyStrategyState(data) {
  const summary = typeof data?.summary === "string" && data.summary.trim() ? data.summary : null;
  const through = Number.isInteger(data?.summarizedThrough) ? data.summarizedThrough : 0;
  if (!summary && !through) return {};
  return {
    summary: {
      summary,
      summarizedThrough: through,
      summaryUpdatedAt: typeof data?.summaryUpdatedAt === "string" ? data.summaryUpdatedAt : null,
    },
  };
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function branchId(id) {
  return /^[a-z0-9_-]{1,40}$/i.test(String(id ?? "")) ? String(id) : "";
}
