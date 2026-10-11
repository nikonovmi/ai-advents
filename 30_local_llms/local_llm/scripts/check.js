import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { pickModels } from "../src/bench.js";
import { createOllama, OllamaError, pullHint } from "../src/ollama.js";
import { loadEnv, parseArgs, runMain } from "./common.js";

/**
 * npm run check [-- --model qwen3.5:9b]
 *
 * Is Ollama up (HTTP API and CLI), are the models installed, and does each
 * one answer a "say OK" request?
 */

loadEnv();
const { flags } = parseArgs();

async function cliVersion() {
  try {
    const { stdout } = await promisify(execFile)("ollama", ["--version"]);
    return stdout.trim().split("\n").at(-1);
  } catch {
    return null;
  }
}

runMain(async () => {
  const ollama = createOllama();

  const version = await ollama.version();
  console.log(`✓ Ollama ${version} is running at ${ollama.url} (HTTP API)`);
  const cli = await cliVersion();
  console.log(cli ? `✓ CLI: ${cli}` : "• CLI: `ollama` is not on PATH (the HTTP API is enough for this project)");

  const installed = await ollama.list();
  console.log(`✓ ${installed.length} model(s) installed: ${installed.map((m) => m.name).join(", ") || "none"}`);

  const { models, missing } = pickModels(installed, { model: flags.model });
  for (const name of missing) console.log(`✗ ${name} is not installed. Pull it with \`${pullHint(name)}\`.`);
  if (!models.length && !missing.length) {
    console.log("✗ No gemma4 / qwen3.5 model is installed. Pull one, e.g. `ollama pull qwen3.5:9b`, or set LOCAL_MODELS.");
  }

  let failures = missing.length + (models.length || missing.length ? 0 : 1);
  for (const model of models) {
    try {
      const res = await ollama.chat({ model, messages: [{ role: "user", content: "Say OK and nothing else." }], num_predict: 8 });
      const m = res.metrics;
      const ok = /\bok\b/i.test(res.text);
      if (!ok) failures++;
      console.log(
        `${ok ? "✓" : "✗"} ${model}: "${res.text.trim()}" · load ${(m.load_ms / 1000).toFixed(1)} s · TTFT ${(m.ttft_ms / 1000).toFixed(2)} s · total ${(m.total_ms / 1000).toFixed(2)} s`,
      );
    } catch (err) {
      if (!(err instanceof OllamaError)) throw err;
      failures++;
      console.log(`✗ ${model}: ${err.message}`);
    }
    await ollama.unload(model).catch(() => {});
  }

  if (failures) {
    console.log(`\n${failures} problem(s).`);
    process.exitCode = 1;
  } else {
    console.log("\nAll good: the models run locally and answer over the HTTP API.");
  }
});
