import { breadcrumb } from "../loaders/document.js";

/**
 * **One chunk per section, sized into [minTokens, maxTokens].**
 *
 * A section is whatever the loader found: a heading's range, a code
 * declaration, a numbered PDF section.
 *
 * 1. Merge: a section under `minTokens` (a heading with one line under it, a
 *    one-line `const`) is merged into the section that follows it, and the
 *    merged chunk takes the follower's breadcrumb. A tiny last section is
 *    merged into the one before it instead.
 * 2. Split: a section over `maxTokens` is cut at paragraph boundaries (for
 *    code: blank lines, then single lines), packing whole paragraphs per chunk.
 *    Only a single paragraph over the limit is cut at sentence boundaries, and
 *    only a single sentence over it at words — so every chunk fits.
 *
 * `section` is the breadcrumb, e.g. `Pipelines › Steps`.
 *
 * @param {{ text: string, format: string, sections: Array<{ path: string[], start: number, end: number }> }} doc
 * @param {{ count(text: string): number }} tokenizer
 * @param {{ minTokens: number, maxTokens: number }} options
 */
export function chunkStructural(doc, tokenizer, { minTokens, maxTokens }) {
  const { text } = doc;
  const count = (start, end) => tokenizer.count(text.slice(start, end));

  const units = doc.sections
    .map((s) => trim(text, s.start, s.end, s.path))
    .filter(Boolean)
    .map((u) => ({ ...u, tokens: count(u.start, u.end) }));

  const merged = [];
  let pending = null;
  for (const [i, unit] of units.entries()) {
    const u = pending ? { start: pending.start, end: unit.end, path: unit.path } : unit;
    if (pending) u.tokens = count(u.start, u.end);
    pending = null;
    if (u.tokens < minTokens && i < units.length - 1) pending = u;
    else merged.push(u);
  }
  if (merged.length > 1 && merged.at(-1).tokens < minTokens) {
    const tail = merged.pop();
    const prev = merged.pop();
    merged.push({ start: prev.start, end: tail.end, path: prev.path, tokens: count(prev.start, tail.end) });
  }

  const levels = doc.format === "code" ? [PARAGRAPHS, LINES, WORDS] : [PARAGRAPHS, SENTENCES, WORDS];
  const chunks = [];
  for (const unit of merged) {
    const ranges = unit.tokens <= maxTokens ? [unit] : split(text, unit.start, unit.end, levels, tokenizer, maxTokens, minTokens);
    for (const r of ranges) {
      chunks.push({
        char_start: r.start,
        char_end: r.end,
        text: text.slice(r.start, r.end),
        token_count: r.tokens ?? count(r.start, r.end),
        section: breadcrumb(unit.path),
      });
    }
  }
  return chunks;
}

const PARAGRAPHS = /\n[ \t]*\n/g;
const LINES = /\n/g;
const SENTENCES = /(?<=[.!?…])\s+(?=\S)/g;
const WORDS = /\s+/g;

/** [start, end) without its surrounding whitespace, or null if blank. */
function trim(text, start, end, path) {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return end > start ? { start, end, path } : null;
}

/** The non-blank pieces of [start, end) between matches of `separator`. */
function pieces(text, start, end, separator) {
  const out = [];
  const re = new RegExp(separator.source, "g");
  const slice = text.slice(start, end);
  let from = 0;
  for (const m of slice.matchAll(re)) {
    const p = trim(text, start + from, start + m.index);
    if (p) out.push(p);
    from = m.index + m[0].length;
  }
  const last = trim(text, start + from, end);
  if (last) out.push(last);
  return out;
}

/**
 * Greedy packing of whole pieces at the first level; a piece that alone is over
 * the limit is split at the next level. Each chunk aims at an even share of the
 * section (600 tokens → 2 × ~300, not 500 + 100) and a tail under `min` joins
 * the chunk before it when they fit together. Sizes are estimated from
 * per-piece counts and then confirmed on the exact slice.
 */
function split(text, start, end, levels, tokenizer, max, min) {
  const [level, ...rest] = levels;
  const parts = pieces(text, start, end, level).map((p) => ({ ...p, tokens: tokenizer.count(text.slice(p.start, p.end)) }));
  const total = parts.reduce((n, p) => n + p.tokens, 0);
  const target = Math.ceil(total / Math.ceil(total / max));
  const out = [];
  let group = [];
  let estimate = 0;
  const close = () => {
    while (group.length) {
      // The estimate can be optimistic: keep the longest prefix that really fits.
      let n = group.length;
      let tokens = tokenizer.count(text.slice(group[0].start, group[n - 1].end));
      while (tokens > max && n > 1) tokens = tokenizer.count(text.slice(group[0].start, group[--n - 1].end));
      out.push({ start: group[0].start, end: group[n - 1].end, tokens });
      group = group.slice(n);
    }
    estimate = 0;
  };
  for (const part of parts) {
    if (part.tokens > max) {
      close();
      if (rest.length) out.push(...split(text, part.start, part.end, rest, tokenizer, max, min));
      else out.push(part);
      continue;
    }
    if (group.length && (estimate + part.tokens > max || estimate >= target)) close();
    group.push(part);
    estimate += part.tokens;
  }
  close();
  const last = out.at(-1);
  const prev = out.at(-2);
  if (prev && last.tokens < min) {
    const tokens = tokenizer.count(text.slice(prev.start, last.end));
    if (tokens <= max) out.splice(-2, 2, { start: prev.start, end: last.end, tokens });
  }
  return out;
}
