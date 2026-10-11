import crypto from "node:crypto";

import { formatDocument } from "../embed.js";
import { chunkFixed } from "./fixed.js";
import { chunkStructural } from "./structural.js";

/**
 * **Both strategies behind one call, and the chunk record they share.**
 *
 * ```js
 * { chunk_id, strategy, doc_id, source, format, title, section, index,
 *   char_start, char_end, token_count, text, content_hash }
 * ```
 *
 * `chunk_id` is `${doc_id}:${strategy}:${index}`, so it is stable as long as
 * the document and the chunker config are. `content_hash` is the sha256 of the
 * exact string the embedder receives (`title: … | text: …`, the same rule for
 * both strategies); the section breadcrumb is metadata only and never embedded.
 */

export const CHUNKERS = { fixed: chunkFixed, structural: chunkStructural };

export const contentHash = (title, text) => crypto.createHash("sha256").update(formatDocument({ title, text })).digest("hex");

export function chunkDocument(doc, tokenizer, strategy, config) {
  const chunker = CHUNKERS[strategy];
  if (!chunker) throw new Error(`unknown strategy "${strategy}" (${Object.keys(CHUNKERS).join(", ")})`);
  return chunker(doc, tokenizer, config[strategy]).map((c, index) => ({
    chunk_id: `${doc.doc_id}:${strategy}:${index}`,
    strategy,
    doc_id: doc.doc_id,
    source: doc.source,
    format: doc.format,
    title: doc.title,
    section: c.section,
    index,
    char_start: c.char_start,
    char_end: c.char_end,
    token_count: c.token_count,
    text: c.text,
    content_hash: contentHash(doc.title, c.text),
  }));
}
