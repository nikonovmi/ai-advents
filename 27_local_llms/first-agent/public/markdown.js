/**
 * Model output, rendered as Markdown and sanitized before it reaches the DOM.
 *
 * A reply is Markdown whether or not this app renders it — models write lists,
 * headings and fenced code because that is how they were trained to write. The
 * transcript used to set `textContent`, so all of that arrived as literal
 * asterisks and backticks: correct, and unreadable.
 *
 * **Both halves are load-bearing.** `marked` turns the text into HTML and
 * DOMPurify decides what of that HTML is allowed to exist. Skipping the second
 * would mean a reply containing `<img src=x onerror=…>` executes — and a reply
 * is not trusted input. It is a model's output, which means it is partly the
 * user's input, which means it is partly whatever was in a document the user
 * pasted in.
 *
 * The two libraries are **injected** rather than imported here, for the same
 * reason the Agent takes a provider: the browser resolves them from `/vendor/`
 * and a test resolves them from `node_modules`, and the allowlist below — the
 * part worth reviewing — should not have to exist twice to allow that.
 */

/**
 * What a reply is allowed to contain. An allowlist rather than a denylist:
 * a denylist is a promise that nobody will ever invent a new tag.
 *
 * Notable omissions, all deliberate: no `img` (a reply has no business loading a
 * remote URL, and that is the usual carrier for `onerror`), no `svg` or `math`
 * (both are parser corner-cases that have carried real bypasses), no `iframe`,
 * `form`, `input`, `style` or `script`.
 */
export const ALLOWED_TAGS = [
  "p", "br", "hr", "span",
  "strong", "em", "del", "s", "b", "i", "code", "kbd",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "blockquote", "pre",
  "table", "thead", "tbody", "tr", "th", "td",
  "a",
];

/**
 * `href` is the only attribute that carries anything, and DOMPurify is what
 * decides which schemes are allowed in it — `javascript:` is not. `class`
 * survives because the code-block styling hangs off `language-*`.
 */
export const ALLOWED_ATTR = ["href", "title", "class"];

/**
 * Build the renderer.
 *
 * @param {{ marked: object, DOMPurify: object }} deps
 * @returns {(text: string) => string} HTML that is safe to assign to `innerHTML`.
 */
export function createMarkdown({ marked, DOMPurify }) {
  if (!marked?.parse) throw new Error("createMarkdown needs a marked with a parse() method");
  if (!DOMPurify?.sanitize) throw new Error("createMarkdown needs a DOMPurify with a sanitize() method");
  // **Fail closed.** With no DOM to work against, DOMPurify reports
  // `isSupported: false` and `sanitize()` hands the input straight back. That
  // is the one failure mode here that is silent *and* dangerous, so it is an
  // error at construction rather than unescaped model output at render time.
  if (DOMPurify.isSupported === false) {
    throw new Error("DOMPurify reports it is unsupported here — refusing to render unsanitized replies");
  }

  marked.setOptions({
    // GitHub-flavoured, because that is the dialect models write: fenced code,
    // tables, strikethrough.
    gfm: true,
    // A single newline is not a `<br>`. Models soft-wrap inside a paragraph, and
    // honouring those would shred every paragraph into ragged lines.
    breaks: false,
  });

  /**
   * Every link leaves this page, and none of it should be able to reach back.
   *
   * `target="_blank"` without `rel="noopener"` hands the opened page a live
   * `window.opener` reference. Done as a hook rather than by post-processing the
   * string, so it applies to every anchor the sanitizer decided to keep and
   * cannot be skipped by one that arrives in an unexpected shape.
   */
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName !== "A") return;
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer nofollow");
  });

  return function renderMarkdown(text) {
    const source = typeof text === "string" ? text : String(text ?? "");
    if (!source.trim()) return "";

    let html;
    try {
      html = marked.parse(source);
    } catch (err) {
      // A reply that cannot be parsed is still a reply. Falling back to the
      // escaped source shows the words rather than an error — and it goes
      // through the sanitizer below on the same path, so this is not a hole.
      console.error("[markdown] could not parse a reply, showing it as text:", err);
      html = escapeHtml(source);
    }

    return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
  };
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}
