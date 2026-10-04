import { slug } from "./document.js";

/**
 * **A JavaScript file → a normalised document.**
 *
 * Code has no headings, so its sections are its top-level declarations: a line
 * at column 0 that starts `export`, `function`, `class`, or `const|let|var x =`.
 * Each is named after its identifier (`export default` → "default",
 * `export { a, b }` → "export { a, b }"). A comment block directly above a
 * declaration belongs to it. Whatever comes before the first declaration
 * (imports, the file's header comment) is the "(module)" section.
 *
 * `text` is the file itself, line endings normalised; blank lines are kept,
 * since that is where a reader sees the paragraphs.
 */

const DECLARATION =
  /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/;
const EXPORT_OTHER = /^export\s+(default\b|\{[^}]*\}|\*)/;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

export const MODULE_SECTION = "(module)";

/** The identifier a column-0 line declares, or null. */
export function declarationName(line) {
  const m = DECLARATION.exec(line);
  if (m) return m[1] ?? m[2] ?? m[3];
  const e = EXPORT_OTHER.exec(line);
  if (e) return e[1] === "default" ? "default" : `export ${e[1].replace(/\s+/g, " ")}`;
  return null;
}

export function loadCode(source, { relPath }) {
  const text = source.replace(/\r\n?/g, "\n").replace(/\s+$/, "") + "\n";
  const lines = text.split("\n");
  const lineStart = [];
  let pos = 0;
  for (const line of lines) {
    lineStart.push(pos);
    pos += line.length + 1;
  }

  const starts = [];
  let inBlockComment = false;
  lines.forEach((line, i) => {
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      return;
    }
    if (/^\/\*/.test(line) && !line.includes("*/")) {
      inBlockComment = true;
      return;
    }
    const name = declarationName(line);
    if (!name) return;
    let first = i;
    while (first > 0 && COMMENT_LINE.test(lines[first - 1]) && lines[first - 1].trim()) first--;
    starts.push({ name, line: first });
  });

  const sections = [];
  const firstStart = starts.length ? lineStart[starts[0].line] : text.length;
  if (firstStart > 0) sections.push({ path: [MODULE_SECTION], start: 0, end: firstStart });
  starts.forEach((s, i) => {
    const start = lineStart[s.line];
    const end = i + 1 < starts.length ? lineStart[starts[i + 1].line] : text.length;
    if (end > start) sections.push({ path: [s.name], start, end });
  });

  return {
    doc_id: `projects/${slug(relPath)}`,
    source: relPath,
    format: "code",
    title: relPath,
    text,
    sections,
  };
}
