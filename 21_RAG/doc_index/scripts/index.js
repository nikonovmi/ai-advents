import { STRATEGIES, embedSettings } from "../src/config.js";
import { loadCorpus } from "../src/corpus.js";
import { loadEmbedder } from "../src/embed.js";
import { buildIndex } from "../src/indexer.js";
import { IndexMismatchError, openStore } from "../src/store.js";
import { parseArgs } from "./args.js";

/** `npm run index [-- --rebuild] [-- --strategy fixed]`: load, chunk, embed, store. */
const { flags } = parseArgs();
const strategies = flags.strategy ? [flags.strategy] : STRATEGIES;
for (const s of strategies) if (!STRATEGIES.includes(s)) throw new Error(`unknown strategy "${s}" (${STRATEGIES.join(", ")})`);

const settings = embedSettings();
const store = openStore();
try {
  if (!flags.rebuild) store.assertCompatible(settings);
  const { documents } = await loadCorpus();
  console.log(`loaded ${documents.length} documents; loading ${settings.modelId} (${settings.dtype}, ${settings.dims} dims)…`);
  const embedder = await loadEmbedder(settings);
  await buildIndex({ documents, embedder, store, strategies, rebuild: Boolean(flags.rebuild) });
} catch (err) {
  if (!(err instanceof IndexMismatchError)) throw err;
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
} finally {
  store.close();
}
