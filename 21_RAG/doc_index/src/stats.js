import { CHARS_PER_PAGE, MIN_CORPUS_PAGES } from "./config.js";
import { sectionsIn } from "./loaders/document.js";

/**
 * **Numbers about the corpus and about a set of chunks.** Pure functions.
 */

export const pages = (chars) => chars / CHARS_PER_PAGE;

/** Per collection and in total: documents, characters, estimated pages. */
export function corpusStats(documents) {
  const by = {};
  for (const d of documents) {
    by[d.collection] ??= { documents: 0, chars: 0, formats: new Set() };
    by[d.collection].documents++;
    by[d.collection].chars += d.char_count ?? d.text.length;
    by[d.collection].formats.add(d.format);
  }
  const total = Object.values(by).reduce((n, c) => n + c.chars, 0);
  const kbChars = by.knowledge?.chars ?? 0;
  return {
    collections: Object.entries(by).map(([name, c]) => ({ name, documents: c.documents, chars: c.chars, pages: pages(c.chars), formats: [...c.formats] })),
    totalChars: total,
    totalPages: pages(total),
    knowledgeAloneEnough: pages(kbChars) >= MIN_CORPUS_PAGES,
  };
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const SENTENCE_END = /[.!?…:;)"'”’`\]}]$/;

/** A chunk starts cleanly at the start of the text, a line, or after a sentence end. */
export function startsMidSentence(docText, start) {
  if (start === 0) return false;
  const before = docText.slice(0, start).replace(/[ \t]+$/, "");
  if (!before || before.endsWith("\n")) return false;
  return !SENTENCE_END.test(before);
}

/** A chunk ends cleanly at a sentence end, a line end, or the end of the text. */
export function endsMidSentence(docText, end, chunkText) {
  if (end >= docText.trimEnd().length) return false;
  if (/^[ \t]*\n/.test(docText.slice(end))) return false;
  return !SENTENCE_END.test(chunkText.trimEnd());
}

/**
 * @param {object[]} chunks chunk records of one strategy
 * @param {Map<string, { text: string, sections: object[] }>} docs by doc_id
 */
export function chunkStats(chunks, docs) {
  const tokens = chunks.map((c) => c.token_count).sort((a, b) => a - b);
  let mid = 0;
  let spanning = 0;
  for (const c of chunks) {
    const doc = docs.get(c.doc_id);
    if (startsMidSentence(doc.text, c.char_start) || endsMidSentence(doc.text, c.char_end, c.text)) mid++;
    // Only count a section the chunk really has text from, not one it touches by a newline.
    const touched = sectionsIn(doc.sections, c.char_start, c.char_end).filter((s) =>
      doc.text.slice(Math.max(s.start, c.char_start), Math.min(s.end, c.char_end)).trim(),
    );
    if (touched.length > 1) spanning++;
  }
  return {
    chunks: chunks.length,
    tokens: { min: tokens[0] ?? 0, median: percentile(tokens, 50), p90: percentile(tokens, 90), max: tokens.at(-1) ?? 0 },
    totalTokens: tokens.reduce((n, t) => n + t, 0),
    midSentencePct: chunks.length ? (100 * mid) / chunks.length : 0,
    multiSectionPct: chunks.length ? (100 * spanning) / chunks.length : 0,
  };
}
