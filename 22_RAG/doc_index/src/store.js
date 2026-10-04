import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { DEFAULT_DB_PATH } from "./config.js";

/**
 * **The only file that knows SQL.** One SQLite file, `data/index.sqlite`.
 *
 * - `meta`: key → JSON. `embedding` ({ modelId, dtype, dims, prefixes }),
 *   `chunker` (the chunker config the chunks were built with), `created_at`,
 *   and `embed_stats` (per strategy: tokens and time of the last run that
 *   embedded all of its chunks).
 * - `documents`: one row per normalised document (its text and sections too).
 * - `chunks`: every chunk record, both strategies.
 * - `embeddings`: `chunk_id` → vector (Float32Array as a BLOB).
 * - `embedding_cache`: (content_hash, model, dtype, dims) → vector. This is what
 *   makes a re-run embed nothing, and lets a chunk whose text did not move keep
 *   its vector when its neighbours change.
 *
 * An index belongs to one embedding model/dtype/dims. `assertCompatible` refuses
 * to mix them: the fix is `npm run index -- --rebuild`.
 */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS documents (
    doc_id     TEXT PRIMARY KEY,
    collection TEXT NOT NULL,
    source     TEXT NOT NULL,
    format     TEXT NOT NULL,
    title      TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    text       TEXT NOT NULL,
    sections   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chunks (
    chunk_id     TEXT PRIMARY KEY,
    strategy     TEXT NOT NULL,
    doc_id       TEXT NOT NULL,
    source       TEXT NOT NULL,
    format       TEXT NOT NULL,
    title        TEXT NOT NULL,
    section      TEXT NOT NULL,
    idx          INTEGER NOT NULL,
    char_start   INTEGER NOT NULL,
    char_end     INTEGER NOT NULL,
    token_count  INTEGER NOT NULL,
    text         TEXT NOT NULL,
    content_hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chunks_strategy ON chunks (strategy, doc_id, idx);
  CREATE TABLE IF NOT EXISTS embeddings (chunk_id TEXT PRIMARY KEY, vector BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS embedding_cache (
    content_hash TEXT NOT NULL,
    model        TEXT NOT NULL,
    dtype        TEXT NOT NULL,
    dims         INTEGER NOT NULL,
    vector       BLOB NOT NULL,
    PRIMARY KEY (content_hash, model, dtype, dims)
  );
`;

export class IndexMismatchError extends Error {}

export const toBlob = (vec) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
export const fromBlob = (buf) => new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

export function openStore(dbPath = DEFAULT_DB_PATH, { readonly = false } = {}) {
  if (readonly && !fs.existsSync(dbPath)) throw new Error(`no index at ${dbPath}: run npm run index`);
  if (!readonly) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { readonly });
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
  }

  const getMeta = (key) => {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) : undefined;
  };
  const setMeta = (key, value) =>
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));

  const insertChunk = !readonly && db.prepare(`
    INSERT INTO chunks (chunk_id, strategy, doc_id, source, format, title, section, idx, char_start, char_end, token_count, text, content_hash)
    VALUES (@chunk_id, @strategy, @doc_id, @source, @format, @title, @section, @index, @char_start, @char_end, @token_count, @text, @content_hash)`);
  const getCached = !readonly && db.prepare("SELECT vector FROM embedding_cache WHERE content_hash = ? AND model = ? AND dtype = ? AND dims = ?");
  const putCached = !readonly && db.prepare("INSERT OR REPLACE INTO embedding_cache (content_hash, model, dtype, dims, vector) VALUES (?, ?, ?, ?, ?)");
  const insertEmbedding = !readonly && db.prepare("INSERT OR REPLACE INTO embeddings (chunk_id, vector) VALUES (?, ?)");

  const rowToChunk = ({ idx, ...row }) => ({ ...row, index: idx });

  return {
    db,
    getMeta,
    setMeta,
    close: () => db.close(),

    /** Drop everything, cache included (a rebuild re-embeds from scratch). */
    clear() {
      db.exec("DELETE FROM meta; DELETE FROM documents; DELETE FROM chunks; DELETE FROM embeddings; DELETE FROM embedding_cache;");
    },

    /**
     * Throws if this index was built with another model, dtype or dims.
     * An empty index is compatible with anything.
     */
    assertCompatible({ modelId, dtype, dims }) {
      const stored = getMeta("embedding");
      if (!stored) return;
      const diffs = [];
      if (stored.modelId !== modelId) diffs.push(`model ${stored.modelId} ≠ ${modelId}`);
      if (stored.dtype !== dtype) diffs.push(`dtype ${stored.dtype} ≠ ${dtype}`);
      if (stored.dims !== dims) diffs.push(`dims ${stored.dims} ≠ ${dims}`);
      if (diffs.length) {
        throw new IndexMismatchError(
          `the index was built with different embedding settings (${diffs.join(", ")}); refusing to mix them. Run: npm run index -- --rebuild`,
        );
      }
    },

    replaceDocuments(docs) {
      db.transaction(() => {
        db.prepare("DELETE FROM documents").run();
        const ins = db.prepare(
          "INSERT INTO documents (doc_id, collection, source, format, title, char_count, text, sections) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const d of docs) ins.run(d.doc_id, d.collection, d.source, d.format, d.title, d.text.length, d.text, JSON.stringify(d.sections));
      })();
    },

    documents: () => db.prepare("SELECT doc_id, collection, source, format, title, char_count FROM documents ORDER BY doc_id").all(),

    /** doc_id → { text, sections }, for stats that need the surrounding text. */
    documentTexts: () =>
      new Map(db.prepare("SELECT doc_id, text, sections FROM documents").all().map((d) => [d.doc_id, { text: d.text, sections: JSON.parse(d.sections) }])),

    /** Replace one strategy's chunks; embeddings of chunks that are gone go too. */
    replaceChunks(strategy, chunks) {
      db.transaction(() => {
        db.prepare("DELETE FROM embeddings WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE strategy = ?)").run(strategy);
        db.prepare("DELETE FROM chunks WHERE strategy = ?").run(strategy);
        for (const c of chunks) insertChunk.run(c);
      })();
    },

    chunks: (strategy) => db.prepare("SELECT * FROM chunks WHERE strategy = ? ORDER BY doc_id, idx").all(strategy).map(rowToChunk),

    cachedVector(hash, { modelId, dtype, dims }) {
      const row = getCached.get(hash, modelId, dtype, dims);
      return row ? fromBlob(row.vector) : null;
    },

    putVectors(entries, { modelId, dtype, dims }) {
      db.transaction(() => {
        for (const { chunk_id, content_hash, vector } of entries) {
          const blob = toBlob(vector);
          putCached.run(content_hash, modelId, dtype, dims, blob);
          insertEmbedding.run(chunk_id, blob);
        }
      })();
    },

    /**
     * One strategy's chunks with their vectors, in a stable order. Each one
     * carries its document's `collection`, so a search can be narrowed to some.
     */
    chunksWithVectors(strategy) {
      return db
        .prepare(
          `SELECT c.*, d.collection, e.vector FROM chunks c
           JOIN embeddings e ON e.chunk_id = c.chunk_id
           LEFT JOIN documents d ON d.doc_id = c.doc_id
           WHERE c.strategy = ? ORDER BY c.doc_id, c.idx`,
        )
        .all(strategy)
        .map(({ vector, ...row }) => ({ ...rowToChunk(row), vector: fromBlob(vector) }));
    },

    countChunks: () => Object.fromEntries(db.prepare("SELECT strategy, COUNT(*) AS n FROM chunks GROUP BY strategy").all().map((r) => [r.strategy, r.n])),
  };
}
