import path from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";
import express from "express";

import { Agent, personas } from "./agent.js";
import { AnthropicProvider, FakeProvider } from "./llm/anthropic.js";

const PORT = 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// One provider, built once at startup and shared by every agent.
const provider = createProvider();

// Sessions live here, not in the Agent — the Agent class has no notion of them.
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

function agentFor(sessionId) {
  let agent = sessions.get(sessionId);
  if (!agent) {
    agent = new Agent({
      provider,
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
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return res.status(400).json({ error: "A 'sessionId' is required." });
  }

  try {
    const { text, meta } = await agentFor(sessionId).run(message);
    res.json({ reply: text, meta });
  } catch (err) {
    // Log the detail server-side; send back only something safe and readable.
    console.error("[/chat]", err);
    res.status(500).json({ error: readableError(err) });
  }
});

app.post("/reset", (req, res) => {
  const { sessionId } = req.body ?? {};
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return res.status(400).json({ error: "A 'sessionId' is required." });
  }
  sessions.get(sessionId)?.reset();
  res.json({ ok: true });
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
