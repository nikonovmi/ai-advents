import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const PORT = 3000;
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 300;

// The whole experiment: these five values, everything else held constant.
// 1.2 is deliberately out of range (the API accepts 0.0-1.0) and is expected
// to fail with a 400. That failure is the evidence, not a bug.
const TEMPERATURES = [0, 0.35, 0.7, 1.0, 1.2];
const RUNS_PER_TEMPERATURE = 3;

// The key (and, for org-scoped keys, the workspace id) come from the environment.
// dotenv has already loaded .env by this point; nothing is hardcoded here.
const { ANTHROPIC_API_KEY, ANTHROPIC_WORKSPACE_ID } = process.env;

const client = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
  // An API key that isn't scoped to a workspace must name one per request.
  // Omitted entirely when unset, so workspace-scoped keys keep working untouched.
  ...(ANTHROPIC_WORKSPACE_ID
    ? { defaultHeaders: { "anthropic-workspace-id": ANTHROPIC_WORKSPACE_ID } }
    : {}),
});
const app = express();

app.use(express.json());
app.use(express.static("public"));

async function runOnce(message, temperature) {
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature,
      messages: [{ role: "user", content: message }],
    });
    return response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
  } catch (error) {
    if (error instanceof Anthropic.BadRequestError) {
      return `ERROR ${error.status}: ${error.message}`;
    }
    if (error instanceof Anthropic.AuthenticationError) {
      return `ERROR ${error.status}: invalid or missing ANTHROPIC_API_KEY`;
    }
    if (error instanceof Anthropic.RateLimitError) {
      return `ERROR ${error.status}: rate limited - ${error.message}`;
    }
    if (error instanceof Anthropic.APIError) {
      return `ERROR ${error.status}: ${error.message}`;
    }
    return `ERROR: ${error.message}`;
  }
}

function wordSet(text) {
  return new Set(text.toLowerCase().match(/[a-z0-9']+/g) ?? []);
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

// Divergence = 100 * (1 - mean pairwise Jaccard similarity of the successful runs).
// 0% means the runs are word-for-word interchangeable; higher means they spread apart.
function divergence(runs) {
  const sets = runs.map(wordSet);
  if (sets.length < 2) return null;
  const scores = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      scores.push(jaccard(sets[i], sets[j]));
    }
  }
  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  return Math.round((1 - mean) * 100);
}

app.post("/run", async (req, res) => {
  const message = req.body?.message;
  if (typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "Body must include a non-empty 'message' string." });
  }

  // All 5 x 3 calls go out at once; the grid is one round trip.
  const jobs = TEMPERATURES.flatMap((temperature) =>
    Array.from({ length: RUNS_PER_TEMPERATURE }, () => ({
      temperature,
      promise: runOnce(message, temperature),
    })),
  );

  const settled = await Promise.allSettled(jobs.map((job) => job.promise));

  const results = {};
  for (const temperature of TEMPERATURES) {
    results[String(temperature)] = { runs: [], divergence: null };
  }

  settled.forEach((outcome, index) => {
    const key = String(jobs[index].temperature);
    results[key].runs.push(
      outcome.status === "fulfilled" ? outcome.value : `ERROR: ${outcome.reason?.message ?? outcome.reason}`,
    );
  });

  for (const key of Object.keys(results)) {
    const successful = results[key].runs.filter((text) => !text.startsWith("ERROR"));
    results[key].divergence = divergence(successful);
  }

  res.json({ results });
});

app.listen(PORT, () => {
  if (!ANTHROPIC_API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set - every cell will come back as an auth error.");
  } else if (ANTHROPIC_WORKSPACE_ID) {
    console.log(`Using workspace ${ANTHROPIC_WORKSPACE_ID}`);
  }
  console.log(`temp-lab running at http://localhost:${PORT}`);
});
