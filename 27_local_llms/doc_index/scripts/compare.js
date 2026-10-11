import fs from "node:fs";
import path from "node:path";

import { QUESTIONS_PATH, REPORTS_DIR, STRATEGIES, embedSettings } from "../src/config.js";
import { loadEmbedder } from "../src/embed.js";
import { evaluate, metricsFor } from "../src/evaluate.js";
import { createSearcher } from "../src/search.js";
import { chunkStats, corpusStats } from "../src/stats.js";
import { openStore } from "../src/store.js";

/**
 * `npm run compare`: chunk stats + retrieval eval → reports/comparison.md,
 * and the summary table on stdout.
 *
 * Everything in the report is computed here from the index and the questions,
 * except `reports/notes.md` (a hand-written interpretation of a run), which is
 * included as-is when it exists.
 */

const K = 5;
const store = openStore(undefined, { readonly: true });
const docs = store.documentTexts();
const documents = store.documents();
const embedding = store.getMeta("embedding");
const chunker = store.getMeta("chunker");
const embedStats = store.getMeta("embed_stats") ?? {};
const stats = Object.fromEntries(STRATEGIES.map((s) => [s, { ...chunkStats(store.chunks(s), docs), embed: embedStats[s] }]));
const corpus = corpusStats(documents);
store.close();

const questions = JSON.parse(fs.readFileSync(QUESTIONS_PATH, "utf8"));
console.log(`evaluating ${questions.length} questions × ${STRATEGIES.length} strategies…`);
const embedder = await loadEmbedder(embedSettings());
const searcher = createSearcher({ embedder });
const result = await evaluate(questions, searcher.search, { strategies: STRATEGIES, k: K });
searcher.close();

const groupOf = (q) =>
  q.expected_source.startsWith("knowledge_database/") ? "knowledge_database (html)"
  : /^https?:/.test(q.expected_source) ? "PDF"
  : q.expected_source.endsWith(".md") ? "READMEs (markdown)"
  : "code (js)";
const groups = [...new Set(questions.map(groupOf))];

// ---- formatting -------------------------------------------------------------

const pct = (x) => `${(100 * x).toFixed(0)}%`;
const f2 = (x) => x.toFixed(2);
const n = (x) => x.toLocaleString("en-US");
const row = (cells) => `| ${cells.join(" | ")} |`;
const header = (cells, align) => [row(cells), row(align ?? cells.map(() => "---"))].join("\n");
const cols = STRATEGIES;
const short = (s) => (s ? (s.length > 60 ? `${s.slice(0, 57)}…` : s) : "(no heading)");
const shortSource = (s) => s.replace(/^knowledge_database\//, "kb/").replace(/ - The JetBrains Blog\.html?$| _ Medium\.html?$/, "").slice(0, 48);

const summaryRows = [
  ["chunks", ...cols.map((s) => n(stats[s].chunks))],
  ["tokens min / median / p90 / max", ...cols.map((s) => Object.values(stats[s].tokens).join(" / "))],
  ["chunks starting or ending mid-sentence", ...cols.map((s) => pct(stats[s].midSentencePct / 100))],
  ["chunks spanning > 1 section", ...cols.map((s) => pct(stats[s].multiSectionPct / 100))],
  ["total embedded tokens", ...cols.map((s) => n(stats[s].totalTokens))],
  ["embedding time (last full embed)", ...cols.map((s) => (stats[s].embed ? `${(stats[s].embed.ms / 1000).toFixed(0)} s for ${n(stats[s].embed.chunks)} chunks` : "—"))],
  [`hit@1`, ...cols.map((s) => pct(result.metrics[s].hit1))],
  [`hit@3`, ...cols.map((s) => pct(result.metrics[s].hit3))],
  [`hit@5`, ...cols.map((s) => pct(result.metrics[s].hit5))],
  [`MRR@${K}`, ...cols.map((s) => f2(result.metrics[s].mrr))],
];
const summaryTable = [header(["", ...cols], ["---", ...cols.map(() => "---:")]), ...summaryRows.map(row)].join("\n");

const rankCell = (r) => (r === null ? "—" : String(r));
const winner = (q) => {
  const [a, b] = cols.map((s) => q.results[s].rank ?? Infinity);
  if (a === b) return a === Infinity ? "neither" : "tie";
  return a < b ? cols[0] : cols[1];
};
const perQuestionTable = [
  header(["id", "source", ...cols.map((s) => `${s} rank`), "better", ...cols.map((s) => `${s} top-1 section`)]),
  ...result.perQuestion.map((q) =>
    row([q.id, shortSource(q.expected_source), ...cols.map((s) => rankCell(q.results[s].rank)), winner(q), ...cols.map((s) => {
      const t = q.results[s].top1;
      return t ? `${shortSource(t.source)} › ${short(t.section)}` : "—";
    })]),
  ),
].join("\n");

const groupTable = [
  header(["questions from", "n", ...cols.map((s) => `${s} hit@1 / hit@5 / MRR`)]),
  ...groups.map((g) => {
    const qs = result.perQuestion.filter((q) => groupOf(q) === g);
    return row([g, qs.length, ...cols.map((s) => {
      const m = metricsFor(qs.map((q) => q.results[s].rank));
      return `${pct(m.hit1)} / ${pct(m.hit5)} / ${f2(m.mrr)}`;
    })]);
  }),
].join("\n");

// ---- findings computed from the numbers ---------------------------------------

const differ = result.perQuestion.filter((q) => (q.results[cols[0]].rank ?? 99) !== (q.results[cols[1]].rank ?? 99));
const wins = Object.fromEntries(cols.map((s) => [s, differ.filter((q) => winner(q) === s)]));
const missedByBoth = result.perQuestion.filter((q) => winner(q) === "neither");
const metricLine = (key, label) => {
  const [a, b] = cols.map((s) => result.metrics[s][key]);
  if (Math.abs(a - b) < 1e-9) return `- ${label}: tie (${key === "mrr" ? f2(a) : pct(a)}).`;
  const [w, l] = a > b ? [cols[0], cols[1]] : [cols[1], cols[0]];
  const fmt = key === "mrr" ? f2 : pct;
  return `- ${label}: **${w}** ${fmt(result.metrics[w][key])} vs ${l} ${fmt(result.metrics[l][key])}.`;
};
const exampleLine = (q) => {
  const parts = cols.map((s) => {
    const r = q.results[s];
    const where = r.hit ? `rank ${r.rank}, a ${r.hit.token_count}-token chunk in "${short(r.hit.section)}"` : `missed (top-1: ${shortSource(r.top1.source)} › "${short(r.top1.section)}")`;
    return `${s}: ${where}`;
  });
  return `- \`${q.id}\` — "${q.question}" ${parts.join("; ")}.`;
};

const findings = [
  metricLine("hit1", "hit@1"),
  metricLine("hit3", "hit@3"),
  metricLine("hit5", "hit@5"),
  metricLine("mrr", `MRR@${K}`),
  "",
  `The strategies rank the expected chunk differently on ${differ.length} of ${questions.length} questions: ` +
    cols.map((s) => `${s} is better on ${wins[s].length}`).join(", ") +
    (missedByBoth.length ? `; ${missedByBoth.length} missed by both (${missedByBoth.map((q) => `\`${q.id}\``).join(", ")})` : "") + ".",
  "",
  ...differ.map(exampleLine),
].join("\n");

const notesPath = path.join(REPORTS_DIR, "notes.md");
const notes = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, "utf8").trim() : null;

const report = `# Chunking comparison: fixed vs structural

Generated by \`npm run compare\` on ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.

- Embeddings: \`${embedding.modelId}\`, ${embedding.dtype}, ${embedding.dims} dims. Embedded string for both strategies: \`${embedding.prefixes.document}\`; queries: \`${embedding.prefixes.query}\`. The section breadcrumb is not embedded.
- Chunkers: fixed ${JSON.stringify(chunker.fixed)}, structural ${JSON.stringify(chunker.structural)} (tokens counted with the EmbeddingGemma tokenizer).
- Corpus: ${documents.length} documents, ${n(corpus.totalChars)} characters ≈ ${corpus.totalPages.toFixed(0)} pages (${corpus.collections.map((c) => `${c.name} ${c.pages.toFixed(1)}`).join(", ")}).${corpus.knowledgeAloneEnough ? " knowledge_database/ alone reaches 30 pages." : ""}
- Eval: ${questions.length} questions in \`eval/questions.json\`; a hit is a chunk from \`expected_source\` containing \`expected_text\` (case and whitespace ignored), searched with k = ${K}.

## Summary

${summaryTable}

"Mid-sentence": the chunk's start is not at the start of a line or after sentence-ending punctuation, or its end is not followed by a line break and does not end in such punctuation. "Spanning > 1 section": the chunk holds text from more than one loader section (heading section, code declaration, PDF section). Embedding time is from the last \`npm run index\` that embedded every chunk of the strategy (CPU, ${embedding.dtype}); a re-run with nothing changed embeds nothing.

## Retrieval by source type

${groupTable}

## Per question

${perQuestionTable}

## Findings (computed)

${findings}
${notes ? `\n## Analysis\n\n${notes}\n` : ""}`;

fs.mkdirSync(REPORTS_DIR, { recursive: true });
fs.writeFileSync(path.join(REPORTS_DIR, "comparison.md"), report);
console.log(`\n${summaryTable}\n\nwrote reports/comparison.md`);
