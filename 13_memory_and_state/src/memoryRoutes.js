import express from "express";

import { personas } from "./agent.js";
import { exchangeStarts } from "./context/boundaries.js";
import { compareProfiles } from "./context/comparison.js";
import { createStrategy } from "./context/index.js";
import { getBranchHistory } from "./store/branches.js";
import { isValidSessionId } from "./store/conversationStore.js";
import { DEFAULT_USER, isValidUser } from "./store/profileStore.js";

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

    // Whose long-term memory this request is about. It arrives with the
    // request because the picker is in the topbar rather than in the
    // conversation: the same conversation can be replayed against two
    // profiles, which is the whole point of the comparison below.
    const user = profileId(req.body?.profile);
    const strategy = createStrategy("memory", { profileStore, user });
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
      const ops = Array.isArray(req.body?.ops) ? req.body.ops.slice(0, 40) : null;
      if (!ops?.length) throw new Error("An 'ops' array is required.");
      // The profile editor is not a second write path — it is this one, with a
      // flag saying the sentences came from the user rather than from a model.
      // That flag is the only thing `declared` provenance means, and putting
      // the form anywhere else would be the second code path with no test
      // behind it that `applyOps` exists to prevent.
      return await strategy.applyPanelOps({ state, ops, turns, declared: req.body?.declared === true });
    })
  );

  /**
   * **The comparison: same message, same history, N profiles, side by side.**
   *
   * It does not go through `onBranch`, and that is the point rather than an
   * oversight. `onBranch` loads the record, hands the state to the strategy
   * and then **saves** — which is right for every other handler here, because
   * every other handler is a user changing memory on purpose. This one is a
   * user *looking* at memory, and looking must not write. So it reads the
   * record, never touches `store.save`, and hands the profile store to
   * `compareProfiles`, which wraps it in a read-only view before any arm can
   * reach it.
   */
  router.post("/conversations/:id/memory/compare", async (req, res) => {
    const { id } = req.params;
    if (!isValidSessionId(id)) return res.status(400).json({ error: "Not a valid conversation id." });

    let record;
    try {
      record = await store.load(id);
    } catch (err) {
      console.error("[memory] could not load the conversation:", err);
      return res.status(500).json({ error: "Could not load that conversation." });
    }

    const branchId = text(req.body?.branchId) || record?.activeBranchId || "main";
    const branch = record?.branches?.[branchId];
    // A comparison on a conversation that does not exist yet is still a
    // comparison: an empty history is the most common way to ask this
    // question, and refusing it would mean opening a chat, saying something
    // and only then being allowed to see what the profiles do.
    const history = record && branch ? getBranchHistory(record, branchId) : [];
    const state = branch?.strategyState?.memory ?? null;

    const profiles = Array.isArray(req.body?.profiles)
      ? req.body.profiles.map((value) => text(value)).filter((value) => isValidUser(value)).slice(0, 4)
      : [];
    if (profiles.length < 2) {
      return res.status(400).json({ error: "Pick at least two profiles to compare." });
    }

    try {
      const comparison = await compareProfiles({
        message: text(req.body?.message),
        history,
        state,
        systemPrompt: personas.helpful,
        provider,
        profileStore,
        profiles,
        samples: Number(req.body?.samples) || 3,
        contextMessages: Number(req.body?.contextMessages) || 10,
        maxTokens: Number(req.body?.maxTokens) || 1024,
      });
      res.json({ ok: true, branchId, ...comparison });
    } catch (err) {
      console.error("[memory] the comparison failed:", err?.message ?? err);
      res.status(400).json({ error: err?.message ?? "Could not run the comparison." });
    }
  });

  return router;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * A profile id from a request body, refused before it can become a path.
 *
 * The store throws on a bad id, which is the right behaviour there and the
 * wrong error here: a browser sending nonsense should get the default profile
 * and a working app, not a 500 from a filesystem call two layers down.
 */
function profileId(value) {
  const id = text(value).toLowerCase();
  return isValidUser(id) ? id : DEFAULT_USER;
}
