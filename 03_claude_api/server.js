// Loaded first so the Anthropic client sees ANTHROPIC_API_KEY when ./client.js
// is evaluated — ESM evaluates imports in order, and client.js reads env at
// module scope.
import "dotenv/config";

import express from "express";
import { randomUUID } from "node:crypto";

import { MAX_IN_FLIGHT, countWords } from "./client.js";
import {
  METHODS,
  METHOD_KEYS,
  METHOD_LABELS,
  SOLVER_MODEL,
  SOLVER_MAX_TOKENS,
  SOLVER_TEMPERATURE,
} from "./methods.js";
import {
  judgeAnswer,
  shuffle,
  RUBRIC_CRITERIA,
  RUBRIC_KEYS,
  MAX_TOTAL,
  JUDGE_MODEL,
} from "./judge.js";

const PORT = 3000;

const PROBLEM = `I am building a quit-smoking app and I have a hard deadline I cannot move.

  - Today is 1 March. The marketing campaign is already running and launch is publicly
    committed for 1 May. That is 8 weeks.
  - 400 people have pre-ordered an annual subscription at 40 GBP each. The 16,000 GBP is
    already spent on the campaign, so I cannot refund at scale without going insolvent.
  - No code exists yet. No backend, no app, no content.
  - The team is two people: me (full-stack developer) and a part-time designer. Budget
    beyond our own time is about 3,000 GBP.
  - The campaign says iOS and Android.

What should I build, and how should I build it, so that on 1 May there is something the
400 people who already paid consider worth the money - and I am not facing mass refund
demands or a consumer-protection complaint?

Give a concrete recommendation and justify it.`;

// Progress for in-flight batches, keyed by a job id the client generates.
// Bounded: a job is dropped a minute after its batch finishes.
const progress = new Map();

function setProgress(jobId, patch) {
  if (!jobId) return;
  const current = progress.get(jobId) ?? { done: 0, total: 0, phase: "solving" };
  progress.set(jobId, { ...current, ...patch });
}

function bumpProgress(jobId) {
  if (!jobId) return;
  const current = progress.get(jobId);
  if (current) current.done += 1;
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

app.get("/config", (_req, res) => {
  res.json({
    problem: PROBLEM,
    methods: METHOD_KEYS.map((key) => ({ key, label: METHOD_LABELS[key] })),
    rubric: RUBRIC_CRITERIA,
    maxTotal: MAX_TOTAL,
    solverModel: SOLVER_MODEL,
    judgeModel: JUDGE_MODEL,
  });
});

app.get("/progress/:jobId", (req, res) => {
  res.json(progress.get(req.params.jobId) ?? { done: 0, total: 0, phase: "starting" });
});

app.post("/run", async (req, res) => {
  const requested = Number(req.body?.runs);
  const runs =
    Number.isFinite(requested) && requested >= 1
      ? Math.min(Math.floor(requested), 10)
      : 1;

  const jobId = typeof req.body?.jobId === "string" ? req.body.jobId : null;
  const cellCount = METHOD_KEYS.length * runs;
  // Every solve is one progress step; every judged answer is another.
  setProgress(jobId, { done: 0, total: cellCount * 2, phase: "solving" });

  // --- solve ---------------------------------------------------------------
  const cells = [];
  for (const method of METHOD_KEYS) {
    for (let run = 0; run < runs; run++) {
      cells.push({ method, run });
    }
  }

  const settled = await Promise.allSettled(
    cells.map(async (cell) => {
      try {
        const result = await METHODS[cell.method](PROBLEM);
        return { ...cell, ...result };
      } finally {
        bumpProgress(jobId);
      }
    })
  );

  const results = settled.map((outcome, i) => {
    const cell = cells[i];
    if (outcome.status === "fulfilled") return outcome.value;
    // One dead call kills its cell and nothing else.
    return {
      ...cell,
      error: String(outcome.reason?.message ?? outcome.reason ?? "unknown error"),
    };
  });

  // --- blind grading -------------------------------------------------------
  const gradable = results.filter((r) => !r.error && r.answer);
  setProgress(jobId, {
    phase: "judging",
    total: cellCount + gradable.length,
    done: cellCount,
  });

  // Strip the method off, shuffle, hand the judge nothing but an opaque id.
  const submissions = shuffle(
    gradable.map((r) => ({ ref: r, opaqueId: `S-${randomUUID().slice(0, 8)}` }))
  );

  const judged = await Promise.allSettled(
    submissions.map(async (submission) => {
      try {
        const verdict = await judgeAnswer({
          opaqueId: submission.opaqueId,
          answer: submission.ref.answer,
        });
        return { submission, verdict };
      } finally {
        bumpProgress(jobId);
      }
    })
  );

  judged.forEach((outcome, i) => {
    const submission = submissions[i];
    submission.ref.opaqueId = submission.opaqueId;
    if (outcome.status === "fulfilled") {
      Object.assign(submission.ref, outcome.value.verdict);
    } else {
      submission.ref.judgeError = String(
        outcome.reason?.message ?? outcome.reason ?? "unknown error"
      );
    }
  });

  // --- shape the response --------------------------------------------------
  const methodsOut = {};
  for (const method of METHOD_KEYS) {
    const methodRuns = results
      .filter((r) => r.method === method)
      .sort((a, b) => a.run - b.run)
      .map((r) =>
        r.error
          ? { run: r.run + 1, error: r.error }
          : {
              run: r.run + 1,
              opaqueId: r.opaqueId ?? null,
              recommendation: r.recommendation,
              truncated: Boolean(r.truncated),
              answer: r.answer,
              transcript: r.transcript,
              latencyMs: r.latencyMs,
              inputTokens: r.usage.inputTokens,
              outputTokens: r.usage.outputTokens,
              apiCalls: r.usage.calls,
              words: countWords(r.answer),
              scores: r.scores ?? null,
              total: r.total ?? null,
              oneLineCritique: r.oneLineCritique ?? null,
              judgeError: r.judgeError ?? null,
            }
      );

    const ok = methodRuns.filter((r) => !r.error);
    const scored = ok.filter((r) => r.total !== null && r.total !== undefined);

    const rubricAverages = {};
    for (const key of RUBRIC_KEYS) {
      rubricAverages[key] = mean(scored.map((r) => r.scores[key]));
    }

    methodsOut[method] = {
      label: METHOD_LABELS[method],
      runs: methodRuns,
      avgScore: mean(scored.map((r) => r.total)),
      rubricAverages,
      avgLatencyMs: mean(ok.map((r) => r.latencyMs)),
      avgOutputTokens: mean(ok.map((r) => r.outputTokens)),
      avgWords: mean(ok.map((r) => r.words)),
    };
  }

  if (jobId) {
    setProgress(jobId, { phase: "done" });
    setTimeout(() => progress.delete(jobId), 60_000).unref?.();
  }

  res.json({
    problem: PROBLEM,
    runs,
    solverModel: SOLVER_MODEL,
    judgeModel: JUDGE_MODEL,
    maxTotal: MAX_TOTAL,
    rubric: RUBRIC_CRITERIA,
    methods: methodsOut,
  });
});

app.listen(PORT, () => {
  console.log(`Reasoning Approaches running at http://localhost:${PORT}`);
  console.log(
    `Solver ${SOLVER_MODEL} (max_tokens ${SOLVER_MAX_TOKENS}, temperature ${SOLVER_TEMPERATURE}) · judge ${JUDGE_MODEL} · max ${MAX_IN_FLIGHT} calls in flight`
  );
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set — copy .env.example to .env");
  }
});
