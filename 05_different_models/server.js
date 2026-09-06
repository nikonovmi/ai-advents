import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

// ---------------------------------------------------------------------------
// VERIFY THESE RATES BEFORE TRUSTING THE COST COLUMN.
// https://claude.com/pricing#api  /  https://console.anthropic.com/settings/billing
// Published per-token rates change and introductory pricing expires, so the
// numbers below can silently go stale. They are dollars per MILLION tokens and
// are the only thing the cost column is derived from - if they are wrong, every
// cost figure on the page is wrong by the same factor.
// Last checked against claude.com/pricing on 2026-09-06.
// ---------------------------------------------------------------------------
const MODELS = [
  { tier: "low",  id: "claude-haiku-4-5-20251001", inputRate: 1, outputRate: 5  },
  { tier: "mid",  id: "claude-sonnet-5",           inputRate: 2, outputRate: 10 },
  { tier: "high", id: "claude-opus-5",             inputRate: 5, outputRate: 25 },
];

const MAX_TOKENS = 3000;
const JUDGE_MODEL = "claude-opus-5";
// The judge's own budget is separate from MAX_TOKENS and needs to be generous:
// it runs with adaptive thinking, and reasoning tokens come out of the same
// allowance as the JSON. Too small a cap truncates the JSON mid-string and the
// whole ranking is lost to a parse error. This is a ceiling, not a target - a
// typical ranking uses a small fraction of it.
const JUDGE_MAX_TOKENS = 16000;
const PORT = 3000;

// The mid and high tiers run with adaptive thinking, so their reported
// outputTokens INCLUDE reasoning tokens. That is not measurement noise - those
// tokens are generated and billed at the output rate, so they belong in the
// cost column exactly as the API reports them. Do not subtract them out: the
// whole point of the comparison is what a tier actually costs to answer a task.
// (Haiku 4.5 predates adaptive thinking and takes `budget_tokens` instead, so
// it simply runs without thinking here.)
const THINKING_TIERS = new Set(["mid", "high"]);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

// Identity-linked API keys must name the workspace the request acts in; plain
// workspace-scoped keys don't. Harmless to omit when the key doesn't need it.
const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
const client = new Anthropic(
  // The key itself is read from ANTHROPIC_API_KEY by the SDK - never hardcoded.
  workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {},
);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// Progress is tracked per run id so the frontend can show "n of 4 calls done"
// while the single POST /run request is still in flight.
const TOTAL_CALLS = MODELS.length + 1; // one call per model + 1 judge call
const progress = new Map();

app.get("/progress/:runId", (req, res) => {
  res.json({ done: progress.get(req.params.runId) ?? 0, total: TOTAL_CALLS });
});

/**
 * One streamed call. Returns timings, exact token counts and cost.
 * Streaming is what makes time-to-first-token measurable at all.
 */
async function callModel(model, message) {
  const started = Date.now();
  let ttft = null;

  const stream = client.messages.stream({
    model: model.id,
    max_tokens: MAX_TOKENS,
    ...(THINKING_TIERS.has(model.tier) ? { thinking: { type: "adaptive" } } : {}),
    messages: [{ role: "user", content: message }],
  });

  for await (const event of stream) {
    // First content delta of any kind. On the thinking tiers this can be a
    // thinking_delta rather than visible text - it is still the moment the
    // model started emitting, which is what TTFT measures.
    if (ttft === null && event.type === "content_block_delta") {
      ttft = Date.now() - started;
    }
  }

  const finalMessage = await stream.finalMessage();
  const total = Date.now() - started;
  if (ttft === null) ttft = total;

  const text = finalMessage.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  // Token counts come straight from the API's usage object - never estimated.
  const inputTokens = finalMessage.usage.input_tokens;
  const outputTokens = finalMessage.usage.output_tokens;
  const cost =
    (inputTokens / 1e6) * model.inputRate + (outputTokens / 1e6) * model.outputRate;

  return {
    text,
    // "max_tokens" means the answer was cut off - on the thinking tiers the
    // model can spend the whole cap reasoning and never emit any text at all.
    stopReason: finalMessage.stop_reason,
    ttft,
    total,
    inputTokens,
    outputTokens,
    cost,
  };
}

const JudgementSchema = z.object({
  ranking: z
    .array(
      z.object({
        label: z.enum(["A", "B", "C"]),
        reason: z.string(),
      }),
    )
    .length(3),
});

/**
 * Blind quality ranking. The three answers are shuffled and stripped of any
 * model identity, so the judge cannot favour the flagship by name.
 */
async function judge(task, entries) {
  const shuffled = [...entries].sort(() => Math.random() - 0.5);
  const labels = ["A", "B", "C"];
  const labelToModel = new Map();

  const answers = shuffled
    .map((entry, i) => {
      labelToModel.set(labels[i], entry.model);
      return `<answer label="${labels[i]}">\n${entry.response}\n</answer>`;
    })
    .join("\n\n");

  let response;
  try {
    response = await client.messages.parse({
      model: JUDGE_MODEL,
      max_tokens: JUDGE_MAX_TOKENS,
      messages: [
        {
          role: "user",
          content:
            "Three assistants were given the same task. Rank their answers from best to worst.\n\n" +
            "Judge on CORRECTNESS first and CLARITY second. Give exactly one short sentence " +
            "of justification for each placement. Return the ranking best-first. JSON only.\n\n" +
            `<task>\n${task}\n</task>\n\n${answers}`,
        },
      ],
      output_config: { format: zodOutputFormat(JudgementSchema) },
    });
  } catch (err) {
    // A JSON parse failure here almost always means the response was cut off at
    // JUDGE_MAX_TOKENS, not that the model emitted malformed JSON. Say so.
    if (/parse structured output/i.test(err.message)) {
      throw new Error(
        `The judge's reply was cut off before the JSON closed (cap: ${JUDGE_MAX_TOKENS} tokens). ` +
          "Raise JUDGE_MAX_TOKENS in server.js.",
      );
    }
    throw err;
  }

  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `The judge hit its ${JUDGE_MAX_TOKENS}-token cap before finishing. Raise JUDGE_MAX_TOKENS in server.js.`,
    );
  }

  const parsed = response.parsed_output;
  if (!parsed) throw new Error("The judge returned no parseable ranking.");

  // Map the anonymized labels back to real model names, server-side.
  return parsed.ranking.map((item, i) => ({
    rank: i + 1,
    model: labelToModel.get(item.label) ?? "unknown",
    reason: item.reason,
  }));
}

app.post("/run", async (req, res) => {
  const { message, runId } = req.body ?? {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Body must be { message: string }" });
  }

  if (runId) progress.set(runId, 0);
  const tick = () => {
    if (runId) progress.set(runId, (progress.get(runId) ?? 0) + 1);
  };

  try {
    // One call per model, all in parallel. allSettled so a single failure
    // degrades one cell into an error string instead of taking down the grid.
    const settled = await Promise.allSettled(
      MODELS.map((model) => callModel(model, message).finally(tick)),
    );

    const results = MODELS.map((model, i) => {
      const outcome = settled[i];

      if (outcome.status === "rejected") {
        return {
          tier: model.tier,
          model: model.id,
          response: `Error: ${outcome.reason?.message ?? "call failed"}`,
          error: true,
          truncated: false,
          ttft: null,
          total: null,
          inputTokens: null,
          outputTokens: null,
          cost: null,
          costPer1000: null,
        };
      }

      const run = outcome.value;
      const truncated = run.stopReason === "max_tokens";
      return {
        tier: model.tier,
        model: model.id,
        response:
          run.text ||
          (truncated
            ? `(No answer. The model used the entire ${MAX_TOKENS}-token output cap on reasoning and never reached a reply.)`
            : "(Empty response.)"),
        truncated,
        error: false,
        ttft: run.ttft,
        total: run.total,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        cost: run.cost,
        costPer1000: run.cost * 1000,
      };
    });

    let judgement = [];
    let judgeError = null;
    // A truncated or empty answer is still an answer to rank - it just ranks
    // last. Only a hard call failure blocks the judging.
    const judgeable = results.filter((r) => !r.error);
    if (judgeable.length === MODELS.length) {
      try {
        judgement = await judge(message, judgeable);
      } catch (err) {
        judgeError = err.message;
      }
    } else {
      judgeError = "Skipped: not every model returned an answer to rank.";
    }
    tick();

    res.json({ results, judgement, judgeError, maxTokens: MAX_TOKENS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (runId) setTimeout(() => progress.delete(runId), 60_000);
  }
});

app.listen(PORT, () => {
  console.log(`model-lab is running - open http://localhost:${PORT}`);
});
