import { answerQuestion, retrieveForQuestion } from "./answer.js";
import { CHECKS, checksOf, checksPassed, summarizeCitations, verificationLabel } from "./citationsEval.js";

/**
 * **The pure half of `eval:local` (Day 28)**: the shared retrieval cache, one
 * generator's run over the questions, the per-generator summary and the
 * Markdown report. `scripts/eval-local.js` does the model loading, the judging
 * and the I/O.
 *
 * The comparison isolates generation: every question is retrieved and
 * reranked **once** (`reports/local_rag_retrieval.json`), and every generator
 * — Claude Haiku 4.5 and each local model — answers from those exact chunks
 * through `answerQuestion` with `retrieval` given, i.e. the same contract the
 * Knowledge chat runs (`submit_answer`, `verifySubmission`, one retry, repair
 * or downgrade). Quality is read the way `eval:citations` reads it
 * (`checksOf`, `summarizeCitations`); speed comes from each call's metrics.
 */

export const LOCAL_EVAL_MODE = "rag+rerank";
/** `--quick`: one corpus question, the paraphrased one, and one to decline. */
export const QUICK_PICKS = [(q) => q.type === "corpus", (q) => q.type === "paraphrased", (q) => q.expect_decline];

export function quickQuestions(questions) {
  const out = [];
  for (const pick of QUICK_PICKS) {
    const q = questions.find((x) => pick(x) && !out.includes(x));
    if (q) out.push(q);
  }
  return out;
}

// ---- the shared retrieval ------------------------------------------------------

/** What makes two retrievals comparable: a cache built under other settings is not reused. */
export function retrievalKey(settings) {
  const { kFinal, kRetrieve, rerankThreshold, strategy, collections = [], minScore = null } = settings;
  return { mode: LOCAL_EVAL_MODE, kFinal, kRetrieve, rerankThreshold, strategy, collections: [...collections].sort(), minScore };
}

const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Each question's retrieval: from the cache when it was built with the same
 * settings for the same question text, else retrieved now (rerank on, no
 * rewrite) and added to it.
 *
 * @param {object} o
 * @param {object[]} o.questions
 * @param {object} o.settings - `ragSettings()`
 * @param {object | null} o.cache - the parsed `local_rag_retrieval.json`, or null
 * @param {typeof retrieveForQuestion} [o.retrieve]
 * @param {boolean} [o.fresh] - ignore the cache
 * @param {(line: string) => void} [o.log]
 * @returns {Promise<{ cache: object, retrievals: Record<string, object>, reused: string[], retrieved: string[] }>}
 */
export async function loadRetrievals({ questions, settings, cache, retrieve = retrieveForQuestion, fresh = false, log = () => {} }) {
  const key = retrievalKey(settings);
  const usable = !fresh && cache && sameKey(cache.settings, key);
  const next = { settings: key, updatedAt: new Date().toISOString(), questions: { ...(usable ? cache.questions : {}) } };
  const retrievals = {};
  const reused = [];
  const retrieved = [];
  for (const q of questions) {
    const hit = next.questions[q.id];
    if (hit && hit.question === q.question) {
      retrievals[q.id] = hit.retrieval;
      reused.push(q.id);
      continue;
    }
    const retrieval = await retrieve(q.question, { ...settings, rerank: true, rewrite: false, log });
    next.questions[q.id] = { question: q.question, retrievedAt: new Date().toISOString(), retrieval: stripRewrite(retrieval) };
    retrievals[q.id] = next.questions[q.id].retrieval;
    retrieved.push(q.id);
  }
  return { cache: next, retrievals, reused, retrieved };
}

const stripRewrite = ({ rewriteUsage, ...retrieval }) => retrieval;

// ---- one generator ----------------------------------------------------------------

/**
 * One generator over the questions, in order, answering from the shared
 * retrievals. A call that throws (Ollama down, a timeout) is an error row, not
 * a crash and never a Claude answer.
 *
 * @param {object} o
 * @param {{ id: string, label: string, where: "cloud" | "local", provider: import("../llm/provider.js").LlmProvider }} o.generator
 * @param {object[]} o.questions
 * @param {Record<string, object>} o.retrievals
 * @param {object} o.settings
 * @param {typeof answerQuestion} [o.answer]
 * @param {() => number} [o.nextOrder] - the global run order
 * @param {(row: object) => void} [o.onRow]
 */
export async function runGenerator({ generator, questions, retrievals, settings, answer = answerQuestion, nextOrder = counter(), onRow = () => {} }) {
  const rows = [];
  for (const q of questions) {
    const retrieval = retrievals[q.id];
    if (!retrieval) throw new Error(`no shared retrieval for ${q.id}`);
    const order = nextOrder();
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let run;
    let error = null;
    try {
      run = await answer(q.question, { ...settings, mode: "rag", rerank: true, rewrite: false, provider: generator.provider, retrieval, log: () => {} });
    } catch (err) {
      error = String(err?.message ?? err).split("\n")[0];
      run = errorRun(retrieval, error);
    }
    const row = {
      id: q.id,
      type: q.type,
      question: q.question,
      expect_decline: q.expect_decline,
      expected_facts: q.expected_facts,
      generator: generator.id,
      order,
      startedAt,
      wallMs: Date.now() - t0,
      error,
      run: slimRun(run),
      faithfulness: null,
      grade: null,
    };
    row.checks = checksOf(row);
    // A failed call answered nothing and declined nothing: every check that applies fails.
    if (error) row.checks = { ...row.checks, sources: false, citations: false, idk: false };
    rows.push(row);
    onRow(row);
  }
  return rows;
}

export function counter(start = 1) {
  let n = start;
  return () => n++;
}

/** A failed call, shaped like a run so the summary counts it (as a non-answer) without special cases. */
function errorRun(retrieval, error) {
  return {
    answer: "",
    status: "error",
    citations: [],
    sources: [],
    clarifyingQuestion: "",
    dontKnow: { reason: "error" },
    verification: null,
    chunks: retrieval.chunks,
    timings: { ...retrieval.timings, clarifyMs: 0, llmMs: 0 },
    usage: { inputTokens: 0, outputTokens: 0 },
    generation: null,
    error,
  };
}

/** The chunks and candidates are the shared retrieval's: kept once, in the cache, not per generator. */
function slimRun({ candidates, chunks, rejected, usageByStage, ...run }) {
  return { ...run, chunkIds: (chunks ?? []).map((c) => c.chunk_id) };
}

// ---- the summary ----------------------------------------------------------------------

const mean = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const max = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
  return v.length ? Math.max(...v) : null;
};
/** The generator's own time for a question: the answer call(s) with the retry, or the clarifying call. */
export const answerLatencyMs = (run) => (run.timings?.llmMs ?? 0) + (run.timings?.clarifyMs ?? 0);

/**
 * @param {object[]} rows - one generator's
 * @param {{ loadMs?: number | null, memory?: object | null }} [extra] - local only
 */
export function summarizeGenerator(rows, extra = {}) {
  const quality = summarizeCitations(rows.map((r) => ({ ...r, run: r.run.status === "error" ? { ...r.run, status: "dont_know" } : r.run })));
  const gens = rows.map((r) => r.run.generation).filter(Boolean);
  const firstCalls = gens.map((g) => g.calls?.[0]?.metrics).filter(Boolean);
  const metrics = gens.map((g) => g.metrics).filter(Boolean);
  const byOrder = [...rows].sort((a, b) => a.order - b.order);
  const half = Math.ceil(byOrder.length / 2);
  const halves = [byOrder.slice(0, half), byOrder.slice(half)].map((part) => ({
    questions: part.map((r) => r.id),
    meanGenTps: mean(part.map((r) => r.run.generation?.metrics?.genTps)),
    meanTtftMs: mean(part.map((r) => r.run.generation?.calls?.[0]?.metrics?.ttftMs)),
    meanLatencyMs: mean(part.map((r) => answerLatencyMs(r.run))),
  }));
  return {
    ...quality,
    errors: rows.filter((r) => r.error).map((r) => ({ id: r.id, error: r.error })),
    invalidJson: gens.reduce((n, g) => n + (g.invalidJson ?? 0), 0),
    schemaFailures: gens.reduce((n, g) => n + (g.schemaFailures ?? 0), 0),
    structuredCalls: gens.reduce((n, g) => n + g.calls.filter((c) => c.structured).length, 0),
    possibleTruncations: rows.filter((r) => r.run.possible_truncation).map((r) => r.id),
    meanTtftMs: mean(firstCalls.map((m) => m.ttftMs)),
    meanGenTps: mean(metrics.map((m) => m.genTps)),
    meanAnswerLatencyMs: mean(rows.map((r) => answerLatencyMs(r.run))),
    maxAnswerLatencyMs: max(rows.map((r) => answerLatencyMs(r.run))),
    meanPromptTokens: mean(rows.map((r) => r.run.usage?.inputTokens)),
    meanOutputTokens: mean(rows.map((r) => r.run.usage?.outputTokens)),
    meanPromptEvalMs: mean(metrics.map((m) => m.promptEvalMs)),
    meanEvalMs: mean(metrics.map((m) => m.evalMs)),
    loadMs: extra.loadMs ?? null,
    memory: extra.memory ?? null,
    halves,
  };
}

/** Shared retrieval cost, once for all generators. */
export function retrievalSummary(retrievals, ids) {
  const list = ids.map((id) => retrievals[id]).filter(Boolean);
  return {
    questions: list.length,
    meanRetrieveMs: mean(list.map((r) => r.timings.retrieveMs)),
    meanRerankMs: mean(list.map((r) => r.timings.rerankMs)),
    maxRerankMs: max(list.map((r) => r.timings.rerankMs)),
    meanChunks: mean(list.map((r) => r.chunks.length)),
    declined: ids.filter((id) => retrievals[id]?.declined),
  };
}

// ---- the report --------------------------------------------------------------------

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}% (${a}/${b})` : "—");
const num = (x, d = 2) => (x == null ? "—" : x.toFixed(d));
const sec = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`);
const gb = (bytes) => (bytes == null ? "—" : `${(bytes / 2 ** 30).toFixed(1)} GB`);
const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const shortSource = (source) => String(source ?? "").replace(/^knowledge_database\//, "").replace(/\.html?$/, "");
const blockquote = (text) => String(text ?? "").split("\n").map((line) => `> ${line}`).join("\n");
const ids = (xs) => (xs.length ? `${xs.length}: ${xs.join(", ")}` : "0");

/**
 * The summary table: one row per measure, one column per generator. Shared by
 * the Markdown report and the page's Local tab.
 *
 * @param {Array<{ id: string, label: string, where: string, summary: object }>} generators
 * @returns {{ head: string[], sections: Array<{ title: string, rows: string[][] }> }}
 */
export function localSummaryRows(generators) {
  const col = (fn) => generators.map((g) => fn(g.summary, g));
  const quality = [
    ["answered with ≥ 1 source / valid citation", ...col((s) => `${s.answeredWithSources}/${s.answered} · ${s.answeredWithCitations}/${s.answered}`)],
    ["answerable questions answered (of 7)", ...col((s) => pct(s.answerableWithSources, s.answerable))],
    ["fabricated quotes on the first attempt", ...col((s) => `${s.fabricatedFirstAttempt} of ${s.firstAttemptCitations}`)],
    ["first attempt valid", ...col((s) => `${s.firstAttemptValid}/${s.contractCalls}`)],
    ["retries · dropped citations · downgrades", ...col((s) => `${s.retries} (${s.retriesFixed} fixed) · ${s.droppedCitations} · ${s.downgrades}`)],
    ["invalid JSON / schema failures", ...col((s, g) => (g.where === "local" ? `${s.invalidJson} of ${s.structuredCalls} calls · ${s.schemaFailures}` : "n/a (tool use)"))],
    ["faithfulness (supported / partial / unsupported)", ...col((s) => `${num(s.meanFaithfulness)} · ${s.claimVerdicts.supported} / ${s.claimVerdicts.partial} / ${s.claimVerdicts.unsupported}`)],
    ["uncited claims", ...col((s) => String(s.uncitedClaims))],
    ["correct \"I don't know\" · false \"I don't know\"", ...col((s) => `${s.correctIdk}/${s.toDecline} · ${s.falseIdk.length ? s.falseIdk.map((x) => `${x.id} (${x.reason})`).join(", ") : "0"}`)],
    ["mean fact score (7 answerable)", ...col((s) => num(s.meanFactScore))],
    ["errors", ...col((s) => ids(s.errors.map((e) => e.id)))],
  ];
  const speed = [
    ["time to first token (≈ prompt processing)", ...col((s) => sec(s.meanTtftMs))],
    ["generation tokens/s", ...col((s) => num(s.meanGenTps, 1))],
    ["answer latency incl. retry: mean · max", ...col((s) => `${sec(s.meanAnswerLatencyMs)} · ${sec(s.maxAnswerLatencyMs)}`)],
    ["prompt tokens · output tokens (mean per question)", ...col((s) => `${num(s.meanPromptTokens, 0)} · ${num(s.meanOutputTokens, 0)}`)],
    ["model load time", ...col((s, g) => (g.where === "local" ? sec(s.loadMs) : "n/a (cloud)"))],
    ["possible truncations", ...col((s) => ids(s.possibleTruncations))],
    ["memory in use (/api/ps: total · in GPU)", ...col((s, g) => (g.where === "local" ? `${gb(s.memory?.size)} · ${gb(s.memory?.sizeVram)}${s.memory?.contextLength ? ` · ctx ${s.memory.contextLength}` : ""}` : "n/a (cloud)"))],
    ["first half → second half: tok/s · latency", ...col((s) => `${num(s.halves[0].meanGenTps, 1)} → ${num(s.halves[1]?.meanGenTps, 1)} · ${sec(s.halves[0].meanLatencyMs)} → ${sec(s.halves[1]?.meanLatencyMs)}`)],
  ];
  return { head: generators.map((g) => `${g.label} (${g.where})`), sections: [{ title: "quality", rows: quality }, { title: "speed", rows: speed }] };
}

/** `local_rag_report.md`. */
export function renderLocalReport({ generatedAt, settings, environment, retrieval, generators, questions, retrievals, notes, quick }) {
  const table = localSummaryRows(generators);
  const out = [
    `# Local RAG eval${quick ? " (quick)" : ""}: ${questions.length} questions, \`${LOCAL_EVAL_MODE}\`, Claude vs local`,
    "",
    `Generated ${generatedAt} by \`npm run eval:local${quick ? " -- --quick" : ""}\` on ${environment.machine}. Raw results: [\`${quick ? "local_rag_quick_results.json" : "local_rag_results.json"}\`](${quick ? "local_rag_quick_results.json" : "local_rag_results.json"}).`,
    "",
    "**Where each call ran**",
    "",
    "| stage | where | what |",
    "| --- | --- | --- |",
    `| retrieval | local | EmbeddingGemma vectors (doc_index), k_retrieve ${settings.kRetrieve}, strategy ${settings.strategy} — once per question, cached in [\`local_rag_retrieval.json\`](local_rag_retrieval.json) |`,
    `| rerank | local | bge-reranker-v2-m3, cutoff ${settings.rerankThreshold}, top ${settings.kFinal} kept — the same cached run |`,
    ...generators.map((g) => `| generation | ${g.where} | \`${g.model}\`${g.where === "local" ? ` under Ollama ${environment.ollamaVersion ?? ""}, num_ctx ${settings.localRagNumCtx}, num_predict ≤ ${settings.localRagNumPredict}, JSON-schema output` : ", forced tool use, streamed (for TTFT)"} — \`submit_answer\` / \`submit_clarification\`, temperature 0 |`),
    `| judging | cloud | \`${settings.judgeModel}\`: faithfulness (claims + the quotes they cite) and Day 22's fact judge |`,
    "",
    `Every generator answers from the same chunks, through the same contract (markers, chunk_ids, verbatim quotes of 4–60 words, one retry with the errors, then drop or downgrade). Run order: ${generators.map((g) => g.label).join(" → ")}, one model in memory at a time (each local model unloaded before the next loads).`,
    "",
    "## Summary",
    "",
    `Shared retrieval cost (local, once): vector search ${sec(retrieval.meanRetrieveMs)} mean · rerank ${sec(retrieval.meanRerankMs)} mean (max ${sec(retrieval.maxRerankMs)}) · ${num(retrieval.meanChunks, 1)} chunks kept on average · declined by the cutoff before any model call: ${ids(retrieval.declined)}.`,
    "",
  ];
  for (const section of table.sections) {
    out.push(`| ${section.title} | ${table.head.join(" | ")} |`, `| --- |${table.head.map(() => " --- |").join("")}`);
    out.push(...section.rows.map(([label, ...values]) => `| ${cell(label)} | ${values.map(cell).join(" | ")} |`), "");
  }
  out.push(
    "TTFT: for a local model, Ollama's load + prompt-evaluation time of the first answer call (non-streaming, so this is its own account of everything before the first token); for Claude, the time to the first streamed token, network included. Latency: the generator's own time for the question — the answer call with its retry, or the clarifying call — without the shared retrieval.",
    "",
    "## Per question",
    "",
    `| id | type | ${generators.map((g) => g.label).join(" | ")} |`,
    `| --- | --- |${generators.map(() => " --- |").join("")}`,
    ...questions.map((q) => {
      const cells = generators.map((g) => {
        const r = g.rows.find((x) => x.id === q.id);
        if (!r) return "—";
        const status = r.error ? "error" : r.run.status === "dont_know" ? `IDK (${r.run.dontKnow?.reason})` : r.run.status;
        const { passed, applied } = checksPassed(r.checks);
        return `${status} · ${passed}/${applied} · ${sec(answerLatencyMs(r.run))}`;
      });
      return `| [${q.id}](#${q.id.toLowerCase()}) | ${q.type} | ${cells.join(" | ")} |`;
    }),
    "",
    `Cells: status · checks passed (${CHECKS.map(([, label]) => label).join(", ")}) · answer latency.`,
    "",
  );
  if (notes?.trim()) out.push("## Findings", "", notes.trim(), "");

  for (const q of questions) {
    const retrieved = retrievals[q.id];
    out.push(`## ${q.id}`, "", `**${q.type}**${q.expect_decline ? " (should be \"I don't know\")" : ""} — ${q.question}`, "");
    if (retrieved) {
      out.push(
        `Shared retrieval: ${sec(retrieved.timings.retrieveMs)} search · ${sec(retrieved.timings.rerankMs)} rerank · ${retrieved.chunks.length} chunk(s)${retrieved.declined ? " — **none above the cutoff: no answer call, one clarifying call**" : ""}`,
        "",
      );
      if (retrieved.chunks.length) out.push(...retrieved.chunks.map((c) => `${c.n}. ${num(c.rerankScore, 3)} · ${cell(shortSource(c.source))}${c.section ? ` › ${cell(c.section)}` : ""} · \`${c.chunk_id}\``), "");
    }
    for (const g of generators) {
      const r = g.rows.find((x) => x.id === q.id);
      if (!r) continue;
      const { run } = r;
      const m = run.generation?.metrics ?? {};
      out.push(`### ${q.id} · ${g.label}`, "");
      if (r.error) {
        out.push(`**Error:** ${cell(r.error)}`, "");
        continue;
      }
      out.push(
        `Status **${run.status}**${run.dontKnow ? ` (${run.dontKnow.reason})` : ""} · ${verificationLabel(run)} · checks ${checksPassed(r.checks).passed}/${checksPassed(r.checks).applied}` +
          ` · run #${r.order} at ${r.startedAt.slice(11, 19)} · TTFT ${sec(run.generation?.calls?.[0]?.metrics?.ttftMs)} · ${num(m.genTps, 1)} tok/s · latency ${sec(answerLatencyMs(run))}` +
          ` · ${run.usage?.inputTokens ?? "?"} prompt / ${run.usage?.outputTokens ?? "?"} output tokens` +
          `${run.generation?.invalidJson ? ` · ${run.generation.invalidJson} invalid JSON` : ""}${run.possible_truncation ? " · ⚠ possible truncation" : ""}`,
        "",
        blockquote(run.answer),
        "",
      );
      if (run.citations.length) out.push(...run.citations.map((c) => `- **[${c.id}]** "${cell(c.quote)}" — ${cell(shortSource(c.source))}${c.section ? ` › ${cell(c.section)}` : ""}`), "");
      const v = run.verification;
      if (v?.firstAttemptErrors.length) out.push("First-attempt errors:", "", ...v.firstAttemptErrors.map((e) => `- ${cell(e)}`), "");
      if (v?.droppedCitations.length) out.push("Dropped citations:", "", ...v.droppedCitations.map((c) => `- [${c.id}] ${c.reason}: "${cell(c.quote)}"`), "");
      const invalid = (run.generation?.calls ?? []).flatMap((c) => c.structured?.errors ?? []);
      if (invalid.length) out.push("Invalid JSON replies:", "", ...invalid.map((e) => `- ${cell(e)}`), "");
      const f = r.faithfulness;
      if (f) {
        out.push(`Faithfulness ${num(f.faithfulness)} (${f.supported} supported, ${f.partial} partial, ${f.unsupported} unsupported)${f.uncitedClaims.length ? ` · uncited: ${f.uncitedClaims.map(cell).join("; ")}` : ""}`, "");
        const weak = f.claims.filter((c) => c.verdict !== "supported");
        if (weak.length) out.push(...weak.map((c) => `- ${c.verdict}: ${cell(c.claim)}${c.note ? ` — ${cell(c.note)}` : ""}`), "");
      }
      if (r.grade) out.push(`Fact score ${num(r.grade.score)}: ${r.grade.facts.map((x) => `${x.grade} — ${cell(x.fact)}`).join("; ")}`, "");
    }
  }

  out.push(
    "## Run order",
    "",
    "| # | started (UTC) | generator | question | answer latency | tok/s | TTFT |",
    "| ---: | --- | --- | --- | ---: | ---: | ---: |",
    ...generators
      .flatMap((g) => g.rows.map((r) => ({ g, r })))
      .sort((a, b) => a.r.order - b.r.order)
      .map(({ g, r }) => `| ${r.order} | ${r.startedAt.slice(11, 19)} | ${g.label} | ${r.id} | ${sec(answerLatencyMs(r.run))} | ${num(r.run.generation?.metrics?.genTps, 1)} | ${sec(r.run.generation?.calls?.[0]?.metrics?.ttftMs)} |`),
    "",
  );
  return out.join("\n");
}
