import { assemble, slug } from "./document.js";

/**
 * **A PDF → a normalised document.**
 *
 * Text comes out of `unpdf` one page at a time, one line per visual line. The
 * lines are put back into paragraphs: a hyphen at a line end joins the word
 * ("transduc-" + "tion"), and a line joins the next unless it is short and ends
 * a sentence, or the next line is a heading. Bare page numbers are dropped.
 *
 * Sections come from numbered headings on a line of their own (`3.2 Attention`,
 * `3.2.1 Scaled Dot-Product Attention`), plus `Abstract` and `References`; the
 * numbering gives the depth, so `3.2.1` sits under `3.2` under `3`. A PDF with
 * no such headings gets one `Page N` section per page instead.
 */

const NUMBERED = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+([A-Z][A-Za-z][^=]{1,70})$/;
const NAMED = /^(Abstract|References|Acknowledgements?|Appendix)$/;

/** `{ level, text }` when a line is a section heading, else null. */
export function pdfHeading(line) {
  const t = line.trim();
  if (NAMED.test(t)) return { level: 1, text: t };
  const m = NUMBERED.exec(t);
  if (!m) return null;
  const words = m[2].split(/\s+/);
  if (words.length > 8 || /[.,;:]$/.test(m[2]) || /\d\s*$/.test(m[2])) return null;
  return { level: m[1].split(".").length, text: `${m[1]} ${m[2]}` };
}

/** One page's lines → blocks (headings and paragraphs). */
export function pageBlocks(pageText) {
  const lines = pageText
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && !/^\d{1,3}$/.test(l));
  const width = Math.max(40, ...lines.map((l) => l.length)) * 0.8;
  const blocks = [];
  let para = "";
  const flush = () => {
    if (para) blocks.push({ type: "para", text: para });
    para = "";
  };
  for (const line of lines) {
    const heading = pdfHeading(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", ...heading });
      continue;
    }
    if (para.endsWith("-") && /^[a-z]/.test(line)) para = para.slice(0, -1) + line;
    else para = para ? `${para} ${line}` : line;
    if (line.length < width && /[.!?:]$/.test(line)) flush();
  }
  flush();
  return blocks;
}

/**
 * @param {Uint8Array | Buffer} data
 * @param {{ id: string, title: string, source: string }} meta
 */
export async function loadPdf(data, { id, title, source }) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text: pages } = await extractText(pdf, { mergePages: false });
  return pdfFromPages(pages, { id, title, source });
}

/** Pages of text → the document (no PDF parsing; the tests use this). */
export function pdfFromPages(pages, { id, title, source }) {
  const perPage = pages.map(pageBlocks);
  // A paragraph cut by a page break continues on the next page.
  const blocks = [];
  for (const page of perPage) {
    for (const [i, b] of page.entries()) {
      const prev = blocks.at(-1);
      if (i === 0 && b.type === "para" && prev?.type === "para" && !/[.!?:]$/.test(prev.text) && /^[a-z]/.test(b.text)) {
        prev.text = prev.text.endsWith("-") ? prev.text.slice(0, -1) + b.text : `${prev.text} ${b.text}`;
      } else blocks.push({ ...b });
    }
  }

  let { text, sections } = assemble(blocks, { title });
  if (!blocks.some((b) => b.type === "heading")) {
    const paged = perPage.flatMap((page, i) => [{ type: "heading", level: 1, text: `Page ${i + 1}` }, ...page]);
    ({ text, sections } = assemble(paged, { title }));
  }
  return { doc_id: `pdf/${slug(id)}`, source, format: "pdf", title, text, sections };
}
