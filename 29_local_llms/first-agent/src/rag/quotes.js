/**
 * **Is a quote really in its chunk?** The check behind "verbatim excerpt".
 *
 * A model copying a sentence changes things a reader would never call a
 * change: curly quotes become straight ones, an en dash becomes a hyphen, a
 * line break becomes a space, a word hyphenated across a line is joined, a
 * code span loses its backticks. Both texts are normalised the same way before
 * comparing, so those pass and anything else (a paraphrase, a dropped word, a
 * sentence from another chunk) does not.
 *
 * Normalised: case; whitespace runs → one space; ‘ ’ ‚ ‛ ′ ` → '; “ ” „ ‟ ″ → ";
 * ‐ ‑ ‒ – — ― − → -; … → ...; "exam-\nple" → "example". A leading or trailing
 * `...` or quote mark around the whole quote is ignored.
 */

const SINGLE = new Set(["‘", "’", "‚", "‛", "′", "`", "´"]);
const DOUBLE = new Set(["“", "”", "„", "‟", "″", "«", "»"]);
const DASH = new Set(["‐", "‑", "‒", "–", "—", "―", "−", "-"]);
const isSpace = (ch) => /\s/u.test(ch);
const isLetter = (ch) => /\p{L}/u.test(ch ?? "");

/**
 * The normalised text, and for each of its characters the index in the raw
 * text it came from, so a match can be mapped back to highlight the original.
 *
 * @param {string} raw
 * @returns {{ text: string, map: number[] }}
 */
export function normalizeWithMap(raw) {
  const s = String(raw ?? "");
  let text = "";
  const map = [];
  const push = (out, at) => {
    for (const ch of out) {
      text += ch;
      map.push(at);
    }
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (DASH.has(ch)) {
      // Line-break hyphenation: a letter, a dash, whitespace with a newline in it, a letter.
      let j = i + 1;
      while (j < s.length && isSpace(s[j])) j++;
      if (j > i + 1 && /\n/.test(s.slice(i + 1, j)) && isLetter(s[i - 1]) && isLetter(s[j])) {
        i = j - 1;
        continue;
      }
      push("-", i);
    } else if (isSpace(ch)) {
      if (text.length && !text.endsWith(" ")) push(" ", i);
    } else if (SINGLE.has(ch)) push("'", i);
    else if (DOUBLE.has(ch)) push('"', i);
    else if (ch === "…") push("...", i);
    else push(ch.toLowerCase(), i);
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}

export const normalizeQuote = (raw) => normalizeWithMap(raw).text;

/** The quote as it is compared: normalised, without wrapping quote marks or leading / trailing ellipses. */
function core(quote) {
  let q = normalizeQuote(quote);
  for (let changed = true; changed; ) {
    const before = q;
    q = q.replace(/^(\.\.\.|["'])\s*/, "").replace(/\s*(\.\.\.|["'])$/, "");
    changed = q !== before;
  }
  return q.trim();
}

/**
 * Where the quote is in the chunk's raw text, or null if it is not there.
 *
 * @param {string} chunkText
 * @param {string} quote
 * @returns {{ start: number, end: number } | null} raw offsets, `end` exclusive
 */
export function findQuote(chunkText, quote) {
  const q = core(quote);
  if (!q) return null;
  const { text, map } = normalizeWithMap(chunkText);
  const at = text.indexOf(q);
  if (at < 0) return null;
  return { start: map[at], end: map[at + q.length - 1] + 1 };
}

export const quoteInChunk = (chunkText, quote) => findQuote(chunkText, quote) !== null;

/** Words in a quote, as rule 5 counts them. */
export const wordCount = (quote) => core(quote).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
