import { gatherCorpus } from "../src/corpus.js";

/** `npm run fetch [-- --force]`: download the PDF, copy our project files. */
await gatherCorpus({ force: process.argv.includes("--force") });
