/**
 * **Check every id in src/top500.js against OMDb.** Manual only.
 *
 *   npm run validate:top500            # all 500
 *   npm run validate:top500 -- 0 50    # a slice: start, count
 *
 * ⚠️  QUOTA: this makes one OMDb request per film — about 500 of the FREE
 * tier's 1,000 requests a day. It is deliberately not part of `npm test` and
 * never runs on start. Run it after editing the list, not casually.
 *
 * For each id it reports one of: ok, not found (a bad id), not a movie (a
 * series or an episode), or a title/year that disagrees with the comment in
 * the list — which usually means the id points at a different film. Exits 1
 * if anything is bad, so it can gate a commit.
 */
import path from "node:path";

import dotenv from "dotenv";

import { createOmdbClient } from "../src/omdbClient.js";
import { TOP500 } from "../src/top500.js";

dotenv.config({ path: path.join(import.meta.dirname, "..", ".env"), quiet: true });

const start = Number(process.argv[2] ?? 0);
const count = Number(process.argv[3] ?? TOP500.length);
const slice = TOP500.slice(start, start + count);
/** Spaced out a little: OMDb is a free service, and a burst of 500 is rude. */
const GAP_MS = 120;

const omdb = createOmdbClient();
const norm = (text) => String(text ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

console.log(`Checking ${slice.length} ids (${start}–${start + slice.length - 1}) against OMDb — ${slice.length} requests of your daily 1,000.`);

const bad = [];
for (const [i, entry] of slice.entries()) {
  const at = start + i;
  let verdict = "ok";
  try {
    const data = await omdb.byId(entry.imdbId);
    const year = Number.parseInt(data.Year, 10);
    if (data.Type !== "movie") verdict = `not a movie (${data.Type})`;
    else if (!norm(data.Title).includes(norm(entry.title)) && !norm(entry.title).includes(norm(data.Title))) verdict = `title is "${data.Title}"`;
    else if (Math.abs(year - entry.year) > 1) verdict = `year is ${data.Year}`;
  } catch (err) {
    if (err.kind === "config" || err.kind === "network") {
      console.error(err.message);
      process.exit(2);
    }
    verdict = err.message;
  }
  if (verdict !== "ok") {
    bad.push({ at, ...entry, verdict });
    console.log(`✗ #${at} ${entry.imdbId} ${entry.title} (${entry.year}): ${verdict}`);
  } else if ((i + 1) % 50 === 0) {
    console.log(`  … ${i + 1}/${slice.length}`);
  }
  await new Promise((resolve) => setTimeout(resolve, GAP_MS));
}

console.log(bad.length ? `\n${bad.length} bad of ${slice.length}.` : `\nAll ${slice.length} ok.`);
process.exit(bad.length ? 1 : 0);
