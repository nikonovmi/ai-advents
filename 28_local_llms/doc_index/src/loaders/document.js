import crypto from "node:crypto";

/**
 * **The normalised document every loader returns.**
 *
 * ```js
 * { doc_id, source, format, title, text, sections: [{ path: ["H1", "H2"], start, end }] }
 * ```
 *
 * `text` is plain text, paragraphs separated by one blank line. `sections` are
 * flat, consecutive, non-overlapping character ranges into `text` that cover it;
 * `path` is the heading breadcrumb of the range (empty before the first
 * heading). A section starts at its own heading, so the heading text is part
 * of the chunk that holds it.
 */

export const BREADCRUMB_SEPARATOR = " › ";
export const breadcrumb = (path) => path.join(BREADCRUMB_SEPARATOR);

/** A stable, readable id: lower-case, runs of anything else become "-". */
export function slug(value) {
  return (
    value
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9/.]+/g, "-")
      .replace(/-*\/-*/g, "/")
      .replace(/^-+|-+$/g, "") || crypto.createHash("sha256").update(value).digest("hex").slice(0, 12)
  );
}

/** Collapse inline whitespace (not newlines inside preformatted blocks). */
export const squash = (text) => text.replace(/\s+/g, " ").trim();

/**
 * Blocks → `{ text, sections }`.
 *
 * @param {Array<{ type: "heading", level: number, text: string } | { type: "para", text: string }>} blocks
 * @param {object} [o]
 * @param {string} [o.title] a heading equal to the title is not repeated in every breadcrumb
 */
export function assemble(blocks, { title } = {}) {
  const parts = [];
  const sections = [];
  const stack = [];
  let offset = 0;
  let current = { path: [], start: 0 };

  const closeAt = (end) => {
    if (end > current.start) sections.push({ path: current.path, start: current.start, end });
  };

  for (const block of blocks) {
    const text = block.text.replace(/\n{3,}/g, "\n\n").trim();
    if (!text) continue;
    const start = parts.length ? offset + 2 : 0;
    if (block.type === "heading") {
      while (stack.length && stack.at(-1).level >= block.level) stack.pop();
      stack.push({ level: block.level, text: squash(text) });
      const path = stack.filter((h) => !(title && sameText(h.text, title))).map((h) => h.text);
      // A heading that does not change the breadcrumb (the title) does not start a section.
      if (path.join("\0") !== current.path.join("\0")) {
        closeAt(parts.length ? offset : 0);
        current = { path, start };
      }
    }
    parts.push(text);
    offset = start + text.length;
  }
  closeAt(offset);
  return { text: parts.join("\n\n"), sections };
}

const sameText = (a, b) => squash(a).toLowerCase() === squash(b).toLowerCase();

/** The section holding character `pos` (the last one if past the end). */
export function sectionAt(sections, pos) {
  for (const s of sections) if (pos >= s.start && pos < s.end) return s;
  return sections.at(-1) ?? { path: [], start: 0, end: 0 };
}

/** Every section that a range [start, end) overlaps. */
export function sectionsIn(sections, start, end) {
  return sections.filter((s) => s.start < end && s.end > start);
}
