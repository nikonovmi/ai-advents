import express from "express";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const PORT = 3000;
const MODEL = "claude-haiku-4-5";
// Prompts ask for short answers (~40-80 tokens); this is a runaway guard with
// plenty of headroom, not a length setting. You are billed for tokens actually
// generated, so a high cap that is never reached costs nothing.
const MAX_TOKENS = 500;

// Kept as strings so they double as the JSON keys the frontend indexes by.
const TEMPERATURES = ["0", "0.25", "0.5", "0.75", "1"];

const SYSTEM_PROMPTS = {
  dummy:
    "You are not well educated and you find most things confusing. Use very " +
    "simple everyday words and short sentences - a small vocabulary, nothing " +
    "technical. You often miss the point slightly, or fix on the wrong part of " +
    "the question. You are friendly and you mean well. Answer in at most two " +
    "short sentences. Do not comment on how you talk.",

  toxic:
    "You are sarcastic, rude, blunt and dismissive. You think the question is " +
    "beneath you and you say so, then answer it anyway. Use plain modern English " +
    "- no theatrics, no stage directions, just contempt delivered flatly. Keep " +
    "it PG: no slurs, no profanity, no threats, nothing genuinely harmful - you " +
    "are mean, not dangerous. At most three short sentences; contempt is sharper " +
    "when it is not a lecture. Do not comment on how you talk.",

  judge:
    "You are a senior judge with decades on the bench. You have heard this kind " +
    "of thing a thousand times and you are bored by it. Give the ruling and " +
    "nothing else - no reasoning, no context, no pleasantries. Plain modern " +
    "English, one short sentence at most, often only a few words. You are not " +
    "rude, you simply cannot be bothered to elaborate. Do not comment on how " +
    "you talk.",
};

// Identity-linked API keys must name the workspace the request acts in; plain
// workspace keys don't. Harmless to omit when the key doesn't need it.
const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
const client = new Anthropic(
  workspaceId
    ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } }
    : {}
);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

function extractText(message) {
  if (message.stop_reason === "max_tokens") {
    console.warn(
      `WARNING: response hit the ${MAX_TOKENS}-token cap and was truncated.`
    );
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || "(empty response)";
}

function describeError(error) {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Error: invalid or missing ANTHROPIC_API_KEY.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Error: rate limited - try again in a moment.";
  }
  if (
    error instanceof Anthropic.APIError &&
    String(error.message).includes("anthropic-workspace-id")
  ) {
    return (
      "Error: this API key is identity-linked and needs a workspace id. " +
      "Add ANTHROPIC_WORKSPACE_ID=wrkspc_... to .env and restart."
    );
  }
  if (error instanceof Anthropic.APIError) {
    return `Error ${error.status}: ${error.message}`;
  }
  return `Error: ${error?.message ?? String(error)}`;
}

app.post("/chat", async (req, res) => {
  const { message } = req.body ?? {};

  if (typeof message !== "string" || !message.trim()) {
    return res
      .status(400)
      .json({ error: 'Body must include a non-empty "message" string.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error:
        "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.",
    });
  }

  // 15 combinations: 3 system prompts x 5 temperatures, all fired in parallel.
  const jobs = [];
  for (const promptKey of Object.keys(SYSTEM_PROMPTS)) {
    for (const temperature of TEMPERATURES) {
      jobs.push({ promptKey, temperature });
    }
  }

  const settled = await Promise.allSettled(
    jobs.map(({ promptKey, temperature }) =>
      client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: Number(temperature),
        system: SYSTEM_PROMPTS[promptKey],
        messages: [{ role: "user", content: message }],
      })
    )
  );

  // One failed cell must not sink the grid - it becomes an error string instead.
  const results = {};
  for (const key of Object.keys(SYSTEM_PROMPTS)) results[key] = {};

  settled.forEach((outcome, i) => {
    const { promptKey, temperature } = jobs[i];
    results[promptKey][temperature] =
      outcome.status === "fulfilled"
        ? extractText(outcome.value)
        : describeError(outcome.reason);
  });

  res.json({ results });
});

app.listen(PORT, () => {
  console.log(`dummy is running - open http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "WARNING: ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key."
    );
  }
});
