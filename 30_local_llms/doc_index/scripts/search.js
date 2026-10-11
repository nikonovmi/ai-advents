import { STRATEGIES } from "../src/config.js";
import { search } from "../src/search.js";
import { parseArgs } from "./args.js";

/** `npm run search -- "query" [--strategy structural] [--k 5]` */
const { flags, positionals } = parseArgs();
const query = positionals.join(" ").trim();
if (!query) {
  console.error('usage: npm run search -- "query" [--strategy fixed|structural] [--k 5]');
  process.exit(1);
}
const strategies = flags.strategy ? [flags.strategy] : STRATEGIES;
const k = Number(flags.k ?? 5);
for (const strategy of strategies) {
  console.log(`\n## ${strategy} — "${query}"`);
  for (const [i, hit] of (await search(query, { strategy, k })).entries()) {
    console.log(`\n${i + 1}. ${hit.score.toFixed(3)}  ${hit.source}${hit.section ? `  ›  ${hit.section}` : ""}`);
    console.log(`   ${hit.text.replace(/\s+/g, " ").slice(0, 200)}`);
  }
}
