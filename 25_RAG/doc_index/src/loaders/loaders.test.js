import assert from "node:assert/strict";
import { test } from "node:test";

import { loadCode } from "./code.js";
import { breadcrumb } from "./document.js";
import { loadHtml } from "./html.js";
import { loadMarkdown } from "./markdown.js";
import { pdfFromPages, pdfHeading } from "./pdf.js";

const sectionTexts = (doc) => doc.sections.map((s) => [breadcrumb(s.path), doc.text.slice(s.start, s.end)]);

const HTML = `<!doctype html><html><head><title>Fixture | Site</title><style>.x{color:red}</style>
<script>window.track = 1</script></head><body>
<header><nav><a href="/">Home</a> <a href="/blog">Blog</a></nav></header>
<main>
  <div class="cookie-banner">We use cookies. Accept?</div>
  <article>
    <h1>Fixture Article</h1>
    <p>The intro paragraph explains what this page is about.</p>
    <h2>Setup <span class="mw-editsection">[edit]</span></h2>
    <p>Install the tool with one command.</p>
    <ul><li>first item</li><li>second item</li></ul>
    <h3>Details</h3>
    <p>Some <b>bold</b> and <a href="#">linked</a> words.</p>
    <table><tr><th>name</th><th>value</th></tr><tr><td>a</td><td>1</td></tr></table>
    <pre><code>const x = 1;
console.log(x);</code></pre>
    <h2>Usage</h2>
    <p>Run it.</p>
    <script>alert("inline")</script>
  </article>
  <aside class="sidebar">Related posts you may like</aside>
  <form class="subscribe"><input> Subscribe to our newsletter</form>
</main>
<footer>© 2026 Footer text</footer>
</body></html>`;

test("html: chrome is dropped, headings become sections", () => {
  const doc = loadHtml(HTML, { relPath: "sub/Fixture Page.html" });
  assert.equal(doc.title, "Fixture Article");
  assert.equal(doc.format, "html");
  assert.equal(doc.doc_id, "kb/sub/fixture-page.html");
  assert.equal(doc.source, "knowledge_database/sub/Fixture Page.html");
  for (const gone of ["Home", "window.track", "alert", "cookies", "Related posts", "newsletter", "Footer", "[edit]", "color:red", "<"]) {
    assert.ok(!doc.text.includes(gone), `"${gone}" should be gone`);
  }
  assert.match(doc.text, /- first item\n\n- second item/);
  assert.match(doc.text, /name \| value\n\na \| 1/);
  assert.match(doc.text, /const x = 1;\nconsole\.log\(x\);/);
  assert.match(doc.text, /Some bold and linked words\./);
  assert.deepEqual(doc.sections.map((s) => breadcrumb(s.path)), ["", "Setup", "Setup › Details", "Usage"]);
  const [, setup] = sectionTexts(doc)[1];
  assert.ok(setup.startsWith("Setup\n\nInstall the tool"));
  // Sections tile the text.
  assert.equal(doc.sections[0].start, 0);
  assert.equal(doc.sections.at(-1).end, doc.text.length);
});

test("html: an empty page yields (almost) no text", () => {
  const doc = loadHtml("<html><head><title>Human Verification</title></head><body><script>x()</script></body></html>", { relPath: "captcha.html" });
  assert.equal(doc.text, "");
  assert.equal(doc.title, "Human Verification");
});

test("markdown: # headings are sections, fenced code stays as text", () => {
  const md = "# Project\n\nIntro line.\n\n## Pipelines\n\nThey run.\n\n### Steps\n\n```js\n# not a heading\nrun();\n\nmore();\n```\n\n## Tests\n\nnpm test\n";
  const doc = loadMarkdown(md, { relPath: "p/README.md" });
  assert.equal(doc.title, "p/README.md — Project");
  assert.equal(doc.format, "markdown");
  assert.deepEqual(sectionTexts(doc).map(([b]) => b), ["", "Pipelines", "Pipelines › Steps", "Tests"]);
  assert.match(doc.text, /```js\n# not a heading\nrun\(\);\n\nmore\(\);\n```/);
  assert.ok(!doc.text.includes("## "));
});

test("code: top-level declarations are sections, named after the identifier", () => {
  const src = [
    'import fs from "node:fs";',
    "",
    "/** Doc for alpha. */",
    "export function alpha() {",
    "  const inner = 1;",
    "  return inner;",
    "}",
    "",
    "class Beta {}",
    "",
    "export const GAMMA = 3;",
    "const helper = (x) => x;",
    "export default helper;",
    "",
  ].join("\n");
  const doc = loadCode(src, { relPath: "src/mod.js" });
  assert.equal(doc.title, "src/mod.js");
  assert.equal(doc.format, "code");
  const names = sectionTexts(doc).map(([b]) => b);
  assert.deepEqual(names, ["(module)", "alpha", "Beta", "GAMMA", "helper", "default"]);
  const alpha = sectionTexts(doc)[1][1];
  assert.ok(alpha.startsWith("/** Doc for alpha. */\nexport function alpha()"), "the comment above belongs to the declaration");
  assert.ok(!names.includes("inner"));
});

test("pdf: numbered headings nest, hyphenated line ends are joined", () => {
  assert.deepEqual(pdfHeading("3.2 Attention"), { level: 2, text: "3.2 Attention" });
  assert.equal(pdfHeading("3 2 1 0.5"), null);
  assert.equal(pdfHeading("6 identical layers were used in our experiments, as we found."), null);
  const doc = pdfFromPages(
    [
      "1 Introduction\nRecurrent models are strong but sequen-\ntial by nature.\n1",
      "3 Model\nThe model is simple.\n3.1 Encoder\nA stack of layers.\n2",
    ],
    { id: "paper", title: "Paper", source: "https://example.org/paper.pdf" },
  );
  assert.match(doc.text, /sequential by nature\./);
  assert.deepEqual(doc.sections.map((s) => breadcrumb(s.path)), ["1 Introduction", "3 Model", "3 Model › 3.1 Encoder"]);
  assert.ok(!/\n\d\n/.test(doc.text), "page numbers are dropped");
});

test("pdf: without numbered headings, sections are pages", () => {
  const doc = pdfFromPages(["just text here.", "more text here."], { id: "p", title: "P", source: "x" });
  assert.deepEqual(doc.sections.map((s) => breadcrumb(s.path)), ["Page 1", "Page 2"]);
});
