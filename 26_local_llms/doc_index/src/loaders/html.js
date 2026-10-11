import path from "node:path";

import * as cheerio from "cheerio";

import { assemble, slug, squash } from "./document.js";

/**
 * **A saved web page → a normalised document.**
 *
 * The pages come from arbitrary sites (JetBrains blog, Medium, …), so nothing
 * here knows a site. The main content is the first of `main`, `article`,
 * `[role=main]`, `#content`, `#mw-content-text`, else `body`. Inside it, the
 * obvious chrome goes (scripts, nav, headers, forms, share/subscribe/comment/
 * related blocks, reference lists, edit links), and then the root narrows to the
 * smallest element still holding nearly all of the paragraph text (link text
 * not counted), which drops
 * "Discover more" card rows and author boxes that survived the first pass.
 *
 * The title is the first h1, else `og:title` (Medium's `<title>` is often just
 * "Medium"), else `<title>`, else the file name.
 *
 * h1–h4 become sections; paragraphs, list items, code blocks, quotes and
 * table rows (`a | b`) become paragraphs. No markup is ever emitted.
 */

export const MAIN_SELECTORS = ["main", "article", "[role=main]", "#content", "#mw-content-text"];

const DROP_TAGS = "script, style, noscript, template, svg, canvas, iframe, nav, header, footer, aside, form, button, input, select, textarea, dialog";
const DROP_SELECTORS = [
  "[role=navigation]", "[role=banner]", "[role=button]", "[role=contentinfo]", "[role=complementary]", "[role=dialog]", "[aria-hidden=true]", "[hidden]", '[style*="display: none"]', '[style*="display:none"]',
  ".mw-editsection", ".reflist", ".references", "ol.references", "#references", "sup.reference", ".navbox", ".toc", "#toc",
].join(", ");
/** Matched against each class token and the id, whole words only. */
const NOISE = /^(?:.*[-_])?(cookie|cookies|consent|gdpr|banner|sidebar|side-bar|share|sharing|social|subscribe|subscription|newsletter|comments?|related|recommended|discover|pagination|breadcrumbs?|tag-list|tags|author|byline|promo|advert|ads|popup|modal|edit-?link|footnotes?|references?)(?:[-_].*)?$/i;

const BLOCK_TAGS = new Set(["p", "li", "pre", "blockquote", "dt", "dd", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table"]);
const HEADING = /^h([1-6])$/;

/** Below this many characters a page is treated as empty (a CAPTCHA, a paywall stub). */
export const MIN_TEXT_CHARS = 400;

/**
 * @param {string} html
 * @param {object} o
 * @param {string} o.relPath path relative to the knowledge folder (gives doc_id)
 * @param {string} [o.sourcePrefix]
 */
export function loadHtml(html, { relPath, sourcePrefix = "knowledge_database" }) {
  const $ = cheerio.load(html);
  const pageTitle = squash($('meta[property="og:title"]').attr("content") ?? "") || squash($("head > title").first().text());
  let root = $(MAIN_SELECTORS.join(", ")).first();
  if (!root.length) root = $("body");

  root.find(DROP_TAGS).remove();
  root.find(DROP_SELECTORS).remove();
  root.find("*").each((_, el) => {
    const tokens = [...(el.attribs.class?.split(/\s+/) ?? []), el.attribs.id ?? ""].filter(Boolean);
    if (tokens.some((t) => NOISE.test(t))) $(el).remove();
  });

  const h1 = squash(root.find("h1").first().text()) || squash($("h1").first().text());
  const title = h1 || pageTitle || path.basename(relPath).replace(/\.html?$/i, "");

  const content = narrow($, root);
  const blocks = [];
  // The title heading may sit just outside the narrowed block; keep it first.
  if (h1 && !content.find("h1").length) blocks.push({ type: "heading", level: 1, text: h1 });
  collect($, content, blocks);
  const { text, sections } = assemble(
    blocks.filter((b) => /[\p{L}\p{N}]/u.test(b.text)),
    { title },
  );

  return {
    doc_id: `kb/${slug(relPath)}`,
    source: `${sourcePrefix}/${relPath.split(path.sep).join("/")}`,
    format: "html",
    title,
    text,
    sections,
  };
}

/** Paragraph text that is not link text: a row of teaser cards is all links. */
const paragraphChars = ($, el) => {
  let n = 0;
  $(el)
    .find("p, li, pre")
    .each((_, p) => {
      if ($(p).closest("a").length) return;
      n += $(p).text().length - $(p).find("a").text().length;
    });
  return n;
};

/** Walk down while a single child holds ≥ 85 % of the paragraph text. */
function narrow($, root) {
  let node = root;
  const total = paragraphChars($, root);
  if (!total) return root;
  for (;;) {
    const best = node
      .children()
      .toArray()
      .map((c) => ({ c, n: paragraphChars($, c) }))
      .sort((a, b) => b.n - a.n)[0];
    if (!best || best.n < total * 0.85) return node;
    node = $(best.c);
  }
}

function collect($, node, blocks) {
  node.contents().each((_, el) => {
    if (el.type === "text") {
      const text = squash(el.data);
      if (text.length > 1) blocks.push({ type: "para", text });
      return;
    }
    if (el.type !== "tag") return;
    const tag = el.tagName.toLowerCase();
    const heading = HEADING.exec(tag);
    if (heading) {
      const level = Number(heading[1]);
      blocks.push(level <= 4 ? { type: "heading", level, text: squash($(el).text()) } : { type: "para", text: squash($(el).text()) });
    } else if (tag === "pre") {
      blocks.push({ type: "para", text: preText($, el) });
    } else if (tag === "table") {
      $(el)
        .find("tr")
        .each((_, tr) => {
          const cells = $(tr).children("th, td").toArray().map((c) => squash($(c).text())).filter(Boolean);
          if (cells.length) blocks.push({ type: "para", text: cells.join(" | ") });
        });
    } else if (tag === "li") {
      const nested = $(el).children("ul, ol");
      const own = $(el).clone();
      own.children("ul, ol").remove();
      const text = squash(own.text());
      if (text) blocks.push({ type: "para", text: `- ${text}` });
      nested.each((_, list) => collect($, $(list), blocks));
    } else if (BLOCK_TAGS.has(tag) || !$(el).find([...BLOCK_TAGS].join(", ")).length) {
      const text = squash($(el).text());
      if (text) blocks.push({ type: "para", text });
    } else {
      collect($, $(el), blocks);
    }
  });
}

/** Code keeps its lines: <br> and block children become newlines. */
function preText($, el) {
  const pre = $(el).clone();
  pre.find("br").replaceWith("\n");
  pre.find("div, p, li").each((_, d) => {
    $(d).append("\n");
  });
  return pre
    .text()
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
