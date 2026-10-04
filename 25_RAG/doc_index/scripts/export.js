import fs from "node:fs";
import path from "node:path";

import { DATA_DIR, REPORTS_DIR, STRATEGIES } from "../src/config.js";
import { openStore } from "../src/store.js";

/**
 * `npm run export`:
 * - data/index.<strategy>.json — chunks, metadata and vectors as arrays (git-ignored);
 * - reports/chunks.<strategy>.jsonl — one chunk per line, no vectors (committed,
 *   so the chunks can be read without building the index).
 */
const store = openStore(undefined, { readonly: true });
const meta = { embedding: store.getMeta("embedding"), chunker: store.getMeta("chunker"), created_at: store.getMeta("created_at"), updated_at: store.getMeta("updated_at") };
fs.mkdirSync(REPORTS_DIR, { recursive: true });
for (const strategy of STRATEGIES) {
  const rows = store.chunksWithVectors(strategy);
  const chunks = rows.map(({ vector, ...c }) => ({ ...c, vector: Array.from(vector, (v) => Number(v.toFixed(6))) }));
  const file = path.join(DATA_DIR, `index.${strategy}.json`);
  fs.writeFileSync(file, JSON.stringify({ strategy, ...meta, chunks }));
  console.log(`${path.relative(process.cwd(), file)}: ${chunks.length} chunks`);

  const lines = rows.map(({ chunk_id, source, section, token_count, char_start, char_end, text }) =>
    JSON.stringify({ chunk_id, source, section, token_count, char_start, char_end, text }),
  );
  const readable = path.join(REPORTS_DIR, `chunks.${strategy}.jsonl`);
  fs.writeFileSync(readable, `${lines.join("\n")}\n`);
  console.log(`${path.relative(process.cwd(), readable)}: ${lines.length} chunks, no vectors`);
}
store.close();
