import express from "express";

import { exchangeStarts } from "./context/boundaries.js";
import { createStrategy } from "./context/index.js";
import { getBranchHistory } from "./store/branches.js";
import { isValidSessionId } from "./store/conversationStore.js";

/**
 * The task boundary, as HTTP.
 *
 * Everything in here is a **user** acting on memory rather than a model: "this
 * task is finished", "yes, remember that", "no, forget it". None of it belongs
 * on `/chat`, because none of it is a turn — no persona, no reply, nothing
 * appended to the transcript.
 *
 * It is a separate router mounted with one line rather than four more handlers
 * in `server.js`, for the same reason the strategy is a separate file: the
 * fifth strategy should cost the rest of the app a line each, and be removable
 * by deleting those lines.
 *
 * **Why it writes through the store rather than through an Agent.** The Agent
 * exposes a conversation, not a memory: it has no idea what `strategyState`
 * holds, which is precisely the property that lets a fifth strategy exist at
 * all. So these handlers read the record, hand the state to the strategy that
 * owns it, write the record back, and then drop the cached Agent for that
 * session so the next turn re-reads what just changed. That last step is the
 * one that is easy to forget and produces a memory that reverts itself on the
 * next message.
 *
 * @param {object} params
 * @param {import("./store/conversationStore.js").ConversationStore} params.store
 * @param {import("./llm/provider.js").LlmProvider} params.provider
 * @param {import("./store/profileStore.js").ProfileStore} params.profileStore
 * @param {(sessionId: string) => void} [params.invalidate] - Drop this session's
 *   cached Agent, so it reloads instead of overwriting.
 */
export function memoryRoutes({ store, provider, profileStore, invalidate = () => {} }) {
  const router = express.Router();

  /**
   * Load the record, find the branch, and hand the memory state to `work`.
   * Whatever comes back is persisted and answered with a fresh panel — so
   * every handler below is three lines about memory and nothing about storage.
   */
  async function onBranch(req, res, work) {
    const { id } = req.params;
    if (!isValidSessionId(id)) {
      return res.status(400).json({ error: "Not a valid conversation id." });
    }

    let record;
    try {
      record = await store.load(id);
    } catch (err) {
      console.error("[memory] could not load the conversation:", err);
      return res.status(500).json({ error: "Could not load that conversation." });
    }
    if (!record) return res.status(404).json({ error: "No such conversation." });

    const branchId = text(req.body?.branchId) || record.activeBranchId;
    const branch = record.branches?.[branchId];
    if (!branch) return res.status(404).json({ error: "No such branch." });

    const strategy = createStrategy("memory", { profileStore });
    const history = getBranchHistory(record, branchId);
    const turns = exchangeStarts(history).length;
    const state = branch.strategyState?.memory ?? strategy.emptyState();

    let result;
    try {
      result = await work({ strategy, state, history, turns, branchId });
    } catch (err) {
      // These are user mistakes — an id that is not there, an answer that is
      // neither yes nor no — far more often than they are server faults.
      console.error("[memory]", err?.message ?? err);
      return res.status(400).json({ error: err?.message ?? "Could not change memory." });
    }

    branch.strategy = "memory";
    branch.strategyState = { ...branch.strategyState, memory: result.state };

    try {
      await store.save(id, record.messages, record.usage, {
        branches: record.branches,
        activeBranchId: record.activeBranchId,
      });
    } catch (err) {
      console.error("[memory] could not persist the change:", err);
      return res.status(500).json({ error: "Could not save that change." });
    }
    // The cached Agent is holding the state as it was a moment ago. Left in
    // place it would write that back over this on the next turn.
    invalidate(id);

    res.json({
      ok: result.ok !== false,
      note: result.note ?? "",
      branchId,
      panel: strategy.panel(result.state, { turns }),
      ...(result.extra ?? {}),
    });
  }

  /**
   * One button, three effects: propose, clear, keep the record.
   *
   * The proposals it returns are **pending** and live in the conversation
   * record. Nothing here writes to the profile store — an unapproved write
   * must not exist in long-term, not even with a flag on it, because every
   * flag is one forgotten `WHERE` clause away from being read as fact.
   */
  router.post("/conversations/:id/memory/finish-task", (req, res) =>
    onBranch(req, res, async ({ strategy, state, history }) => {
      const finished = await strategy.finishTask({ state, history, provider });
      return {
        ok: finished.ok,
        state: finished.state,
        note: finished.note,
        extra: { proposals: finished.proposals },
      };
    })
  );

  /** Approve — with an edit, if the phrasing was wrong — or reject. */
  router.post("/conversations/:id/memory/proposals/:proposalId", (req, res) =>
    onBranch(req, res, async ({ strategy, state, turns }) => {
      const action = text(req.body?.action);
      if (action !== "approve" && action !== "reject") {
        throw new Error("An answer is either 'approve' or 'reject'.");
      }
      return await strategy.answerProposal({
        state,
        id: req.params.proposalId,
        action,
        value: typeof req.body?.value === "string" ? req.body.value : undefined,
        turns,
      });
    })
  );

  /**
   * *Forget* and *promote*, from the panel — the same `applyOps` path the
   * extractor's patch takes, so there is one code path to test rather than a
   * second one that only the UI can reach.
   */
  router.post("/conversations/:id/memory/ops", (req, res) =>
    onBranch(req, res, async ({ strategy, state, turns }) => {
      const ops = Array.isArray(req.body?.ops) ? req.body.ops.slice(0, 20) : null;
      if (!ops?.length) throw new Error("An 'ops' array is required.");
      return await strategy.applyPanelOps({ state, ops, turns });
    })
  );

  return router;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
