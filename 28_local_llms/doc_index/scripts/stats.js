import fs from "node:fs";

import { DEFAULT_DB_PATH, MIN_CORPUS_PAGES } from "../src/config.js";
import { loadCorpus } from "../src/corpus.js";
import { openStore } from "../src/store.js";
import { corpusStats } from "../src/stats.js";

/** `npm run stats`: corpus size (chars, est. pages, per source) and chunk counts. */
const { documents, warnings } = await loadCorpus({ log: () => {} });
const s = corpusStats(documents);
const n = (x) => x.toLocaleString("en-US");

console.log("| collection | docs | formats | chars | est. pages |");
console.log("| --- | ---: | --- | ---: | ---: |");
for (const c of s.collections) console.log(`| ${c.name} | ${c.documents} | ${c.formats.join(", ")} | ${n(c.chars)} | ${c.pages.toFixed(1)} |`);
console.log(`| **total** | ${documents.length} | | ${n(s.totalChars)} | ${s.totalPages.toFixed(1)} |`);
console.log(`\n1 page ≈ 3,000 characters. Target: ≥ ${MIN_CORPUS_PAGES} pages → ${s.totalPages >= MIN_CORPUS_PAGES ? "met" : "NOT met"}.`);
console.log(
  s.knowledgeAloneEnough
    ? `knowledge_database/ alone reaches ${MIN_CORPUS_PAGES} pages; projects and the PDF stay for markdown, code and PDF coverage.`
    : `knowledge_database/ alone is under ${MIN_CORPUS_PAGES} pages.`,
);
for (const w of warnings) console.log(`warning: ${w}`);

if (fs.existsSync(DEFAULT_DB_PATH)) {
  const store = openStore(DEFAULT_DB_PATH, { readonly: true });
  const counts = store.countChunks();
  console.log(`\nindex: ${Object.entries(counts).map(([k, v]) => `${k} ${v} chunks`).join(", ") || "empty"}`);
  store.close();
} else {
  console.log("\nindex: not built yet (npm run index)");
}
