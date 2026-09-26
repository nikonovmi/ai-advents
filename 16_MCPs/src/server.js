import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";
import express from "express";

import { Agent } from "./agent.js";
import { DEFAULT_AGENT, agentCatalog, agentOf, isValidAgent } from "./agents.js";
import { AnthropicProvider, FakeProvider } from "./llm/anthropic.js";
import { estimateCost } from "./llm/pricing.js";
import { forkFrom, isValidSessionId } from "./store/conversationStore.js";
import { memoryRoutes } from "./memoryRoutes.js";
import { JsonFileStore } from "./store/jsonFileStore.js";
import { MemoryStore } from "./store/memoryStore.js";
import { DEFAULT_PROJECT, defaultInvariantStore, isValidProject } from "./store/invariantStore.js";
import { DEFAULT_USER, defaultProfileStore, isValidUser } from "./store/profileStore.js";

const PORT = Number(process.env.PORT) || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PRICING_FILE = path.join(__dirname, "llm", "pricing.js");
const NODE_MODULES = path.join(__dirname, "..", "node_modules");
/**
 * The two browser builds the transcript needs, served from `node_modules`.
 *
 * Replies are Markdown and they are model output, so they are parsed and then
 * sanitized before they reach the DOM. Both halves are real libraries rather
 * than something hand-rolled here: the parser because Markdown has more edge
 * cases than it looks like, and the sanitizer because a hand-rolled one is a
 * cross-site-scripting bug with a comment claiming otherwise.
 *
 * Mapped explicitly rather than by exposing `node_modules` as a static
 * directory — that would publish every file of every dependency, including the
 * ones that are not meant for a browser.
 */
const VENDOR = {
  "marked.js": path.join(NODE_MODULES, "marked", "lib", "marked.esm.js"),
  "purify.js": path.join(NODE_MODULES, "dompurify", "dist", "purify.es.mjs"),
};

const DEFAULT_CONTEXT_MESSAGES = 10;
const MAX_CONTEXT_MESSAGES = 100;
const MAX_OUTPUT_TOKENS = 8192;

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

/**
 * The Agent for a conversation, from the cache or from the store.
 *
 * `wanted` is the agent the request asked for, and it only decides anything for
 * a conversation that does not exist yet: `Agent.load` restores the agent from
 * the record when there is one, because the transcript was answered by that
 * persona and a dropdown must not rewrite history.
 */
async function agentSession(sessionId, wanted) {
  let agent = sessions.get(sessionId);
  if (!agent) {
    agent = await Agent.load({
      provider,
      store,
      sessionId,
      name: "Assistant",
      agentId: agentOf(wanted),
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

app.get("/vendor/:file", (req, res) => {
  const file = VENDOR[req.params.file];
  if (!file) return res.status(404).json({ error: "No such vendor file." });
  res.type("application/javascript").sendFile(file);
});

// The task boundary — finishing a task, answering a proposal, forgetting a row.
// None of it is a turn, so none of it belongs on /chat. Dropping the cached
// agent is what stops the next turn writing stale memory back over it.
app.use(
  memoryRoutes({ store, provider, profileStore, invariantStore, invalidate: (id) => sessions.delete(id) })
);

/**
 * Which agents exist — the dropdown in the title, built from the registry.
 *
 * Same discipline as the two pickers below: the list comes from the thing that
 * owns it, never from a second list in the UI that can quietly disagree.
 */
app.get("/agents", (_req, res) => {
  res.json({ agents: agentCatalog(), default: DEFAULT_AGENT });
});

/**
 * Which profiles exist — the topbar picker, built from the store.
 *
 * The list comes from the thing that owns it, never from a second list in the
 * UI that can quietly disagree. A profile
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
 * conversation* — a snapshot, stamped, and deliberately conversation-local. The
 * editor needs the other thing: what the store actually holds for the profile
 * you have selected, right now, whether or not this conversation has ever used
 * it. Seeding a form from the snapshot would mean editing a copy of something
 * that may be a fork and several turns old.
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
 * Delete a profile, or a project's rules.
 *
 * **The default id is emptied rather than removed.** Both list routes always
 * offer it, because a picker whose first entry appears only after you have used
 * it is a picker you cannot use — so deleting its file makes it empty, not
 * absent, and the response says which of the two happened rather than leaving
 * the page to guess.
 *
 * No cached `Agent` is dropped, and that is not an oversight: neither store is
 * read through an Agent. Every turn loads the profile and the rules fresh, so
 * the next one already sees this. What a conversation keeps is the *snapshot* of
 * what it was last sent, which is history and stays true.
 */
function deleteScoped({ route, store, isValid, defaultId, noun }) {
  app.delete(route + "/:id", async (req, res) => {
    const id = String(req.params.id ?? "").trim().toLowerCase();
    if (!isValid(id)) return res.status(400).json({ error: `Not a valid ${noun} id.` });

    try {
      await store.clear(id);
      res.json({ ok: true, id, emptied: id === defaultId });
    } catch (err) {
      console.error(`[DELETE ${route}/:id]`, err);
      res.status(500).json({ error: `Could not delete that ${noun}.` });
    }
  });
}

deleteScoped({
  route: "/profiles",
  store: profileStore,
  isValid: isValidUser,
  defaultId: DEFAULT_USER,
  noun: "profile",
});

deleteScoped({
  route: "/projects",
  store: invariantStore,
  isValid: isValidProject,
  defaultId: DEFAULT_PROJECT,
  noun: "project",
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
  const { message, sessionId, contextMessages, maxTokens, profile, project } = req.body ?? {};
  // The agent the page is on. It decides only for a conversation that does not
  // exist yet — an existing record names its own, and that one wins.
  const wantedAgent = req.body?.agent;

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

  if (profile !== undefined && !isValidUser(profile)) {
    return res.status(400).json({ error: "'profile' must be lowercase letters, digits, dash or underscore." });
  }

  if (project !== undefined && !isValidProject(project)) {
    return res.status(400).json({ error: "'project' must be lowercase letters, digits, dash or underscore." });
  }

  if (wantedAgent !== undefined && !isValidAgent(wantedAgent)) {
    return res.status(400).json({ error: "'agent' must be one this server knows." });
  }

  try {
    const agent = await agentSession(sessionId, wantedAgent);

    // Live controls in the UI, so they are settings for this turn rather than
    // something fixed when the agent was built.
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

    const { text, meta } = await agent.run(message);
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

app.get("/conversations", async (req, res) => {
  try {
    // Each agent has its own list. An absent `agent` means every conversation,
    // which is what a caller that does not know agents exist should get.
    const agentId = isValidAgent(req.query?.agent) ? agentOf(req.query.agent) : undefined;
    res.json(await store.listSessions({ agentId }));
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
    const agent = await agentSession(id, req.query?.agent);

    // A conversation nobody has spoken in yet is a real state here too — the
    // same call the memory routes make, for the same reason. It used to 404,
    // which meant the page fell back to a blank panel and an empty chat could
    // not show you the rules it is about to be sent or the profile it is
    // about to be answered as.
    //
    // The strategy's panel rides along with the transcript: the right-hand
    // column has to be right immediately on a reload, not one turn later. It is
    // built by the strategy that owns the state, so the route never reads a
    // field belonging to the strategy.
    const context = await panelContext(req, agent);

    res.json({
      messages: agent.history(),
      agentId: agent.agentId,
      forkedFrom: agent.forkedFrom,
      panel: agent.panel(context),
    });
  } catch (err) {
    console.error("[/conversations/:id]", err);
    res.status(500).json({ error: "Could not load that conversation." });
  }
});

// ---- forking ---------------------------------------------------------------

/**
 * Split a conversation at a message.
 *
 * **A fork is a new conversation, not a second thread inside this one.** It
 * gets its own id, its own entry in the list, everything said up to and
 * including the message it was taken at, and a *copy* of the memory state — so
 * the two can disagree from here on without either one contaminating the other.
 * Nothing about the parent changes, and deleting the parent later does not
 * orphan the fork.
 */
app.post("/conversations/:id/fork", async (req, res) => {
  const { id } = req.params;
  const { fromMessageId } = req.body ?? {};
  if (!isValidSessionId(id)) {
    return res.status(400).json({ error: "Not a valid conversation id." });
  }
  if (typeof fromMessageId !== "string" || !fromMessageId) {
    return res.status(400).json({ error: "A 'fromMessageId' is required." });
  }

  try {
    const record = await store.load(id);
    if (!record) return res.status(404).json({ error: "No such conversation." });

    const fork = forkFrom(record, fromMessageId);
    const forkId = crypto.randomUUID();
    // The project and the agent come along: a fork of a conversation about one
    // codebase is still about that codebase, and still answered by the same
    // agent. The usage totals do not — the fork has not spent anything yet,
    // and inheriting the parent's bill would double-count it.
    const saved = await store.save(forkId, fork.messages, undefined, {
      memory: fork.memory,
      forkedFrom: fork.forkedFrom,
      project: record.project,
      agentId: record.agentId,
    });

    res.json({
      id: forkId,
      title: saved.title,
      updatedAt: saved.updatedAt,
      messageCount: saved.messages.length,
      agentId: saved.agentId,
      forkedFrom: saved.forkedFrom,
    });
  } catch (err) {
    console.error("[POST /fork]", err);
    res.status(400).json({ error: err?.message ?? "Could not fork that message." });
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

    let cumulativeCost = 0;
    let cumulativeTokens = 0;
    const turns = [];

    for (const message of conversation.messages) {
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
