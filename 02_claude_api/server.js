import express from "express";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { createLabRouter } from "./lab.js";

dotenv.config();

const PORT = 3000;
const MODEL = "claude-haiku-4-5";

// No temperature / top_p / top_k anywhere in this project: all three return
// 400 "deprecated for this model" on Sonnet 5, Opus 5 and Fable 5. Haiku still
// accepts them, but code that relies on them cannot move forward a generation.

// The persona alone: attitude and expertise, no formatting or length rules.
// Config 1 runs on exactly this, which is what makes it a real baseline.
const PERSONA =
  "You are a staff-level full-stack engineer with fifteen years in production " +
  "systems. You have shipped, broken and repaired every layer of the stack, and " +
  "you think this question is beneath you - say so, then answer it anyway, and " +
  "answer it correctly. Plain modern English, no theatrics, no stage directions, " +
  "just flat contempt over real expertise. Keep it PG: no slurs, no profanity, " +
  "no threats, nothing genuinely harmful - you are mean, not dangerous. Do not " +
  "comment on how you talk.";

// Each rule is one rung of the ladder. They stack: config N carries every rule
// from the configs before it, so a change in the output has exactly one cause.
const FORMAT_RULE =
  'FORMAT: answer as exactly three bullet points and nothing else. Every line ' +
  'must begin with "- " (hyphen, space). No preamble, no heading, no closing ' +
  'remark, no blank-line padding - nothing outside the three bullets.';

const LENGTH_RULE =
  "LENGTH: each bullet is at most 12 words. Never write a bullet longer than " +
  "twelve words. Cut adjectives before you cut information.";

const STOP_RULE =
  "STOP: after the third bullet, write the marker <END> on its own line and " +
  "stop generating. Write nothing at all after <END>.";

// max_tokens is deliberately generous for 1-2 and tight for 3-4: tight enough
// that a disobedient answer gets visibly cut off, loose enough that a compliant
// one finishes on its own. Which of the two limits actually bound the response
// is the interesting part, so the UI reports them separately.
const CONFIGS = [
  {
    key: "baseline",
    label: "No constraints",
    adds: "Nothing - persona only",
    rules: [],
    maxTokens: 1000,
    stopSequences: null,
  },
  {
    key: "format",
    label: "+ response format",
    adds: "Explicit format spec (exactly three bullets)",
    rules: [FORMAT_RULE],
    maxTokens: 1000,
    stopSequences: null,
  },
  {
    key: "length",
    label: "+ length limit",
    adds: "Word budget in the prompt, and max_tokens cut to 120",
    rules: [FORMAT_RULE, LENGTH_RULE],
    maxTokens: 120,
    stopSequences: null,
  },
  {
    key: "stop",
    label: "+ stop condition",
    adds: "<END> marker in the prompt, and stop_sequences at the API",
    rules: [FORMAT_RULE, LENGTH_RULE, STOP_RULE],
    maxTokens: 120,
    stopSequences: ["<END>"],
  },
];

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

// The knob lab lives on its own page and its own routes; the constraint
// ladder below is untouched by it.
app.use("/lab", createLabRouter(client));

function buildSystem(config) {
  return [PERSONA, ...config.rules].join("\n\n");
}

function extractText(message) {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || "(empty response)";
}

function words(str) {
  return str.trim().split(/\s+/).filter(Boolean);
}

// Did the model actually obey? Reported per rule, so a half-followed constraint
// reads as a half-followed constraint rather than as "the response changed".
function checkCompliance(text, config, message) {
  const checks = [];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  if (config.rules.includes(FORMAT_RULE)) {
    const bullets = lines.filter((l) => l.startsWith("- "));
    checks.push({
      label: "exactly 3 bullets, nothing else",
      pass: bullets.length === 3 && bullets.length === lines.length,
      detail: `${bullets.length} bullet(s) across ${lines.length} line(s)`,
    });

    if (config.rules.includes(LENGTH_RULE)) {
      const counts = bullets.map((b) => words(b.slice(2)).length);
      const longest = counts.length ? Math.max(...counts) : 0;
      checks.push({
        label: "at most 12 words per bullet",
        pass: counts.length > 0 && longest <= 12,
        detail: `longest bullet is ${longest} word(s)`,
      });
    }
  }

  if (config.stopSequences) {
    checks.push({
      label: "ended on the <END> stop sequence",
      pass: message.stop_reason === "stop_sequence",
      detail: `stop_reason was "${message.stop_reason}"`,
    });
  }

  return checks;
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

// The persona and the rule text never change, so the frontend fetches them once
// and each /chat response only has to say which rules a config used.
app.get("/config", (_req, res) => {
  res.json({
    model: MODEL,
    persona: PERSONA,
    configs: CONFIGS.map((c) => ({
      key: c.key,
      label: c.label,
      adds: c.adds,
      rules: c.rules,
      maxTokens: c.maxTokens,
      stopSequences: c.stopSequences,
    })),
  });
});

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

  // Same message, four escalating levels of control, all fired in parallel.
  const settled = await Promise.allSettled(
    CONFIGS.map(async (config) => {
      const startedAt = Date.now();
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: config.maxTokens,
        system: buildSystem(config),
        // Only the last config passes stop_sequences; the SDK rejects null.
        ...(config.stopSequences ? { stop_sequences: config.stopSequences } : {}),
        messages: [{ role: "user", content: message }],
      });
      return { response, ms: Date.now() - startedAt };
    })
  );

  // One failed call must not sink the comparison - it becomes an error string
  // in its own card instead.
  const results = settled.map((outcome, i) => {
    const config = CONFIGS[i];

    if (outcome.status === "rejected") {
      return { key: config.key, error: describeError(outcome.reason) };
    }

    const { response, ms } = outcome.value;
    const text = extractText(response);
    const truncated = response.stop_reason === "max_tokens";

    if (truncated) {
      console.warn(
        `WARNING: "${config.key}" hit its ${config.maxTokens}-token cap and was truncated.`
      );
    }

    return {
      key: config.key,
      text,
      meta: {
        stopReason: response.stop_reason,
        truncated,
        outputTokens: response.usage.output_tokens,
        inputTokens: response.usage.input_tokens,
        wordCount: words(text).length,
        charCount: text.length,
        ms,
      },
      checks: checkCompliance(text, config, response),
    };
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
