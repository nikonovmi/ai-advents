import path from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";
import express from "express";

import { Agent, personas } from "./agent.js";
import { DEFAULT_STRATEGY, createStrategy, isStrategyId, strategyCatalog, STRATEGY_IDS } from "./context/index.js";
import { AnthropicProvider, FakeProvider } from "./llm/anthropic.js";
import { estimateCost } from "./llm/pricing.js";
import { getBranchHistory } from "./store/branches.js";
import { isValidSessionId } from "./store/conversationStore.js";
import { JsonFileStore } from "./store/jsonFileStore.js";
import { MemoryStore } from "./store/memoryStore.js";

const PORT = Number(process.env.PORT) || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PRICING_FILE = path.join(__dirname, "llm", "pricing.js");

const DEFAULT_CONTEXT_MESSAGES = 10;
const MAX_CONTEXT_MESSAGES = 100;
const MAX_OUTPUT_TOKENS = 8192;
const BRANCH_NAME_MAX = 40;
// The replay endpoint answers the same question once per strategy. That is the
// point of it, but it also means one careless click costs four completions plus
// whatever overhead each strategy incurs, so the reply is kept short.
const REPLAY_MAX_TOKENS = 512;

// One provider and one store, built once at startup and shared by every agent.
const provider = createProvider();
const store = await createStore();

// A cache in front of the store, not the source of truth: a miss is a load,
// not a blank slate. That is what lets a conversation survive a restart.
/** @type {Map<string, Agent>} */
const sessions = new Map();

function createProvider() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return new AnthropicProvider({
      apiKey,
      // Optional: only identity-linked keys need it.
      workspaceId: process.env.ANTHROPIC_WORKSPACE_ID,
    });
  }

  console.warn(
    "⚠️  ANTHROPIC_API_KEY is not set — falling back to FakeProvider (canned replies, no network).\n" +
      "   Copy .env.example to .env and add your key for real responses."
  );
  return new FakeProvider();
}

/**
 * Conversations on disk, or in memory if the data directory cannot be
 * written to. Losing history on restart beats refusing to start.
 */
async function createStore() {
  const fileStore = new JsonFileStore();
  try {
    await fileStore.listSessions();
    return fileStore;
  } catch (err) {
    console.warn(
      `⚠️  ${fileStore.dir} is not writable (${err?.message ?? err}) — falling back to MemoryStore.\n` +
        "   Conversations will not survive a restart."
    );
    return new MemoryStore();
  }
}

async function agentFor(sessionId) {
  let agent = sessions.get(sessionId);
  if (!agent) {
    agent = await Agent.load({
      provider,
      store,
      sessionId,
      name: "Assistant",
      systemPrompt: personas.helpful,
    });
    sessions.set(sessionId, agent);
  }
  return agent;
}

const app = express();
// 100 KB (the default) is small enough to reject a long pasted message before
// the agent ever sees it — and a long pasted message is exactly the input this
// version exists to put a token count on.
app.use(express.json({ limit: "5mb" }));
app.use(express.static(PUBLIC_DIR));

// The browser gets the same PRICING table and the same formatters the server
// uses, rather than a second copy that can quietly disagree with it.
app.get("/pricing.js", (_req, res) => {
  res.type("application/javascript").sendFile(PRICING_FILE);
});

/** The selector is built from the registry, not from a second list in the UI. */
app.get("/strategies", (_req, res) => {
  res.json({ strategies: strategyCatalog(), default: DEFAULT_STRATEGY });
});

app.post("/chat", async (req, res) => {
  const { message, sessionId, contextMessages, maxTokens, strategy, branchId } = req.body ?? {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "A non-empty 'message' is required." });
  }
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: "A 'sessionId' in UUID v4 form is required." });
  }

  const window = boundedInt(contextMessages, 1, MAX_CONTEXT_MESSAGES, DEFAULT_CONTEXT_MESSAGES);
  if (window === null) {
    return res
      .status(400)
      .json({ error: `'contextMessages' must be an integer between 1 and ${MAX_CONTEXT_MESSAGES}.` });
  }

  const ceiling = boundedInt(maxTokens, 1, MAX_OUTPUT_TOKENS, 1024);
  if (ceiling === null) {
    return res
      .status(400)
      .json({ error: `'maxTokens' must be an integer between 1 and ${MAX_OUTPUT_TOKENS}.` });
  }

  if (strategy !== undefined && !isStrategyId(strategy)) {
    return res.status(400).json({ error: `'strategy' must be one of: ${STRATEGY_IDS.join(", ")}.` });
  }

  try {
    const agent = await agentFor(sessionId);
    const branch = branchId ?? agent.activeBranchId;
    if (!agent.branches.some((b) => b.id === branch)) {
      return res.status(404).json({ error: "No such branch." });
    }

    // Live controls in the UI, so they are settings for this turn rather than
    // something fixed when the agent was built. An unnamed strategy means "the
    // one this branch was last spoken to with" — switching branches must not
    // silently switch strategy too.
    agent.contextMessages = window;
    agent.maxTokens = ceiling;
    agent.strategy = strategy ?? agent.branchStrategy(branch);

    const { text, meta } = await agent.run(message, { branchId: branch });
    res.json({ reply: text, meta });
  } catch (err) {
    // Log the detail server-side; send back only something safe and readable.
    console.error("[/chat]", err);
    res.status(500).json({ error: readableError(err) });
  }
});

app.post("/reset", async (req, res) => {
  const { sessionId } = req.body ?? {};
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: "A 'sessionId' in UUID v4 form is required." });
  }

  try {
    await sessions.get(sessionId)?.reset();
    res.json({ ok: true });
  } catch (err) {
    console.error("[/reset]", err);
    res.status(500).json({ error: "Could not clear the conversation." });
  }
});

app.get("/conversations", async (_req, res) => {
  try {
    res.json(await store.listSessions());
  } catch (err) {
    console.error("[/conversations]", err);
    res.status(500).json({ error: "Could not list conversations." });
  }
});

app.get("/conversations/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidSessionId(id)) {
    return res.status(400).json({ error: "Not a valid conversation id." });
  }

  try {
    const agent = await agentFor(id);
    const branchId = typeof req.query.branchId === "string" && req.query.branchId
      ? req.query.branchId
      : agent.activeBranchId;
    if (!agent.branches.some((b) => b.id === branchId)) {
      return res.status(404).json({ error: "No such branch." });
    }

    const messages = agent.history(branchId);
    if (!messages.length && !agent.branches.some((b) => b.messageCount)) {
      const stored = await store.load(id);
      if (!stored) return res.status(404).json({ error: "No such conversation." });
    }

    // The strategy's panel rides along with the transcript: the right-hand
    // column has to be right immediately on a reload, not one turn later. It is
    // built by the strategy that owns the state, so the route never reads a
    // field belonging to one particular strategy.
    res.json({
      messages,
      branchId,
      branches: agent.branches,
      activeBranchId: agent.activeBranchId,
      strategy: agent.branchStrategy(branchId),
      panel: agent.panel(branchId),
    });
  } catch (err) {
    console.error("[/conversations/:id]", err);
    res.status(500).json({ error: "Could not load that conversation." });
  }
});

// ---- branches --------------------------------------------------------------

app.get("/conversations/:id/branches", async (req, res) => {
  const { id } = req.params;
  if (!isValidSessionId(id)) {
    return res.status(400).json({ error: "Not a valid conversation id." });
  }
  try {
    const agent = await agentFor(id);
    res.json({ branches: agent.branches, activeBranchId: agent.activeBranchId });
  } catch (err) {
    console.error("[GET /branches]", err);
    res.status(500).json({ error: "Could not list branches." });
  }
});

app.post("/conversations/:id/branches", async (req, res) => {
  const { id } = req.params;
  const { fromMessageId, name } = req.body ?? {};
  if (!isValidSessionId(id)) {
    return res.status(400).json({ error: "Not a valid conversation id." });
  }
  if (typeof fromMessageId !== "string" || !fromMessageId) {
    return res.status(400).json({ error: "A 'fromMessageId' is required." });
  }

  try {
    const agent = await agentFor(id);
    const branch = await agent.fork({
      fromMessageId,
      name: typeof name === "string" ? name.trim().slice(0, BRANCH_NAME_MAX) : "",
    });
    res.json({ branch, branches: agent.branches, activeBranchId: agent.activeBranchId });
  } catch (err) {
    console.error("[POST /branches]", err);
    res.status(400).json({ error: err?.message ?? "Could not fork that message." });
  }
});

app.post("/conversations/:id/branches/:branchId/activate", async (req, res) => {
  const { id, branchId } = req.params;
  if (!isValidSessionId(id)) {
    return res.status(400).json({ error: "Not a valid conversation id." });
  }

  try {
    const agent = await agentFor(id);
    const branch = await agent.activateBranch(branchId);
    res.json({
      branch,
      branches: agent.branches,
      activeBranchId: agent.activeBranchId,
      messages: agent.history(branchId),
      strategy: agent.branchStrategy(branchId),
      panel: agent.panel(branchId),
    });
  } catch (err) {
    console.error("[POST /activate]", err);
    res.status(404).json({ error: err?.message ?? "No such branch." });
  }
});

app.delete("/conversations/:id/branches/:branchId", async (req, res) => {
  const { id, branchId } = req.params;
  if (!isValidSessionId(id)) {
    return res.status(400).json({ error: "Not a valid conversation id." });
  }

  try {
    const agent = await agentFor(id);
    await agent.removeBranch(branchId);
    res.json({ ok: true, branches: agent.branches, activeBranchId: agent.activeBranchId });
  } catch (err) {
    // `main` and the active branch are refused by the Agent, and both are a
    // client mistake rather than a server fault.
    res.status(400).json({ error: err?.message ?? "Could not delete that branch." });
  }
});

/**
 * Per-turn token counts plus the running cumulative totals — everything the
 * cost chart needs in one request. The per-turn numbers are replayed from the
 * stored messages; the totals are the ones the agent has been keeping, so a
 * restart does not reset the chart.
 */
app.get("/conversations/:id/usage", async (req, res) => {
  const { id } = req.params;
  if (!isValidSessionId(id)) {
    return res.status(400).json({ error: "Not a valid conversation id." });
  }

  try {
    const conversation = await store.load(id);
    if (!conversation) return res.status(404).json({ error: "No such conversation." });

    const branchId = typeof req.query.branchId === "string" && req.query.branchId
      ? req.query.branchId
      : conversation.activeBranchId;

    let cumulativeCost = 0;
    let cumulativeTokens = 0;
    const turns = [];

    for (const message of getBranchHistory(conversation, branchId)) {
      if (message.role !== "assistant" || !message.tokens) continue;
      const tokens = message.tokens;
      const cost =
        message.cost ??
        toNeutralCost(estimateCost({
          model: message.model,
          inputTokens: tokens.input,
          outputTokens: tokens.output,
        }));

      cumulativeCost += cost.total ?? 0;
      cumulativeTokens += tokens.total ?? 0;

      turns.push({
        turn: turns.length + 1,
        model: message.model ?? null,
        ms: message.ms ?? null,
        truncated: Boolean(message.truncated),
        strategy: message.strategy ?? message.compression ?? null,
        tokens,
        cost,
        cumulativeCost,
        cumulativeTokens,
      });
    }

    res.json({
      id,
      branchId,
      usage: conversation.usage,
      storedMessages: conversation.messages.length,
      turns,
    });
  } catch (err) {
    console.error("[/conversations/:id/usage]", err);
    res.status(500).json({ error: "Could not load usage for that conversation." });
  }
});

/**
 * Answer one question once per strategy against a stored conversation, so the
 * "which of these is worth it?" question gets a table instead of an impression.
 *
 * Strictly read-only. It loads the record, asks each strategy to build a
 * payload from it and throws the results away: no message is appended, no
 * state is written back, and the conversation's own usage totals are
 * untouched. The completions it pays for — and the overhead calls the
 * strategies make while building — are reported in the response and nowhere
 * else, because they belong to the experiment rather than to the conversation.
 */
app.post("/conversations/:id/replay", async (req, res) => {
  const { id } = req.params;
  const { question, contextMessages, strategies, branchId, expect } = req.body ?? {};

  if (!isValidSessionId(id)) {
    return res.status(400).json({ error: "Not a valid conversation id." });
  }
  if (typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "A non-empty 'question' is required." });
  }

  const window = boundedInt(contextMessages, 1, MAX_CONTEXT_MESSAGES, DEFAULT_CONTEXT_MESSAGES);
  if (window === null) {
    return res
      .status(400)
      .json({ error: `'contextMessages' must be an integer between 1 and ${MAX_CONTEXT_MESSAGES}.` });
  }

  const wanted = strategies === undefined ? STRATEGY_IDS : strategies;
  if (!Array.isArray(wanted) || !wanted.length || !wanted.every(isStrategyId)) {
    return res
      .status(400)
      .json({ error: `'strategies' must be a non-empty array of: ${STRATEGY_IDS.join(", ")}.` });
  }

  const expected = Array.isArray(expect)
    ? expect.map((value) => String(value).trim()).filter(Boolean)
    : [];

  try {
    const conversation = await store.load(id);
    if (!conversation) return res.status(404).json({ error: "No such conversation." });

    const branch = branchId ?? conversation.activeBranchId;
    if (!conversation.branches[branch]) return res.status(404).json({ error: "No such branch." });

    const stored = getBranchHistory(conversation, branch);
    if (!stored.length) {
      return res.status(400).json({ error: "That branch has nothing to replay." });
    }

    // The question is appended exactly as a real turn would append it, so each
    // arm is the payload the agent itself would have built — not an
    // approximation of it.
    const history = [...stored, { role: "user", content: question.trim() }];
    const state = conversation.branches[branch].strategyState ?? {};

    const variants = await Promise.all(
      wanted.map((strategyId) =>
        replayOne({
          strategyId,
          history,
          state: structuredClone(state[strategyId] ?? {}),
          window,
          expected,
        })
      )
    );

    res.json({
      id,
      branchId: branch,
      question: question.trim(),
      contextMessages: window,
      storedMessages: stored.length,
      expected,
      variants,
    });
  } catch (err) {
    console.error("[/conversations/:id/replay]", err);
    res.status(500).json({ error: readableError(err) });
  }
});

/**
 * One arm of the comparison. A failure in one arm is reported as that arm's
 * result rather than thrown: an over-long full history is a perfectly
 * interesting outcome, and it should not take the other three answers down
 * with it.
 */
async function replayOne({ strategyId, history, state, window, expected }) {
  const startedAt = Date.now();
  const strategy = createStrategy(strategyId, { contextMessages: window });
  strategy.contextMessages = window;

  try {
    const built = await strategy.buildPayload({
      history,
      systemPrompt: personas.helpful,
      state,
      provider,
    });

    const result = await provider.complete({
      system: built.system,
      messages: built.messages,
      temperature: 0,
      maxTokens: REPLAY_MAX_TOKENS,
    });
    const inputTokens = result.usage?.inputTokens ?? null;
    const outputTokens = result.usage?.outputTokens ?? null;
    const cost = estimateCost({ model: result.model, inputTokens, outputTokens });

    return {
      key: strategyId,
      label: strategy.label,
      note: built.meta?.note ?? "",
      reply: result.text,
      model: result.model,
      messagesSent: built.messages.length,
      inputTokens,
      outputTokens,
      cost: toNeutralCost(cost),
      overheadTokens: built.meta?.overheadTokens ?? 0,
      overheadCost: built.meta?.overheadCost ?? null,
      overheadCalls: built.meta?.overheadCalls ?? 0,
      recall: score(result.text, expected),
      ms: Date.now() - startedAt,
    };
  } catch (err) {
    console.error(`[/replay:${strategyId}]`, err);
    return {
      key: strategyId,
      label: strategy.label,
      note: "",
      error: readableError(err),
      messagesSent: 0,
      ms: Date.now() - startedAt,
    };
  }
}

/**
 * Recall, by substring. It is a blunt instrument and it is the right one: the
 * facts being checked are a port number and a name, and a strategy either put
 * them in front of the model or it did not.
 */
function score(reply, expected) {
  if (!expected.length) return null;
  const text = String(reply ?? "").toLowerCase();
  const hits = expected.filter((value) => text.includes(value.toLowerCase()));
  return { hits: hits.length, of: expected.length, missed: expected.filter((v) => !hits.includes(v)) };
}

app.delete("/conversations/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidSessionId(id)) {
    return res.status(400).json({ error: "Not a valid conversation id." });
  }

  try {
    await store.clear(id);
    sessions.delete(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /conversations/:id]", err);
    res.status(500).json({ error: "Could not delete that conversation." });
  }
});

/**
 * Accept an integer inside a range, treat absent as the default, and treat
 * anything else as a client error. Returning null rather than silently
 * clamping means a UI sending nonsense hears about it.
 *
 * @returns {number | null} The value to use, or null when it was invalid.
 */
function boundedInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/** `estimateCost`'s shape, renamed to the one stored messages use. */
function toNeutralCost({ inputCost, outputCost, totalCost }) {
  return { input: inputCost, output: outputCost, total: totalCost };
}

/**
 * A one-line, client-safe description of a failure: no stack traces, and
 * nothing that could echo back a credential.
 *
 * The 400 case passes the provider's own sentence through, which is the one
 * place that is worth doing. A 400 from the Messages API is almost always
 * something the caller can act on — an empty credit balance, a model id that
 * does not exist, a malformed request — and `error.message` is a string the
 * provider wrote to be displayed. Swallowing it into "something went wrong"
 * turns the only actionable failure into the least actionable message in the
 * app. Nothing else is passed through: a 401 must never repeat back what it
 * was we sent.
 */
function readableError(err) {
  const status = err?.status;
  if (status === 401 || status === 403) return "The model rejected our credentials.";
  if (status === 429) return "Rate limited by the model provider. Try again in a moment.";
  if (status === 408) return "The model took too long to respond. Try again.";
  if (status === 400 && typeof err?.message === "string" && err.message.trim()) {
    return "The model provider rejected the request: " + err.message.trim().slice(0, 300);
  }
  if (typeof status === "number" && status >= 500) return "The model provider is having trouble. Try again shortly.";
  return "Something went wrong while generating a reply.";
}

app.listen(PORT, () => {
  console.log(`first-agent listening on http://localhost:${PORT}`);
});
