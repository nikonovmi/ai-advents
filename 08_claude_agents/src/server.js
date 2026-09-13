import path from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";
import express from "express";

import { Agent, personas } from "./agent.js";
import { AnthropicProvider, FakeProvider } from "./llm/anthropic.js";
import { isValidSessionId } from "./store/conversationStore.js";
import { JsonFileStore } from "./store/jsonFileStore.js";
import { MemoryStore } from "./store/memoryStore.js";

const PORT = 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

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
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

app.post("/chat", async (req, res) => {
  const { message, sessionId } = req.body ?? {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "A non-empty 'message' is required." });
  }
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: "A 'sessionId' in UUID v4 form is required." });
  }

  try {
    const agent = await agentFor(sessionId);
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
    res.json({ messages: conversation.messages });
  } catch (err) {
    console.error("[/conversations/:id]", err);
    res.status(500).json({ error: "Could not load that conversation." });
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
