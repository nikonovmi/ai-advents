import { assemble, slug } from "./document.js";

/**
 * **Markdown → a normalised document.**
 *
 * `#` headings (outside code fences) start sections; the heading line loses its
 * hashes. Everything else is kept as text, fenced code included, so a chunk
 * shows the same thing a reader of the file sees. Paragraphs are runs of lines
 * between blank lines; a fenced block is one paragraph however many blank lines
 * it holds.
 */

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

export function loadMarkdown(markdown, { relPath }) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  let fence = null;
  const flush = () => {
    if (para.length) blocks.push({ type: "para", text: para.join("\n") });
    para = [];
  };

  for (const line of lines) {
    if (fence) {
      para.push(line);
      if (line.trim().startsWith(fence)) {
        fence = null;
        flush();
      }
      continue;
    }
    const f = FENCE.exec(line);
    if (f) {
      flush();
      fence = f[1];
      para.push(line);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ type: "heading", level: h[1].length, text: h[2] });
    } else if (!line.trim()) {
      flush();
    } else {
      para.push(line.trimEnd());
    }
  }
  flush();

  const firstH1 = blocks.find((b) => b.type === "heading" && b.level === 1)?.text;
  const title = firstH1 ? `${relPath} — ${firstH1}` : relPath;
  const { text, sections } = assemble(blocks, { title: firstH1 });
  return {
    doc_id: `projects/${slug(relPath)}`,
    source: relPath,
    format: "markdown",
    title,
    text,
    sections,
  };
}
