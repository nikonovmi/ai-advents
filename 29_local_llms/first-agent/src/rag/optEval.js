import { checksPassed, verificationLabel } from "./citationsEval.js";
import { answerLatencyMs } from "./localEval.js";

/**
 * **The pure half of `opt:local` (Day 29)**: three variants of qwen3.5:9b on
 * the Knowledge RAG task — `baseline`, `ctx8k`, `ctx8k+prompt` — put side by
 * side, judged by the decision rule written before the runs, and rendered as
 * `local_opt_report.md` and the page's Optimization tab. `scripts/opt-local.js`
 * runs `eval:local --variant` and `verify:local --variant` per variant and
 * does the I/O.
 */

// ---- one variant -------------------------------------------------------------------

const mean = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** A verify:local turn, kept to what the report reads. */
function slimTurn(t) {
  return {
    message: t.message,
    reply: t.reply,
    turnMs: t.turnMs,
    intent: t.intent ?? null,
    routedIntent: t.routedIntent ?? null,
    override: t.override ?? null,
    patch: t.patch ?? [],
    applied: t.applied ?? [],
    promptVariant: t.promptVariant ?? null,
    standaloneQuestion: t.standaloneQuestion ?? null,
    routerMs: t.routerMetrics?.totalMs ?? null,
    memoryAfter: t.memoryAfter ?? null,
    rag: t.rag ?? null,
    metrics: t.metrics ?? null,
    checks: t.checks,
  };
}

/**
 * One variant's eval and verify outputs (the `local_opt/*.json` files) → the
 * record `local_opt_results.json` keeps.
 *
 * @param {object} o
 * @param {{ id: string, description: string }} o.variant
 * @param {object | null} o.evalRun - `eval_<variant>.json`
 * @param {object | null} o.verifyRun - `verify_<variant>.json`
 */
export function variantRecord({ variant, evalRun, verifyRun }) {
  const g = evalRun?.generators?.[0] ?? null;
  const r = verifyRun?.results?.[0] ?? null;
  const conv = r?.conversations?.find((c) => c.rag) ?? null;
  const turns = (conv?.turns ?? []).map(slimTurn);
  const checks = turns.flatMap((t, i) => Object.entries(t.checks ?? {}).map(([name, ok]) => ({ turn: i + 1, name, ok })));
  return {
    id: variant.id,
    description: variant.description,
    eval: g
      ? {
          startedAt: evalRun.startedAt,
          finishedAt: evalRun.finishedAt,
          settings: evalRun.settings,
          model: g.model,
          summary: g.summary,
          rows: g.rows,
          memory: g.extra?.memory ?? null,
          loadMs: g.extra?.loadMs ?? null,
          reloads: g.extra?.reloads ?? null,
          numCtxSeen: g.extra?.numCtxSeen ?? [],
          responses: g.extra?.responses ?? [],
        }
      : null,
    verify: r
      ? {
          startedAt: verifyRun.startedAt,
          finishedAt: verifyRun.finishedAt,
          settings: verifyRun.settings,
          model: r.model,
          passed: verifyRun.passed,
          outbound: verifyRun.outbound?.length ?? 0,
          claudeCalls: verifyRun.claudeCalls ?? 0,
          checks,
          checksPassed: checks.filter((c) => c.ok).length,
          failed: checks.filter((c) => !c.ok).map((c) => `turn ${c.turn}: ${c.name}`),
          memoryCheck: turns.at(-1)?.checks?.usesMemory ?? null,
          turns,
          memory: r.memory ?? null,
          reloads: r.reloads ?? null,
          numCtxSeen: r.numCtxSeen ?? [],
          responses: r.responses ?? [],
          possibleTruncations: turns.filter((t) => t.checks?.noTruncation === false).length,
          meanTurnMs: mean(turns.map((t) => t.turnMs)),
        }
      : null,
  };
}

// ---- the baseline against Day 28 ---------------------------------------------------

/** Day 29's rule for a changed setup: fact score off by more than 0.1, or mean latency by more than 30%. */
export const DRIFT = { factScore: 0.1, latency: 0.3 };

/**
 * @param {object} baseline - the baseline variant's eval summary
 * @param {object} day28 - Day 28's qwen3.5:9b summary
 */
export function baselineDrift(baseline, day28) {
  const factDiff = baseline.meanFactScore != null && day28.meanFactScore != null ? baseline.meanFactScore - day28.meanFactScore : null;
  const latencyRatio = baseline.meanAnswerLatencyMs && day28.meanAnswerLatencyMs ? baseline.meanAnswerLatencyMs / day28.meanAnswerLatencyMs - 1 : null;
  const factOk = factDiff == null || Math.abs(factDiff) <= DRIFT.factScore;
  const latencyOk = latencyRatio == null || Math.abs(latencyRatio) <= DRIFT.latency;
  return { factDiff, latencyRatio, factOk, latencyOk, ok: factOk && latencyOk };
}

// ---- the decision rule (written before the runs) ----------------------------------------

const sumScores = (rows) => rows.filter((r) => !r.expect_decline).reduce((a, r) => a + (r.grade?.score ?? 0), 0);

/**
 * The quality rows of the rule "no quality row gets worse by more than one
 * question", each as a number per variant and the direction that is better.
 * Counts are questions (or quotes/claims); the fact score is summed over the
 * 7 answerable questions, so "one question" is 1.0 of it.
 */
export const QUALITY_ROWS = [
  { key: "answeredWithCitations", label: "answered with a valid citation", better: "higher", of: (s) => s.answeredWithCitations },
  { key: "answerableWithSources", label: "answerable questions answered", better: "higher", of: (s) => s.answerableWithSources },
  { key: "fabricatedFirstAttempt", label: "fabricated quotes on the first attempt", better: "lower", of: (s) => s.fabricatedFirstAttempt },
  { key: "retries", label: "retries", better: "lower", of: (s) => s.retries },
  { key: "droppedCitations", label: "dropped citations", better: "lower", of: (s) => s.droppedCitations },
  { key: "downgrades", label: "downgrades", better: "lower", of: (s) => s.downgrades },
  { key: "unsupportedClaims", label: "unsupported claims (faithfulness)", better: "lower", of: (s) => s.claimVerdicts?.unsupported },
  { key: "correctIdk", label: "correct \"I don't know\"", better: "higher", of: (s) => s.correctIdk },
  { key: "falseIdk", label: "false \"I don't know\"", better: "lower", of: (s) => s.falseIdk?.length },
  { key: "factScoreSum", label: "fact score, summed over the 7 answerable", better: "higher", of: (s, rows) => sumScores(rows) },
];

/** How much worse `b` is than `a` on a row (≥ 0), in questions. */
const worseBy = (row, a, b) => Math.max(0, row.better === "higher" ? a - b : b - a);

/**
 * @param {ReturnType<typeof variantRecord>[]} variants - baseline, ctx8k, ctx8k+prompt
 * @returns {{ ctx8k: object, prompt: object, adopted: string }}
 */
export function decide(variants) {
  const by = Object.fromEntries(variants.map((v) => [v.id, v]));
  const base = by.baseline?.eval;
  const ctx = by.ctx8k?.eval;
  const v2 = by["ctx8k+prompt"]?.eval;

  // Experiment 1: 0 possible truncations, and no quality row worse by more than one question.
  const ctxChecks = [];
  if (base && ctx) {
    const truncations = ctx.summary.possibleTruncations.length + (by.ctx8k.verify?.possibleTruncations ?? 0);
    ctxChecks.push({ rule: "0 possible truncations (eval + verify:local)", ok: truncations === 0, detail: `${truncations}` });
    for (const row of QUALITY_ROWS) {
      const a = row.of(base.summary, base.rows) ?? 0;
      const b = row.of(ctx.summary, ctx.rows) ?? 0;
      const worse = worseBy(row, a, b);
      ctxChecks.push({ rule: `${row.label}: not worse by more than one question`, ok: worse <= 1 + 1e-9, detail: `${fmt(a)} → ${fmt(b)}` });
    }
  }
  const ctxAdopted = ctxChecks.length > 0 && ctxChecks.every((c) => c.ok);

  // Experiment 2, on top of 1: fact score ≥ baseline, no new false IDK, faithfulness not lower, verify's memory check passes.
  const promptChecks = [];
  if (base && v2) {
    promptChecks.push({ rule: "ctx8k is adopted (v2 runs on top of it)", ok: ctxAdopted, detail: ctxAdopted ? "yes" : "no" });
    const fs = v2.summary.meanFactScore ?? 0;
    const fb = base.summary.meanFactScore ?? 0;
    promptChecks.push({ rule: "mean fact score ≥ the baseline's", ok: fs >= fb - 1e-9, detail: `${fmt(fb)} → ${fmt(fs)}` });
    const baseFalse = new Set(base.summary.falseIdk.map((x) => x.id));
    const added = v2.summary.falseIdk.filter((x) => !baseFalse.has(x.id)).map((x) => x.id);
    promptChecks.push({ rule: "no new false \"I don't know\"", ok: added.length === 0, detail: added.length ? `new: ${added.join(", ")}` : `${[...baseFalse].join(", ") || "none"} → ${v2.summary.falseIdk.map((x) => x.id).join(", ") || "none"}` });
    const ffb = base.summary.meanFaithfulness ?? 0;
    const ffs = v2.summary.meanFaithfulness ?? 0;
    promptChecks.push({ rule: "mean faithfulness doesn't drop", ok: ffs >= ffb - 1e-9, detail: `${fmt(ffb)} → ${fmt(ffs)}` });
    const mem = by["ctx8k+prompt"].verify?.memoryCheck;
    promptChecks.push({ rule: "verify:local's memory check passes", ok: mem === true, detail: mem == null ? "not run" : mem ? "passed" : "failed" });
  }
  const promptAdopted = promptChecks.length > 0 && promptChecks.every((c) => c.ok);
  return {
    ctx8k: { adopted: ctxAdopted, checks: ctxChecks, failed: ctxChecks.filter((c) => !c.ok).map((c) => c.rule) },
    prompt: { adopted: promptAdopted, checks: promptChecks, failed: promptChecks.filter((c) => !c.ok).map((c) => c.rule) },
    adopted: promptAdopted ? "ctx8k+prompt" : ctxAdopted ? "ctx8k" : "baseline",
  };
}

const fmt = (x) => (x == null ? "—" : Number.isInteger(x) ? String(x) : x.toFixed(2));

// ---- tables ------------------------------------------------------------------------------

const num = (x, d = 2) => (x == null ? "—" : Number(x).toFixed(d));
const sec = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`);
const gb = (bytes) => (bytes == null ? "—" : `${(bytes / 2 ** 30).toFixed(1)} GB`);
const ids = (xs) => (xs.length ? `${xs.length}: ${xs.join(", ")}` : "0");
const patchText = (patch) => (patch?.length ? patch.map((p) => `${p.op}${p.text ? ` "${p.text}"` : ""}${p.id ? ` ${p.id}` : ""}`).join("; ") : "(empty)");

/** A question's cell: status · fact score · verification. */
function questionCell(rows, id) {
  const r = rows?.find((x) => x.id === id);
  if (!r) return "—";
  const status = r.error ? "error" : r.run.status === "dont_know" ? `IDK (${r.run.dontKnow?.reason})` : r.run.status;
  return `${status} · facts ${num(r.grade?.score)} · ${verificationLabel(r.run)}`;
}

/**
 * The summary table: one row per measure, one column per variant, then Day
 * 28's Claude column as a reference. Shared by the Markdown report and the
 * page's Optimization tab.
 *
 * @param {object} results - `local_opt_results.json`
 */
export function optSummaryRows(results) {
  const vs = results.variants;
  const claude = results.reference?.claude ?? null;
  const col = (fn, ref = "") => [...vs.map((v) => fn(v)), ...(claude ? [ref] : [])];
  const evalCol = (fn, refFn = null) => col((v) => (v.eval ? fn(v.eval.summary, v.eval) : "—"), claude && refFn ? refFn(claude.summary, claude) : "n/a");
  const verifyCol = (fn) => col((v) => (v.verify ? fn(v.verify) : "—"), "n/a");
  const turn = (v, i) => v.turns[i] ?? null;

  const settings = [
    ["num_ctx: RAG calls · plain chat", ...col((v) => `${v.eval?.settings?.ragNumCtx ?? "?"} · ${v.eval?.settings?.numCtx ?? "?"}`, "n/a (cloud)")],
    ["prompts", ...col((v) => v.eval?.settings?.promptVariant ?? "?", "v1")],
    ["eval started (UTC) · verify:local started", ...col((v) => `${v.eval?.startedAt?.slice(11, 19) ?? "—"} · ${v.verify?.startedAt?.slice(11, 19) ?? "—"}`, results.reference?.claudeGeneratedAt?.slice(0, 10) ?? "Day 28")],
  ];
  const quality = [
    ["answered with ≥ 1 source / valid citation", ...evalCol((s) => `${s.answeredWithSources}/${s.answered} · ${s.answeredWithCitations}/${s.answered}`, (s) => `${s.answeredWithSources}/${s.answered} · ${s.answeredWithCitations}/${s.answered}`)],
    ["answerable questions answered (of 7)", ...evalCol((s) => `${s.answerableWithSources}/${s.answerable}`, (s) => `${s.answerableWithSources}/${s.answerable}`)],
    ["fabricated quotes on the first attempt", ...evalCol((s) => `${s.fabricatedFirstAttempt} of ${s.firstAttemptCitations}`, (s) => `${s.fabricatedFirstAttempt} of ${s.firstAttemptCitations}`)],
    ["first attempt valid", ...evalCol((s) => `${s.firstAttemptValid}/${s.contractCalls}`, (s) => `${s.firstAttemptValid}/${s.contractCalls}`)],
    ["retries · dropped citations · downgrades", ...evalCol((s) => `${s.retries} (${s.retriesFixed} fixed) · ${s.droppedCitations} · ${s.downgrades}`, (s) => `${s.retries} (${s.retriesFixed} fixed) · ${s.droppedCitations} · ${s.downgrades}`)],
    ["invalid JSON / schema failures", ...evalCol((s) => `${s.invalidJson} of ${s.structuredCalls} calls · ${s.schemaFailures}`, () => "n/a (tool use)")],
    ["faithfulness (supported / partial / unsupported)", ...evalCol((s) => `${num(s.meanFaithfulness)} · ${s.claimVerdicts.supported} / ${s.claimVerdicts.partial} / ${s.claimVerdicts.unsupported}`, (s) => `${num(s.meanFaithfulness)} · ${s.claimVerdicts.supported} / ${s.claimVerdicts.partial} / ${s.claimVerdicts.unsupported}`)],
    ["uncited claims", ...evalCol((s) => String(s.uncitedClaims), (s) => String(s.uncitedClaims))],
    ["correct \"I don't know\" · false \"I don't know\"", ...evalCol((s) => `${s.correctIdk}/${s.toDecline} · ${s.falseIdk.length ? s.falseIdk.map((x) => x.id).join(", ") : "0"}`, (s) => `${s.correctIdk}/${s.toDecline} · ${s.falseIdk.length ? s.falseIdk.map((x) => x.id).join(", ") : "0"}`)],
    ["mean fact score (7 answerable)", ...evalCol((s) => num(s.meanFactScore), (s) => num(s.meanFactScore))],
    ["q06 (two lines in one quote on Day 28)", ...col((v) => questionCell(v.eval?.rows, "q06"), questionCell(claude?.rows, "q06"))],
    ["q12 (Web is Beta: false IDK on Day 28)", ...col((v) => questionCell(v.eval?.rows, "q12"), questionCell(claude?.rows, "q12"))],
  ];
  const router = [
    ["verify:local checks (RAG chat)", ...verifyCol((v) => `${v.checksPassed}/${v.checks.length}${v.failed.length ? ` · failed: ${v.failed.join(", ")}` : ""}`)],
    ["turn 2 (rule + term): intent · memory patch", ...verifyCol((v) => (turn(v, 1) ? `${turn(v, 1).intent} · ${patchText(turn(v, 1).patch)}` : "—"))],
    ["turn 3 uses the task memory (CMP)", ...verifyCol((v) => (v.memoryCheck == null ? "—" : v.memoryCheck ? "yes" : "no"))],
  ];
  const speed = [
    ["time to first token (≈ prompt processing)", ...evalCol((s) => sec(s.meanTtftMs), (s) => sec(s.meanTtftMs))],
    ["generation tokens/s", ...evalCol((s) => num(s.meanGenTps, 1), (s) => num(s.meanGenTps, 1))],
    ["answer latency incl. retry: mean · max", ...evalCol((s) => `${sec(s.meanAnswerLatencyMs)} · ${sec(s.maxAnswerLatencyMs)}`, (s) => `${sec(s.meanAnswerLatencyMs)} · ${sec(s.maxAnswerLatencyMs)}`)],
    ["prompt tokens · output tokens (mean per question)", ...evalCol((s) => `${num(s.meanPromptTokens, 0)} · ${num(s.meanOutputTokens, 0)}`, (s) => `${num(s.meanPromptTokens, 0)} · ${num(s.meanOutputTokens, 0)}`)],
    ["verify:local chat turns 1 · 2 · 3 (router ms in turn)", ...verifyCol((v) => v.turns.map((t) => `${sec(t.turnMs)}${t.routerMs != null ? ` (${sec(t.routerMs)})` : ""}`).join(" · "))],
  ];
  const resources = [
    ["memory after the eval (/api/ps: total · on GPU · ctx)", ...col((v) => (v.eval?.memory ? `${gb(v.eval.memory.size)} · ${gb(v.eval.memory.sizeVram)} · ${v.eval.memory.contextLength ?? "?"}` : "—"), "n/a (cloud)")],
    ["memory after verify:local (/api/ps)", ...col((v) => (v.verify?.memory ? `${gb(v.verify.memory.size)} · ${gb(v.verify.memory.sizeVram)} · ${v.verify.memory.contextLength ?? "?"}` : "—"), "n/a (cloud)")],
    ["model reloads (load > 1 s after the first request): eval · verify:local", ...col((v) => `${v.eval?.reloads ?? "—"} · ${v.verify?.reloads ?? "—"}`, "n/a (cloud)")],
    ["num_ctx seen on local calls: eval · verify:local", ...col((v) => `${(v.eval?.numCtxSeen ?? []).join("/") || "—"} · ${(v.verify?.numCtxSeen ?? []).join("/") || "—"}`, "n/a (cloud)")],
    ["possible truncations: eval · verify:local", ...col((v) => `${v.eval ? ids(v.eval.summary.possibleTruncations) : "—"} · ${v.verify?.possibleTruncations ?? "—"}`, (claude ? ids(claude.summary.possibleTruncations) : ""))],
  ];
  return {
    head: [...vs.map((v) => v.id), ...(claude ? ["Claude Haiku 4.5 (Day 28, reference)"] : [])],
    sections: [
      { title: "settings", rows: settings },
      { title: "quality (eval:local, 10 questions)", rows: quality },
      { title: "router / memory (verify:local)", rows: router },
      { title: "speed", rows: speed },
      { title: "resources", rows: resources },
    ],
  };
}

/** The per-question table: one row per question, one cell per variant (and Claude). */
export function optQuestionRows(results) {
  const claude = results.reference?.claude ?? null;
  const cellOf = (rows, q) => {
    const r = rows?.find((x) => x.id === q.id);
    if (!r) return "—";
    const status = r.error ? "error" : r.run.status === "dont_know" ? `IDK (${r.run.dontKnow?.reason})` : r.run.status;
    const { passed, applied } = checksPassed(r.checks);
    return `${status} · ${passed}/${applied} · ${r.grade ? `facts ${num(r.grade.score)} · ` : ""}${sec(answerLatencyMs(r.run))}`;
  };
  return results.questions.map((q) => [q.id, q.type, ...results.variants.map((v) => cellOf(v.eval?.rows, q)), ...(claude ? [cellOf(claude.rows, q)] : [])]);
}

// ---- the prompt diff ---------------------------------------------------------------------

/**
 * A line diff (LCS): `[{ op: " " | "-" | "+", line }]`. Small prompts only.
 *
 * @param {string} a
 * @param {string} b
 */
export function lineDiff(a, b) {
  const x = String(a).split("\n");
  const y = String(b).split("\n");
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: " ", line: x[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: "-", line: x[i++] });
    else out.push({ op: "+", line: y[j++] });
  }
  while (i < n) out.push({ op: "-", line: x[i++] });
  while (j < m) out.push({ op: "+", line: y[j++] });
  return out;
}

// ---- the report -------------------------------------------------------------------------

const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

/** `local_opt_report.md`. */
export function renderOptReport(results, notes) {
  const table = optSummaryRows(results);
  const { decision, drift, prompts } = results;
  const out = [
    "# Optimizing qwen3.5:9b for the Knowledge RAG chat (Day 29)",
    "",
    `Generated ${results.generatedAt} by \`npm run opt:local\` on ${results.environment.machine}, Ollama ${results.environment.ollamaVersion}. Raw results: [\`local_opt_results.json\`](local_opt_results.json). Findings: [\`local_opt_notes.md\`](local_opt_notes.md).`,
    "",
    "Three variants of the same model, run in this order with a cooldown between them, each on the 10 `citations` questions (`eval:local`, from Day 28's cached retrieval, so every variant answers from the same chunks; judged by Claude) and then on the Knowledge RAG conversation of `verify:local` (fully local, live retrieval):",
    "",
    "| variant | num_ctx (all calls) | prompts |",
    "| --- | --- | --- |",
    ...results.variants.map((v) => `| \`${v.id}\` | ${v.eval?.settings?.ragNumCtx === v.eval?.settings?.numCtx ? v.eval?.settings?.numCtx : `${v.eval?.settings?.ragNumCtx} RAG / ${v.eval?.settings?.numCtx} plain`} | ${v.eval?.settings?.promptVariant ?? "?"} |`),
    "",
    `Claude Haiku 4.5's column is Day 28's run (${results.reference?.claudeGeneratedAt ?? "?"}), not re-run: a reference only.`,
    "",
    "## Decision",
    "",
    `**Adopted: \`${decision.adopted}\`.**`,
    "",
    `- Experiment 1, \`ctx8k\`: **${decision.ctx8k.adopted ? "adopted" : "not adopted"}**${decision.ctx8k.failed.length ? ` — failed: ${decision.ctx8k.failed.join("; ")}` : ""}.`,
    `- Experiment 2, \`ctx8k+prompt\`: **${decision.prompt.adopted ? "adopted" : "not adopted"}**${decision.prompt.failed.length ? ` — failed: ${decision.prompt.failed.join("; ")}` : ""}.`,
    "",
    "| rule | result | ✓ |",
    "| --- | --- | --- |",
    ...decision.ctx8k.checks.map((c) => `| ctx8k: ${cell(c.rule)} | ${cell(c.detail)} | ${c.ok ? "✓" : "✗"} |`),
    ...decision.prompt.checks.map((c) => `| ctx8k+prompt: ${cell(c.rule)} | ${cell(c.detail)} | ${c.ok ? "✓" : "✗"} |`),
    "",
  ];
  if (drift) {
    out.push(
      `Baseline against Day 28's qwen3.5:9b column: fact score ${num(drift.day28.meanFactScore)} → ${num(drift.baseline.meanFactScore)} (${drift.factDiff >= 0 ? "+" : ""}${num(drift.factDiff)}, limit ±${DRIFT.factScore}), mean latency ${sec(drift.day28.meanAnswerLatencyMs)} → ${sec(drift.baseline.meanAnswerLatencyMs)} (${drift.latencyRatio >= 0 ? "+" : ""}${Math.round(drift.latencyRatio * 100)}%, limit ±${DRIFT.latency * 100}%): **${drift.ok ? "same setup" : "the setup changed"}**.`,
      "",
    );
  }
  out.push("## Summary", "");
  for (const section of table.sections) {
    out.push(`| ${section.title} | ${table.head.join(" | ")} |`, `| --- |${table.head.map(() => " --- |").join("")}`);
    out.push(...section.rows.map(([label, ...values]) => `| ${cell(label)} | ${values.map(cell).join(" | ")} |`), "");
  }
  out.push(
    "TTFT: Ollama's load + prompt-evaluation time of the first answer call. Latency: the answer call with its retry, or the clarifying call, without the shared retrieval. A reload is a response whose `load_duration` is over 1 s after the first request of the run (the warm-up: at the RAG window for the eval, at the plain chat's window for verify:local, as opening the app would). Memory is `/api/ps` right after the run, before the model is unloaded.",
    "",
    "## Per question",
    "",
    `| id | type | ${table.head.join(" | ")} |`,
    `| --- | --- |${table.head.map(() => " --- |").join("")}`,
    ...optQuestionRows(results).map(([id, type, ...cells]) => `| ${id} | ${type} | ${cells.map(cell).join(" | ")} |`),
    "",
    "Cells: status · checks passed · fact score (answerable questions) · answer latency.",
    "",
  );
  out.push("## verify:local, turn by turn", "");
  for (const v of results.variants) {
    if (!v.verify) continue;
    out.push(`### ${v.id}`, "", `${v.verify.passed ? "PASS" : "FAIL"} · ${v.verify.checksPassed}/${v.verify.checks.length} checks · outbound non-localhost ${v.verify.outbound} · Claude calls ${v.verify.claudeCalls} · reloads ${v.verify.reloads}`, "");
    for (const [i, t] of v.verify.turns.entries()) {
      const failed = Object.entries(t.checks ?? {}).filter(([, ok]) => !ok).map(([k]) => k);
      out.push(
        `**${i + 1}.** ${cell(t.message)}`,
        "",
        `Router: **${t.intent}**${t.override ? ` (${t.override})` : ""} · patch ${cell(patchText(t.patch))} · ${sec(t.routerMs)} · turn ${sec(t.turnMs)}${t.rag ? ` · ${t.rag.status} · ${t.rag.citations.length} citation(s) · ${t.rag.verification ? (t.rag.verification.firstAttemptValid ? "verified" : t.rag.verification.downgraded ? "downgraded" : "retried") : "—"}` : ""} · ${failed.length ? `✗ ${failed.join(", ")}` : "✓"}`,
        "",
        "> " + cell(t.reply),
        "",
      );
    }
  }
  if (prompts) {
    out.push("## Prompts: v1 vs v2", "", "Token counts are qwen3.5:9b's own (Ollama's `prompt_eval_count` with the prompt as the system message, minus the same call without it). Characters are what `npm test` checks offline.", "");
    out.push("| prompt | v1 tokens | v2 tokens | v1 chars | v2 chars |", "| --- | ---: | ---: | ---: | ---: |");
    for (const p of prompts.list) out.push(`| ${p.label} | ${p.v1.tokens ?? "—"} | ${p.v2.tokens ?? "—"} | ${p.v1.chars} | ${p.v2.chars} |`);
    out.push("");
    for (const p of prompts.list.filter((x) => x.diff)) {
      out.push(`### ${p.label}`, "", "```diff", ...lineDiff(p.v1.text, p.v2.text).map((d) => `${d.op}${d.line}`), "```", "");
    }
  }
  if (notes?.trim()) out.push("## Findings", "", notes.trim(), "");
  return out.join("\n");
}
