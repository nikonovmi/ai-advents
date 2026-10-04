import { breadcrumb, sectionAt } from "../loaders/document.js";

/**
 * **Fixed windows: `size` tokens, `overlap` tokens shared with the next one.**
 *
 * Structure is ignored on purpose; this is the baseline. Boundaries only fall
 * between whitespace-separated words, so no word is ever cut: a window takes as
 * many whole words as fit in `size` tokens (checked with the real token count of
 * the exact slice), and the next window starts at the word where the last
 * ≤ `overlap` tokens of this one begin. Consecutive windows therefore cover the
 * whole text. A single "word" longer than `size` (a URL, a base64 blob) gets a
 * window of its own rather than being cut.
 *
 * `section` is the breadcrumb of the section the window starts in.
 *
 * @param {{ text: string, sections: Array<{ path: string[], start: number, end: number }> }} doc
 * @param {{ count(text: string): number }} tokenizer
 * @param {{ size: number, overlap: number }} options
 * @returns {Array<{ char_start: number, char_end: number, text: string, token_count: number, section: string }>}
 */
export function chunkFixed(doc, tokenizer, { size, overlap }) {
  if (!(overlap < size)) throw new Error(`overlap (${overlap}) must be smaller than size (${size})`);
  const { text } = doc;
  const words = [...text.matchAll(/\S+/g)].map((m) => ({ start: m.index, end: m.index + m[0].length, word: m[0] }));
  const cache = new Map();
  const wordTokens = (w) => {
    if (!cache.has(w.word)) cache.set(w.word, Math.max(1, tokenizer.count(w.word)));
    return cache.get(w.word);
  };
  const span = (i, j) => text.slice(words[i].start, words[j - 1].end);

  const chunks = [];
  let i = 0;
  while (i < words.length) {
    // Estimate from per-word counts, then settle on the exact count of the slice.
    let j = i;
    let estimate = 0;
    while (j < words.length && estimate + wordTokens(words[j]) <= size) estimate += wordTokens(words[j++]);
    if (j === i) j = i + 1;
    let tokens = tokenizer.count(span(i, j));
    while (tokens > size && j > i + 1) tokens = tokenizer.count(span(i, --j));
    while (j < words.length) {
      const next = tokenizer.count(span(i, j + 1));
      if (next > size) break;
      tokens = next;
      j++;
    }

    const char_start = words[i].start;
    chunks.push({
      char_start,
      char_end: words[j - 1].end,
      text: span(i, j),
      token_count: tokens,
      section: breadcrumb(sectionAt(doc.sections, char_start).path),
    });
    if (j >= words.length) break;

    let k = j;
    let shared = 0;
    while (k > i + 1 && shared + wordTokens(words[k - 1]) <= overlap) shared += wordTokens(words[--k]);
    i = k;
  }
  return chunks;
}
