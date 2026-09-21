import path from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";
import express from "express";

import { Agent, personas } from "./agent.js";
import { DEFAULT_STRATEGY, isStrategyId, panelFor, strategyCatalog, STRATEGY_IDS } from "./context/index.js";
import { AnthropicProvider, FakeProvider } from "./llm/anthropic.js";
import { estimateCost } from "./llm/pricing.js";
import { getBranchHistory } from "./store/branches.js";
import { isValidSessionId } from "./store/conversationStore.js";
import { memoryRoutes } from "./memoryRoutes.js";
import { JsonFileStore } from "./store/jsonFileStore.js";
import { MemoryStore } from "./store/memoryStore.js";
import { DEFAULT_PROJECT, defaultInvariantStore, isValidProject } from "./store/invariantStore.js";
import { DEFAULT_USER, defaultProfileStore, isValidUser } from "./store/profileStore.js";

const PORT = Number(process.env.PORT) || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PRICING_FILE = path.join(__dirname, "llm", "pricing.js");

const DEFAULT_CONTEXT_MESSAGES = 10;
const MAX_CONTEXT_MESSAGES = 100;
const MAX_OUTPUT_TOKENS = 8192;
const BRANCH_NAME_MAX = 40;

// One provider and one store, built once at startup and shared by every agent.
const provider = createProvider();
const store = await createStore();
// And one profile store: long-term memory belongs to the user, not to any one
// conversation, so there is exactly one of it for the whole process.
const profileStore = defaultProfileStore();
// And one invariant store. Long-term memory belongs to the user; the rules
// belong to the codebase, which is why they are two stores and not one.
const invariantStore = defaultInvariantStore();

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
      // The two stores that outlive a conversation, handed to whichever
      // strategy turns out to want them. The Agent itself never touches
      // either.
      strategyOptions: { profileStore, invariantStore },
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

// The task boundary — finishing a task, answering a proposal, forgetting a row.
// None of it is a turn, so none of it belongs on /chat. Dropping the cached
// agent is what stops the next turn writing stale memory back over it.
app.use(
  memoryRoutes({ store, provider, profileStore, invariantStore, invalidate: (id) => sessions.delete(id) })
);

/** The selector is built from the registry, not from a second list in the UI. */
app.get("/strategies", (_req, res) => {
  res.json({ strategies: strategyCatalog(), default: DEFAULT_STRATEGY });
});

/**
 * Which profiles exist — the topbar picker, built from the store.
 *
 * Same discipline as `/strategies`: the list comes from the thing that owns
 * it, never from a second list in the UI that can quietly disagree. A profile
 * id that has never been written has no file and is not listed, which is
 * correct — it comes into existence the moment something is declared in it.
 */
app.get("/profiles", async (_req, res) => {
  try {
    const profiles = await profileStore.list();
    // The default is always offered, even before anything has been written to
    // it: a picker whose first entry appears only after you have used it is a
    // picker you cannot use.
    if (!profiles.some((profile) => profile.id === DEFAULT_USER)) {
      profiles.unshift({ id: DEFAULT_USER, entryCount: 0, updatedAt: null });
    }
    res.json({ profiles, default: DEFAULT_USER });
  } catch (err) {
    console.error("[/profiles]", err);
    res.status(500).json({ error: "Could not list profiles." });
  }
});

/**
 * Which projects have rules — the topbar's other picker.
 *
 * Same discipline as `/profiles`: the list comes from the store that owns it.
 * The default is always offered even before anything has been written to it,
 * because a picker whose first entry appears only after you have used it is a
 * picker you cannot use.
 */
app.get("/projects", async (_req, res) => {
  try {
    const projects = await invariantStore.list();
    if (!projects.some((project) => project.id === DEFAULT_PROJECT)) {
      projects.unshift({ id: DEFAULT_PROJECT, entryCount: 0, updatedAt: null });
    }
    res.json({ projects, default: DEFAULT_PROJECT });
  } catch (err) {
    console.error("[/projects]", err);
    res.status(500).json({ error: "Could not list projects." });
  }
});

/**
 * One profile, as it stands in the store right now.
 *
 * The panel's profile section is *what was sent on the last turn of this
 * branch* — a snapshot, stamped, and deliberately branch-local. The editor
 * needs the other thing: what the store actually holds for the profile you
 * have selected, right now, whether or not this conversation has ever used it.
 * Seeding a form from the snapshot would mean editing a copy of something that
 * may be a fork and several turns old.
 */
app.get("/profiles/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidUser(id)) return res.status(400).json({ error: "Not a valid profile id." });

  try {
    const profile = await profileStore.load(id.toLowerCase());
    res.json({
      id: profile.user,
      updatedAt: profile.updatedAt,
      entries: Object.values(profile.entries)
        .map((entry) => ({ key: entry.key, value: entry.value, source: entry.source, updatedAt: entry.updatedAt }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    });
  } catch (err) {
    console.error("[/profiles/:id]", err);
    res.status(500).json({ error: "Could not read that profile." });
  }
});


/**
 * What the memory panel should draw, read here because a panel is built
 * synchronously and these live in stores.
 *
 * The ids come from the request because the pickers are in the topbar rather
 * than in the conversation: the panel answers *what would the next turn be
 * sent*, and the next turn is sent whatever the pickers currently say. Without
 * them a conversation nobody has spoken in yet draws an empty rule set and an
 * empty profile, which reads as "there are no rules and nothing is known about
 * you" when the truth is "nothing has been sent yet".
 */
async function panelContext(req, agent) {
  const user = isValidUser(req.query?.profile) ? String(req.query.profile).toLowerCase() : (agent.profileUser ?? DEFAULT_USER);
  const project = isValidProject(req.query?.project) ? String(req.query.project).toLowerCase() : (agent.project ?? DEFAULT_PROJECT);
  const [invariants, profile] = await Promise.all([
    invariantStore.load(project).catch(() => null),
    profileStore.load(user).catch(() => null),
  ]);
  return { invariants, profile, user, project };
}

app.post("/chat", async (req, res) => {
  const { message, sessionId, contextMessages, maxTokens, strategy, branchId, profile, project } =
    req.body ?? {};

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

  if (profile !== undefined && !isValidUser(profile)) {
    return res.status(400).json({ error: "'profile' must be lowercase letters, digits, dash or underscore." });
  }

  if (project !== undefined && !isValidProject(project)) {
    return res.status(400).json({ error: "'project' must be lowercase letters, digits, dash or underscore." });
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
    // Whose long-term memory this turn reads and writes. A live control like
    // the other two: the topbar can switch profiles between two turns of the
    // same conversation, which is what makes "ask the same thing as someone
    // else" a thing you can do rather than a thing you have to rebuild for.
    agent.profileUser = profile ? String(profile).trim().toLowerCase() : DEFAULT_USER;
    // Whose rules this turn is subject to. Unlike the profile there is no
    // falling back to a default when the request is silent: the record
    // remembers which project the conversation belongs to, and resetting that
    // to `default` because one request forgot to say would quietly drop every
    // rule the project has for the length of a turn.
    if (project) agent.project = String(project).trim().toLowerCase();
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

    // A conversation nobody has spoken in yet is a real state here too — the
    // same call the memory routes make, for the same reason. It used to 404,
    // which meant the page fell back to a blank panel and an empty chat could
    // not show you the rules it is about to be sent or the profile it is
    // about to be answered as.
    const messages = agent.history(branchId);

    // The strategy's panel rides along with the transcript: the right-hand
    // column has to be right immediately on a reload, not one turn later. It is
    // built by the strategy that owns the state, so the route never reads a
    // field belonging to one particular strategy.
    // **"Which strategy was this last spoken to with" has no answer before it
    // has been spoken to.** A fresh branch carries the registry's default, and
    // reporting that as a remembered choice would snap the selector away from
    // whatever the person had picked, on every new conversation. So it is
    // `null`, the page keeps its own selection — and the panel previews *that*
    // strategy, because that is the one the next turn will use.
    const spoken = messages.length > 0 || agent.branches.some((branch) => branch.messageCount);
    const wanted = isStrategyId(req.query?.strategy) ? req.query.strategy : null;
    const context = await panelContext(req, agent);

    res.json({
      messages,
      branchId,
      branches: agent.branches,
      activeBranchId: agent.activeBranchId,
      strategy: spoken ? agent.branchStrategy(branchId) : null,
      panel: spoken || !wanted
        ? agent.panel(branchId, context)
        : panelFor(wanted, {}, { turns: 0, ...context }),
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
      panel: agent.panel(branchId, await panelContext(req, agent)),
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
