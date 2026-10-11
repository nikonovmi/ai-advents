import fs from "node:fs";

import { OllamaError } from "../src/ollama.js";

/** Load local_llm/.env if there is one (Node's built-in loader, no dotenv). */
export function loadEnv() {
  const path = new URL("../.env", import.meta.url);
  if (fs.existsSync(path)) process.loadEnvFile(path);
}

/** `--flag`, `--key value`, and the rest as positionals. */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) positionals.push(a);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  }
  return { flags, positionals };
}

/** Run `main`, printing an OllamaError as a readable message instead of a stack trace. */
export function runMain(main) {
  main().catch((err) => {
    if (err instanceof OllamaError) {
      console.error(`\n✗ ${err.message}`);
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  });
}
