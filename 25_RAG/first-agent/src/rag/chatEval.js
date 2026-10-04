import fs from "node:fs";
import path from "node:path";

import { claimsOf } from "./contract.js";
import { PROJECT_DIR } from "./config.js";
import { blind } from "./judge.js";
import { INTENTS } from "./router.js";

/**
 * **The pure half of `eval:chat` (Day 25)**: the scenario schema, the check
 * that the two scenarios hold every required element, the per-turn checks, the
 * summary, and the Markdown report. `scripts/eval-chat.js` does the calls and I/O.
 *
 * A scenario is `{ id, title, kind, description, messages: [...] }`, each
 * message:
 *
 * ```json
 * { "turn": 4, "user": "…", "expected_intent": "search",
 *   "expect": { "decline": false, "sources": ["…"], "facts": ["…"] },
 *   "memory_checkpoint": ["…"], "constraint_check": { "max_sentences": 3 },
 *   "tags": ["reference"], "refers_to": 1, "notes": "what this turn tests" }
 * ```
 *
 * `tags` name the required elements a turn carries, so their presence is
 * checked mechanically rather than by reading the notes.
 */

export const CHAT_SCENARIOS_DIR = path.join(PROJECT_DIR, "eval", "chat");
export const SCENARIO_IDS = ["scenario-1", "scenario-2"];
export const SCENARIO_KINDS = ["deep_dive", "comparison"];
export const MIN_MESSAGES = 12;
export const MAX_MESSAGES = 15;
export const TAGS = ["goal", "constraint", "term", "reference", "vague", "clarification", "correction", "chat", "off_topic", "return", "change_direction", "late_reference"];
/** Day 22's pass mark for a fact score. */
export const FACT_PASS = 0.75;

export const CHECKS = [
  ["intent", "intent"],
  ["sources", "sources + citations"],
  ["expectedSource", "expected source"],
  ["constraint", "constraint"],
  ["memory", "memory"],
  ["onTrack", "on track"],
  ["facts", "facts"],
];

export function loadScenarios(ids = SCENARIO_IDS, dir = CHAT_SCENARIOS_DIR) {
  return ids.map((id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8")));
}

const isStrings = (x) => Array.isArray(x) && x.every((s) => typeof s === "string" && s.trim());

/** Shape errors for one scenario; empty when valid. */
export function validateScenario(s) {
  const errors = [];
  const at = (i, msg) => errors.push(`${s?.id ?? "?"} turn ${i + 1}: ${msg}`);
  if (!s || typeof s !== "object") return ["scenario is not an object"];
  if (typeof s.id !== "string" || !s.id) errors.push("id is required");
  if (!SCENARIO_KINDS.includes(s.kind)) errors.push(`${s.id}: kind must be one of ${SCENARIO_KINDS.join(", ")}`);
  if (typeof s.title !== "string" || !s.title.trim()) errors.push(`${s.id}: title is required`);
  if (!Array.isArray(s.messages)) return [...errors, `${s.id}: messages must be an array`];
  if (s.messages.length < MIN_MESSAGES || s.messages.length > MAX_MESSAGES) errors.push(`${s.id}: ${s.messages.length} messages; must be ${MIN_MESSAGES}–${MAX_MESSAGES}`);
  s.messages.forEach((m, i) => {
    if (m.turn !== i + 1) at(i, `turn must be ${i + 1}, got ${m.turn}`);
    if (typeof m.user !== "string" || !m.user.trim()) at(i, "user must be a non-empty string");
    if (!INTENTS.includes(m.expected_intent)) at(i, `expected_intent must be one of ${INTENTS.join(", ")}`);
    if (!m.expect || typeof m.expect !== "object") return at(i, "expect is required");
    if (typeof m.expect.decline !== "boolean") at(i, "expect.decline must be true or false");
    if (m.expect.sources !== undefined && !isStrings(m.expect.sources)) at(i, "expect.sources must be a list of strings");
    if ((m.expect.sources ?? []).some((src) => !/^knowledge_database\/.+\.html?$/.test(src))) at(i, "expect.sources must be knowledge_database/… source values");
    if (m.expect.facts !== undefined && !isStrings(m.expect.facts)) at(i, "expect.facts must be a list of strings");
    if (m.expected_intent !== "search" && (m.expect.decline || m.expect.sources?.length || m.expect.facts?.length)) at(i, "only a search turn can expect a decline, sources or facts");
    if (m.expect.decline && (m.expect.sources?.length || m.expect.facts?.length)) at(i, "a turn expected to decline has no sources or facts");
    if (m.memory_checkpoint !== undefined && !isStrings(m.memory_checkpoint)) at(i, "memory_checkpoint must be a list of strings");
    if (m.constraint_check !== undefined) {
      const c = m.constraint_check;
      const keys = Object.keys(c ?? {});
      if (!keys.length || keys.some((k) => !["max_sentences", "max_words"].includes(k) || !Number.isInteger(c[k]) || c[k] < 1)) at(i, "constraint_check takes max_sentences and/or max_words, positive integers");
    }
    if (m.tags !== undefined && (!Array.isArray(m.tags) || m.tags.some((t) => !TAGS.includes(t)))) at(i, `tags must be from ${TAGS.join(", ")}`);
    if (m.refers_to !== undefined && !(Number.isInteger(m.refers_to) && m.refers_to >= 1 && m.refers_to < m.turn)) at(i, "refers_to must be an earlier turn");
    if (typeof m.notes !== "string" || !m.notes.trim()) at(i, "notes are required");
  });
  return errors;
}

/**
 * Between them, the scenarios hold every element the spec asks for. Returns
 * the missing ones; empty when all are there.
 *
 * @param {object[]} scenarios
 * @param {{ historyTurns?: number }} [o] - the late reference must be outside this window
 */
export function missingElements(scenarios, { historyTurns = 6 } = {}) {
  const missing = [];
  const all = scenarios.flatMap((s) => s.messages.map((m, i) => ({ s, m, i })));
  const tagged = (tag) => all.filter(({ m }) => m.tags?.includes(tag));
  const need = (ok, what) => ok || missing.push(what);

  for (const kind of SCENARIO_KINDS) need(scenarios.some((s) => s.kind === kind), `a ${kind} scenario`);
  need(tagged("goal").some(({ m }) => m.turn <= 2 && m.memory_checkpoint?.length), "the goal stated in message 1 or 2, with a memory checkpoint");
  need(
    tagged("constraint").some(({ s, m }) => m.memory_checkpoint?.length && s.messages.some((later) => later.turn > m.turn && later.constraint_check)),
    "a constraint with a memory checkpoint, checked mechanically (constraint_check) on a later turn",
  );
  need(tagged("term").some(({ m }) => m.memory_checkpoint?.length), "a defined term with a memory checkpoint");
  need(tagged("reference").length >= 2 && tagged("reference").every(({ m }) => m.expected_intent === "search"), "at least two reference follow-ups, routed to search");
  need(
    tagged("vague").some(({ s, m, i }) => {
      const next = s.messages[i + 1];
      return m.expected_intent === "search" && m.expect.decline && next?.tags?.includes("clarification") && next.expected_intent === "search" && !next.expect.decline;
    }),
    "a vague question expected to decline, followed by a clarification that should succeed",
  );
  need(tagged("correction").some(({ m }) => m.memory_checkpoint?.length), "a correction with a memory checkpoint");
  need(tagged("chat").some(({ m }) => m.expected_intent === "chat"), "a chat-only message");
  need(
    tagged("off_topic").some(({ s, m }) => m.expect.decline && s.messages.some((later) => later.turn > m.turn && later.tags?.includes("return"))),
    "an off-topic detour expected to decline, followed later by a return to the topic",
  );
  need(
    scenarios.some((s) => s.id === "scenario-2" && s.messages.some((m) => m.tags?.includes("change_direction") && m.memory_checkpoint?.length)),
    "a change of direction in scenario 2, with a memory checkpoint",
  );
  // Message `refers_to` is user message 2·(r−1) of the chat; turn t sees the last `historyTurns` of its 2·(t−1) earlier messages.
  need(
    tagged("late_reference").some(({ m }) => m.turn >= 10 && m.refers_to <= 3 && 2 * (m.refers_to - 1) < 2 * (m.turn - 1) - historyTurns),
    "a late question (message 10+) that needs something from messages 1–3, outside the history window",
  );
  return missing;
}

// ---- per-turn checks ------------------------------------------------------------

/** Sentences as the constraint check counts them: Day 24's claims (each sentence, list item or line with letters), markers stripped. */
export const sentenceCount = (text) => claimsOf(text).length;
export const wordCountOf = (text) => blind(text).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** The constraint check: null when none is defined or the turn declined (an "I don't know" has its own fixed shape). */
export function constraintCheck(message, row) {
  const c = message.constraint_check;
  if (!c || row.run?.status === "dont_know") return null;
  const sentences = sentenceCount(row.reply);
  const words = wordCountOf(row.reply);
  const ok = (c.max_sentences == null || sentences <= c.max_sentences) && (c.max_words == null || words <= c.max_words);
  return { ok, sentences, words, ...c };
}

/**
 * Each check is true, false or null (does not apply).
 *
 * @param {object} message - the scenario entry
 * @param {object} row - `{ route, run, reply, memoryCheck, onTrack, faithfulness, grade }` for this turn
 */
export function turnChecks(message, row) {
  const { route, run } = row;
  const expectSearch = message.expected_intent === "search";
  const searched = route?.intent === "search";
  const answered = run?.status === "answered";
  const declined = run?.status === "dont_know";
  const sources = expectSearch || searched
    ? message.expect.decline
      ? Boolean(declined && run.clarifyingQuestion)
      : Boolean(searched && answered && run.sources?.length && run.citations?.length)
    : null;
  let expectedSource = null;
  if (message.expect.sources?.length) {
    const kept = new Set((run?.chunks ?? []).map((c) => c.source));
    const cited = new Set((run?.sources ?? []).map((s) => s.source));
    expectedSource = message.expect.sources.every((src) => kept.has(src) && cited.has(src));
  }
  const constraint = constraintCheck(message, row);
  // On track: the judge, and no claim the Day 24 faithfulness judge found unsupported by its quote ("partial" is reported, not failed).
  const faithfulOk = !row.faithfulness || row.faithfulness.unsupported === 0;
  return {
    intent: route?.intent === message.expected_intent,
    sources,
    expectedSource,
    constraint: constraint ? constraint.ok : null,
    memory: message.memory_checkpoint?.length ? Boolean(row.memoryCheck?.passed) : null,
    onTrack: row.onTrack ? row.onTrack.onTrack && faithfulOk : null,
    facts: message.expect.facts?.length ? Boolean(row.grade && row.grade.score >= FACT_PASS && !row.grade.hallucination) : null,
  };
}

/** Why each failing check failed, in a few words. */
export function failureReasons(message, row) {
  const c = row.checks;
  const out = [];
  if (c.intent === false) out.push(`intent: expected ${message.expected_intent}, routed ${row.route?.intent}${row.route?.override ? ` (${row.route.override})` : ""}`);
  if (c.sources === false) {
    out.push(
      message.expect.decline
        ? `expected "I don't know", got ${row.run?.status ?? row.route?.intent}`
        : row.run?.status === "dont_know"
          ? `false "I don't know" (${row.run.dontKnow?.reason})`
          : `no source / citation (${row.route?.intent})`,
    );
  }
  if (c.expectedSource === false) {
    const kept = new Set((row.run?.chunks ?? []).map((x) => x.source));
    const cited = new Set((row.run?.sources ?? []).map((x) => x.source));
    for (const src of message.expect.sources) {
      if (!kept.has(src)) out.push(`expected source not retrieved: ${shortSource(src)}`);
      else if (!cited.has(src)) out.push(`expected source retrieved but not cited: ${shortSource(src)}`);
    }
  }
  if (c.constraint === false) {
    const k = row.constraint;
    out.push(`constraint: ${k.max_sentences != null ? `${k.sentences} sentences > ${k.max_sentences}` : ""}${k.max_words != null ? ` ${k.words} words (max ${k.max_words})` : ""}`.trim());
  }
  if (c.memory === false) {
    const missed = (row.memoryCheck?.statements ?? []).filter((s) => !s.reflected).map((s) => `"${s.statement}"`);
    const stale = (row.memoryCheck?.stale ?? []).map((s) => `${s.id} (${s.why})`);
    out.push(`memory: ${[missed.length ? `missing ${missed.join(", ")}` : "", stale.length ? `stale ${stale.join(", ")}` : ""].filter(Boolean).join("; ")}`);
  }
  if (c.onTrack === false) {
    const parts = [];
    if (row.onTrack && !row.onTrack.onTrack) parts.push(`judge: ${row.onTrack.note || "off track"}`);
    const f = row.faithfulness;
    if (f?.unsupported) parts.push(`${f.unsupported} claim${f.unsupported === 1 ? "" : "s"} unsupported by its quote (faithfulness ${f.faithfulness.toFixed(2)})`);
    out.push(`on track: ${parts.join("; ")}`);
  }
  if (c.facts === false) out.push(`facts: score ${row.grade?.score?.toFixed(2) ?? "—"}${row.grade?.hallucination ? " · hallucination" : ""}`);
  return out;
}

// ---- summary --------------------------------------------------------------------

const mean = (xs) => {
  const vals = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};
const tally = (rows, key) => {
  const applied = rows.map((r) => r.checks[key]).filter((x) => x !== null);
  return { passed: applied.filter(Boolean).length, applied: applied.length };
};

/** @param {Array<{ message: object, route: object, run: object | null, checks: object, ... }>} rows */
export function summarizeScenario(rows) {
  const searchExpected = rows.filter((r) => r.message.expected_intent === "search");
  const toAnswer = searchExpected.filter((r) => !r.message.expect.decline);
  const toDecline = searchExpected.filter((r) => r.message.expect.decline);
  const runs = rows.filter((r) => r.run);
  const fabricated = runs.flatMap((r) => (r.run.verification?.fabricatedFirstAttempt ?? []).map((f) => ({ turn: r.message.turn, ...f })));
  const misrouted = rows.filter((r) => r.route?.intent !== r.message.expected_intent).map((r) => ({ turn: r.message.turn, expected: r.message.expected_intent, actual: r.route?.intent, override: r.route?.override ?? null }));
  return {
    turns: rows.length,
    turnsPassed: rows.filter((r) => Object.values(r.checks).every((x) => x !== false)).length,
    intent: { correct: rows.length - misrouted.length, total: rows.length },
    misrouted,
    overrides: rows.filter((r) => r.route?.override).map((r) => ({ turn: r.message.turn, override: r.route.override })),
    searchTurns: toAnswer.length,
    answeredWithSources: toAnswer.filter((r) => r.checks.sources).length,
    fabricatedFirstAttempt: fabricated.length,
    firstAttemptCitations: runs.reduce((a, r) => a + (r.run.verification?.firstAttemptCitations ?? 0), 0),
    fabricated,
    correctDeclines: toDecline.filter((r) => r.checks.sources).length,
    toDecline: toDecline.length,
    falseDeclines: toAnswer.filter((r) => r.run?.status === "dont_know").map((r) => ({ turn: r.message.turn, reason: r.run.dontKnow?.reason })),
    constraint: tally(rows, "constraint"),
    memory: tally(rows, "memory"),
    onTrack: tally(rows, "onTrack"),
    expectedSource: tally(rows, "expectedSource"),
    facts: tally(rows, "facts"),
    meanFactScore: mean(rows.map((r) => (r.message.expect.facts?.length ? r.grade?.score : null))),
    meanFaithfulness: mean(rows.map((r) => r.faithfulness?.faithfulness)),
    retries: runs.filter((r) => r.run.verification?.retried).length,
    openQuestionsAdded: rows.filter((r) => r.route?.openQuestionAdded).map((r) => r.message.turn),
    meanRouterMs: mean(rows.map((r) => r.route?.routerMs)),
    meanAnswerMs: mean(searchExpected.map((r) => r.route?.answerMs || null)),
    meanTurnMs: mean(rows.map((r) => r.ms)),
    inputTokens: rows.reduce((a, r) => a + (r.tokens?.input ?? 0), 0),
    outputTokens: rows.reduce((a, r) => a + (r.tokens?.output ?? 0), 0),
    costUsd: rows.reduce((a, r) => a + (r.cost ?? 0), 0),
    checks: Object.fromEntries(CHECKS.map(([key]) => [key, tally(rows, key)])),
  };
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}% (${a}/${b})` : "—");
const frac = (t) => (t.applied ? `${t.passed}/${t.applied}` : "—");
const num = (x, d = 2) => (x == null ? "—" : x.toFixed(d));
const secs = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)} s`);
export const shortSource = (source) => String(source ?? "").replace(/^knowledge_database\//, "").replace(/\.html?$/, "");

/** The summary table's rows: [label, value]. Shared by the Markdown report and the page. */
export function chatSummaryRows(s) {
  return [
    ["turns passing every check", `${s.turnsPassed}/${s.turns}`],
    ["intent accuracy", pct(s.intent.correct, s.intent.total) + (s.misrouted.length ? ` · misrouted: ${s.misrouted.map((m) => `t${m.turn} ${m.expected}→${m.actual}`).join(", ")}` : "")],
    ["search turns answered with ≥ 1 source and ≥ 1 verified citation", pct(s.answeredWithSources, s.searchTurns)],
    ["expected source retrieved and cited", frac(s.expectedSource)],
    ["fabricated quotes on the first attempt", `${s.fabricatedFirstAttempt} of ${s.firstAttemptCitations} quotes (${s.retries} retr${s.retries === 1 ? "y" : "ies"})`],
    ["correct \"I don't know\"", `${s.correctDeclines}/${s.toDecline}`],
    ["false \"I don't know\"", s.falseDeclines.length ? `${s.falseDeclines.length}: ${s.falseDeclines.map((f) => `t${f.turn} (${f.reason})`).join(", ")}` : "0"],
    ["constraint compliance (mechanical)", frac(s.constraint)],
    ["memory checkpoints passed", frac(s.memory)],
    ["on track (judge, and no unsupported claim)", frac(s.onTrack)],
    ["facts (Day 22 score ≥ 0.75) · mean score", `${frac(s.facts)} · ${num(s.meanFactScore)}`],
    ["mean faithfulness (Day 24 judge)", num(s.meanFaithfulness)],
    ["code overrides of the router", s.overrides.length ? s.overrides.map((o) => `t${o.turn}: ${o.override}`).join("; ") : "none"],
    ["mean latency per turn: router · answer (search turns) · whole turn", `${secs(s.meanRouterMs)} · ${secs(s.meanAnswerMs)} · ${secs(s.meanTurnMs)}`],
    ["tokens in / out · cost", `${s.inputTokens} / ${s.outputTokens} · $${s.costUsd.toFixed(3)}`],
  ];
}

const mark = (x) => (x === null ? "—" : x ? "✓" : "✗");
const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const blockquote = (text) => String(text ?? "").split("\n").map((line) => `> ${line}`).join("\n");

/** One memory, compact: goal; clarified; constraints; open questions. */
export function memoryLine(m) {
  if (!m) return "—";
  const items = (list) => list.map((x) => `[${x.id}] ${x.text}`).join("; ");
  return [
    `goal: ${m.goal ?? "—"}`,
    m.clarified.length ? `clarified: ${items(m.clarified)}` : null,
    m.constraints.length ? `constraints: ${items(m.constraints)}` : null,
    m.open_questions.length ? `open: ${items(m.open_questions)}` : null,
  ].filter(Boolean).join(" · ");
}

/** "+k2 'answers ≤ 3 sentences'", "−d1 '…'", "goal → '…'". */
export function diffLine(route) {
  if (!route) return "—";
  const after = route.memoryAfter;
  const find = (id) => [...after.clarified, ...after.constraints, ...after.open_questions].find((x) => x.id === id);
  const parts = [];
  if (route.diff.goalChanged) parts.push(`goal → "${after.goal ?? "—"}"`);
  for (const id of route.diff.added) parts.push(`+${id} "${find(id)?.text ?? ""}"`);
  for (const r of route.diff.removed) parts.push(`−${r.id} "${r.text}"`);
  for (const s of route.skipped ?? []) parts.push(`skipped ${s.op?.op ?? "?"}${s.op?.id ? ` ${s.op.id}` : ""} (${s.reason})`);
  return parts.length ? parts.join(" · ") : "no change";
}

/** `chat_report.md`. */
export function renderChatReport({ generatedAt, settings, scenarios, notes }) {
  const out = [
    "# Chat eval: two scripted conversations",
    "",
    `Generated ${generatedAt} by \`npm run eval:chat\`. Each scenario is replayed through \`POST /chat\` (the route the page uses) on a fresh chat:`,
    `router \`${settings.routerModel}\` (temperature 0, last ${settings.historyTurns} messages), answers \`${settings.model}\` through the Day 24 contract, \`${settings.mode}\`,`,
    `rerank cutoff ${settings.rerankThreshold}, k_final ${settings.kFinal}, k_retrieve ${settings.kRetrieve}. Judges \`${settings.judgeModel}\`: memory checkpoint, on track, Day 24 faithfulness, Day 22 facts.`,
    "Raw results: [`chat_results.json`](chat_results.json).",
    "",
  ];
  out.push("## Summary", "", `| | ${scenarios.map((s) => s.id).join(" | ")} |`, `| --- |${scenarios.map(() => " --- |").join("")}`);
  const rowsBy = scenarios.map((s) => chatSummaryRows(s.summary));
  rowsBy[0].forEach(([label], i) => out.push(`| ${cell(label)} | ${rowsBy.map((r) => cell(r[i][1])).join(" | ")} |`));
  out.push("");
  if (notes?.trim()) out.push("## Findings", "", notes.trim(), "");
  for (const s of scenarios) {
    out.push(`## ${s.id}: ${s.title}`, "", s.description ?? "", "");
    out.push(`| turn | user | intent (exp → got) | ${CHECKS.map(([, l]) => l).join(" | ")} | router · answer |`, `| ---: | --- | --- |${CHECKS.map(() => " :---: |").join("")} --- |`);
    for (const r of s.rows) {
      out.push(
        `| [${r.message.turn}](#${s.id}-t${r.message.turn}) | ${cell(r.message.user.length > 70 ? r.message.user.slice(0, 70) + "…" : r.message.user)} | ${r.message.expected_intent} → ${r.route?.intent ?? "?"} | ${CHECKS.map(([k]) => mark(r.checks[k])).join(" | ")} | ${secs(r.route?.routerMs)} · ${r.route?.answerMs ? secs(r.route.answerMs) : "—"} |`,
      );
    }
    out.push("");
    for (const r of s.rows) {
      const failed = r.reasons.length;
      out.push(`### <a id="${s.id}-t${r.message.turn}"></a>${s.id} · turn ${r.message.turn}${failed ? " ✗" : ""}`, "");
      out.push(`**User:** ${r.message.user}`, "", `*Tests:* ${r.message.notes}`, "");
      const route = r.route;
      out.push(`Intent: expected **${r.message.expected_intent}**, routed **${route?.intent}**${route?.override ? ` (override: ${route.override})` : ""}${route?.routedIntent && route.routedIntent !== route.intent ? ` (router said ${route.routedIntent})` : ""}`);
      if (route?.intent === "search") out.push("", `Standalone: *${cell(route.standaloneQuestion)}* · queries: ${route.queries.map((q) => `\`${cell(q)}\``).join(" · ")}`);
      out.push("", blockquote(r.reply), "");
      if (r.run?.sources?.length) out.push(`Sources: ${r.run.sources.map((x) => `${cell(shortSource(x.source))}${x.section ? ` › ${cell(x.section)}` : ""}`).join("; ")}`, "");
      if (r.run) out.push(`Status: ${r.run.status}${r.run.dontKnow ? ` (${r.run.dontKnow.reason})` : ""}${r.run.verification ? ` · ${r.run.verification.firstAttemptValid ? "verified" : r.run.verification.retried ? "retried" : ""}` : ""}${r.faithfulness?.faithfulness != null ? ` · faithfulness ${num(r.faithfulness.faithfulness)}` : ""}${r.grade ? ` · fact score ${num(r.grade.score)}` : ""}${r.constraint ? ` · ${r.constraint.sentences} sentences, ${r.constraint.words} words` : ""}`, "");
      out.push(`Memory diff: ${cell(diffLine(route))}`, "", `Memory after: ${cell(memoryLine(route?.memoryAfter))}`, "");
      if (r.memoryCheck) out.push(`Checkpoint: ${r.memoryCheck.statements.map((x) => `${x.reflected ? "✓" : "✗"} ${cell(x.statement)}`).join("; ")}${r.memoryCheck.stale.length ? ` · stale: ${r.memoryCheck.stale.map((x) => `${x.id} (${cell(x.why)})`).join(", ")}` : ""}`, "");
      if (r.onTrack) out.push(`On track: ${r.onTrack.onTrack ? "yes" : "no"}${r.onTrack.note ? ` — ${cell(r.onTrack.note)}` : ""}`, "");
      if (failed) out.push(`**Failed:** ${r.reasons.map(cell).join("; ")}`, "");
    }
  }
  return out.join("\n");
}
