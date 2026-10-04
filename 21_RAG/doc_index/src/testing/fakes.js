import crypto from "node:crypto";

import { createEmbedder } from "../embed.js";

/**
 * **Stand-ins for the model, so tests never download or load it.**
 *
 * The tokenizer counts whitespace-separated words. The embedder hashes each
 * string into a deterministic vector, behind the real `createEmbedder` (same
 * prefixes, truncation and normalisation), and records what it was asked to
 * embed so tests can see the cache at work.
 */

export const fakeTokenizer = { count: (text) => (text.match(/\S+/g) ?? []).length };

export function fakeEmbedder({ modelId = "fake-model", dtype = "q8", dims = 16, batchSize = 4 } = {}) {
  const calls = [];
  const embedRaw = async (strings) => {
    calls.push(...strings);
    return strings.map((s) => {
      const out = [];
      for (let i = 0; out.length < 32; i++) {
        for (const byte of crypto.createHash("sha256").update(`${i}:${s}`).digest()) out.push(byte / 255 - 0.5);
      }
      return out.slice(0, 32);
    });
  };
  return Object.assign(createEmbedder({ modelId, dtype, dims, batchSize, tokenizer: fakeTokenizer, embedRaw }), { calls });
}
