import path from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";
import express from "express";

import { Agent, personas, summaryBlock, windowStart } from "./agent.js";
import { AnthropicProvider, FakeProvider } from "./llm/anthropic.js";
import { estimateCost } from "./llm/pricing.js";
import { isValidSessionId } from "./store/conversationStore.js";
import { JsonFileStore } from "./store/jsonFileStore.js";
import { MemoryStore } from "./store/memoryStore.js";

const PORT = 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PRICING_FILE = path.join(__dirname, "llm", "pricing.js");

const DEFAULT_CONTEXT_MESSAGES = 10;
const MAX_CONTEXT_MESSAGES = 100;
const MAX_OUTPUT_TOKENS = 8192;
// How many exchanges a compression folds in. Absent means half the window,
// which is what the UI sends: one dial, not two that have to agree.
const MAX_SUMMARIZE_EVERY = 100;
// The replay endpoint answers the same question three times over. That is the
// point of it, but it also means one careless click costs three completions, so
// the reply is kept short.
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

app.post("/chat", async (req, res) => {
  const { message, sessionId, contextMessages, maxTokens, summarizeEvery, compressionEnabled } =
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

  const every = boundedInt(summarizeEvery, 1, MAX_SUMMARIZE_EVERY, null);
  if (every === null && summarizeEvery !== undefined && summarizeEvery !== null && summarizeEvery !== "") {
    return res
      .status(400)
      .json({ error: `'summarizeEvery' must be an integer between 1 and ${MAX_SUMMARIZE_EVERY}.` });
  }

  if (compressionEnabled !== undefined && typeof compressionEnabled !== "boolean") {
    return res.status(400).json({ error: "'compressionEnabled' must be a boolean." });
  }

  try {
    const agent = await agentFor(sessionId);
    // Live controls in the UI, so they are settings for this turn rather than
    // something fixed when the agent was built. `summarizeEvery` is the odd one
    // out: null leaves the agent to derive it from the window.
    agent.contextMessages = window;
    agent.maxTokens = ceiling;
    agent.summarizeEvery = every;
    agent.compressionEnabled = compressionEnabled ?? true;
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
    const conversation = await store.load(id);
    if (!conversation) return res.status(404).json({ error: "No such conversation." });
    // The summary rides along with the transcript: the panel that shows it has
    // to be right immediately on a reload, not one turn later.
    res.json({
      messages: conversation.messages,
      summary: conversation.summary,
      summarizedThrough: conversation.summarizedThrough,
      summaryUpdatedAt: conversation.summaryUpdatedAt,
    });
  } catch (err) {
    console.error("[/conversations/:id]", err);
    res.status(500).json({ error: "Could not load that conversation." });
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
        tokens,
        cost,
        cumulativeCost,
        cumulativeTokens,
      });
    }

    res.json({ id, usage: conversation.usage, storedMessages: conversation.messages.length, turns });
  } catch (err) {
    console.error("[/conversations/:id/usage]", err);
    res.status(500).json({ error: "Could not load usage for that conversation." });
  }
});

/**
 * Answer one question three ways against a stored conversation, so the
 * "does compression help?" question gets a number instead of an impression.
 *
 *   full        — the entire history, nothing cropped, no summary
 *   cropped     — the last N exchanges only (the previous version's behaviour)
 *   compressed  — the stored summary plus the last N exchanges (this version)
 *
 * Strictly read-only. It loads the record, builds three payloads from it and
 * throws them away: no message is appended, no summary is written, and the
 * conversation's own usage totals are untouched. The three completions it does
 * pay for are reported in the response and nowhere else, because they belong to
 * the experiment rather than to the conversation.
 */
app.post("/conversations/:id/replay", async (req, res) => {
  const { id } = req.params;
  const { question, contextMessages } = req.body ?? {};

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

  try {
    const conversation = await store.load(id);
    if (!conversation) return res.status(404).json({ error: "No such conversation." });
    if (!conversation.messages.length) {
      return res.status(400).json({ error: "That conversation has nothing to replay." });
    }

    // The question is appended exactly as a real turn would append it, and the
    // window is computed on the result — so `cropped` and `compressed` are the
    // payloads the agent itself would have built, not approximations of them.
    const history = [
      ...conversation.messages.map(({ role, content }) => ({ role, content })),
      { role: "user", content: question.trim() },
    ];
    const start = windowStart(history, window);
    const cropped = history.slice(start);
    const withSummary = personas.helpful + summaryBlock(conversation.summary);

    const variants = [
      {
        key: "full",
        label: "Full history",
        note: `every one of the ${history.length} messages, nothing cropped`,
        system: personas.helpful,
        messages: history,
        summaryUsed: false,
      },
      {
        key: "cropped",
        label: "Cropped",
        note: `the last ${window} exchange${window === 1 ? "" : "s"}, everything older simply gone`,
        system: personas.helpful,
        messages: cropped,
        summaryUsed: false,
      },
      {
        key: "compressed",
        label: "Summary + cropped",
        note: conversation.summary
          ? `the same ${cropped.length} messages, with the summary in the system prompt`
          : "no summary has been written yet, so this is identical to cropped",
        system: withSummary,
        messages: cropped,
        summaryUsed: Boolean(conversation.summary),
      },
    ];

    const answers = await Promise.all(variants.map((variant) => replayOne(variant)));

    res.json({
      id,
      question: question.trim(),
      contextMessages: window,
      storedMessages: conversation.messages.length,
      summarizedThrough: conversation.summarizedThrough,
      hasSummary: Boolean(conversation.summary),
      variants: answers,
    });
  } catch (err) {
    console.error("[/conversations/:id/replay]", err);
    res.status(500).json({ error: readableError(err) });
  }
});

/**
 * One arm of the comparison. A failure in one arm is reported as that arm's
 * result rather than thrown: an over-long full history is a perfectly
 * interesting outcome, and it should not take the other two answers down with
 * it.
 */
async function replayOne({ key, label, note, system, messages, summaryUsed }) {
  const startedAt = Date.now();
  try {
    const result = await provider.complete({
      system,
      messages,
      temperature: 0,
      maxTokens: REPLAY_MAX_TOKENS,
    });
    const inputTokens = result.usage?.inputTokens ?? null;
    const outputTokens = result.usage?.outputTokens ?? null;
    const cost = estimateCost({ model: result.model, inputTokens, outputTokens });

    return {
      key,
      label,
      note,
      reply: result.text,
      model: result.model,
      messagesSent: messages.length,
      summaryUsed,
      inputTokens,
      outputTokens,
      cost: toNeutralCost(cost),
      ms: Date.now() - startedAt,
    };
  } catch (err) {
    console.error(`[/replay:${key}]`, err);
    return {
      key,
      label,
      note,
      error: readableError(err),
      messagesSent: messages.length,
      summaryUsed,
      ms: Date.now() - startedAt,
    };
  }
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
 */
function readableError(err) {
  const status = err?.status;
  if (status === 401 || status === 403) return "The model rejected our credentials.";
  if (status === 429) return "Rate limited by the model provider. Try again in a moment.";
  if (status === 408) return "The model took too long to respond. Try again.";
  if (typeof status === "number" && status >= 500) return "The model provider is having trouble. Try again shortly.";
  return "Something went wrong while generating a reply.";
}

app.listen(PORT, () => {
  console.log(`first-agent listening on http://localhost:${PORT}`);
});
