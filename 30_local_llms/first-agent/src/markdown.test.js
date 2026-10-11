import assert from "node:assert/strict";
import test from "node:test";

import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { marked } from "marked";

import { ALLOWED_TAGS, createMarkdown } from "../public/markdown.js";

/**
 * The renderer, against a real DOM.
 *
 * `public/markdown.js` is browser code, but the thing worth testing about it is
 * not the browser — it is the allowlist. DOMPurify needs a `window` to do its
 * work, so the test supplies one and hands it in the same way the page hands in
 * the real one.
 */
const render = createMarkdown({
  marked,
  DOMPurify: createDOMPurify(new JSDOM("").window),
});

test("the Markdown a model actually writes comes out as elements", () => {
  const html = render(
    [
      "# Heading",
      "",
      "Some **bold** and `inline code` and *emphasis*.",
      "",
      "- first",
      "- second",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "> quoted",
    ].join("\n")
  );

  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>inline code<\/code>/);
  assert.match(html, /<em>emphasis<\/em>/);
  assert.match(html, /<ul>[\s\S]*<li>first<\/li>/);
  assert.match(html, /<pre><code class="language-js">const x = 1;/);
  assert.match(html, /<table>[\s\S]*<th>a<\/th>/);
  assert.match(html, /<blockquote>/);
});

test("a soft-wrapped paragraph stays one paragraph", () => {
  // Models wrap prose. Turning every newline into a <br> would shred it.
  const html = render("one line\nstill the same sentence");
  assert.doesNotMatch(html, /<br\s*\/?>/);
  assert.match(html, /one line\s*\nstill the same sentence/);
});

test("script, event handlers and javascript: URLs do not survive", () => {
  const html = render(
    [
      "<script>alert(1)</script>",
      '<img src=x onerror="alert(1)">',
      '<a href="javascript:alert(1)">click</a>',
      '<div onclick="alert(1)">text</div>',
      '<iframe src="https://example.com"></iframe>',
      "<style>body{display:none}</style>",
      '<svg><script>alert(1)</script></svg>',
      "[ok](https://example.com)",
    ].join("\n\n")
  );

  for (const forbidden of ["<script", "<img", "<iframe", "<style", "<svg", "onerror", "onclick", "javascript:"]) {
    assert.ok(!html.includes(forbidden), `${forbidden} survived sanitizing: ${html}`);
  }
  // …and the legitimate link in the same reply still works.
  assert.match(html, /<a href="https:\/\/example\.com"/);
});

test("every link is safe to open and cannot reach back", () => {
  const html = render("[docs](https://example.com/docs)");
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
});

test("nothing outside the allowlist can appear, whatever the reply says", () => {
  // The allowlist is the security boundary, so it is asserted directly rather
  // than only through examples: a tag added to it by accident is the bug.
  for (const dangerous of ["script", "style", "iframe", "object", "embed", "form", "input", "img", "svg", "math", "base", "link", "meta"]) {
    assert.ok(!ALLOWED_TAGS.includes(dangerous), `${dangerous} is on the allowlist`);
  }
});

test("empty and non-string replies render as nothing rather than throwing", () => {
  assert.equal(render(""), "");
  assert.equal(render("   \n  "), "");
  assert.equal(render(null), "");
  assert.equal(render(undefined), "");
});

test("a renderer cannot be built without both halves", () => {
  assert.throws(() => createMarkdown({ marked }), /DOMPurify/);
  assert.throws(() => createMarkdown({ DOMPurify: {} }), /marked/);
});

test("a sanitizer that cannot sanitize is refused, not used", () => {
  // Without a DOM, DOMPurify returns its input unchanged. Rendering through it
  // would be worse than not rendering at all, so it is an error up front.
  const inert = { sanitize: (html) => html, addHook() {}, isSupported: false };
  assert.throws(() => createMarkdown({ marked, DOMPurify: inert }), /unsupported/);
});
