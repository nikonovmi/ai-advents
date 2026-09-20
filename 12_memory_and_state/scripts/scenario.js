#!/usr/bin/env node
/**
 * The scripted comparison.
 *
 * A scenario is fifteen user messages with five checkable facts planted in the
 * first five of them, a run of unrelated turns on top, and a final message
 * asking for all five back. Each strategy answers exactly the same fifteen
 * messages in exactly the same order, and the only thing that differs is what
 * it chose to put in front of the model.
 *
 *   npm run scenario -- --strategy=facts --window=10
 *   npm run scenario -- --all
 *   npm run scenario -- --all --fake        # offline, no key
 *
 * With no `ANTHROPIC_API_KEY` it runs against `FakeProvider`, which reflects
 * its context rather than reasoning about it. That still measures the thing the
 * strategies actually differ on — whether a fact reached the payload at all —
 * but it is an upper bound on recall, never a prediction of it. The numbers in
 * the README come from a keyed run.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";

import { Agent, personas } from "../src/agent.js";
import { STRATEGY_IDS, createStrategy } from "../src/context/index.js";
import { AnthropicProvider, FakeProvider } from "../src/llm/anthropic.js";
import { formatTokens } from "../src/llm/pricing.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { MemoryProfileStore } from "../src/store/profileStore.js";

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const ESC = String.fromCharCode(27);
const bold = (text) => (COLOUR ? `${ESC}[1m${text}${ESC}[0m` : text);
const dim = (text) => (COLOUR ? `${ESC}[2m${text}${ESC}[0m` : text);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = path.join(__dirname, "..", "scenarios");
const SESSION = "00000000-0000-4000-8000-000000000001";

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}

const scenario = await loadScenario(options.scenario);
const provider = createProvider(options);
const wanted = options.all ? STRATEGY_IDS : [options.strategy];

if (!wanted.every((id) => STRATEGY_IDS.includes(id))) {
  console.error(`Unknown strategy. Expected one of: ${STRATEGY_IDS.join(", ")}.`);
  process.exit(1);
}

console.log(`\n${bold(scenario.title)} — ${scenario.messages.length} turns, window ${options.window}`);
console.log(
  dim(
    `provider: ${provider.model}` +
      (provider instanceof FakeProvider ? " (offline — reflects context, does not reason)" : "")
  )
);

// Each strategy gets its own store and its own agent, so the four runs cannot
// see each other. They run concurrently because they are genuinely independent
// and fifteen turns four times over is a long wait otherwise.
const runs = await Promise.all(wanted.map((id) => runStrategy(id)));

for (const run of runs) {
  if (!options.all || options.verbose) printTurns(run);
}
if (runs.length > 1) printComparison(runs);
printAnswers(runs);
if (options.json) {
  console.log(JSON.stringify({ scenario: scenario.id, window: options.window, runs }, null, 2));
}

// ---- the run ---------------------------------------------------------------

/**
 * One strategy, every turn, nothing shared with any other run.
 *
 * A turn that fails is recorded and the run stops there: one arm falling over
 * is a result, and it should not take the comparison down with it.
 */
async function runStrategy(id) {
  const agent = new Agent({
    provider,
    store: new MemoryStore(),
    sessionId: SESSION,
    systemPrompt: personas.helpful,
    contextMessages: options.window,
    maxTokens: options.maxTokens,
    temperature: 0,
    strategy: id,
    // Long-term memory is the one store that outlives a conversation, so the
    // run gets its own. Sharing the real one would mean the second run of the
    // day started with the first one's answers already in the profile — and a
    // comparison that leaks between arms is not a comparison.
    strategyOptions: { profileStore: new MemoryProfileStore() },
  });

  const label = createStrategy(id).label;
  const turns = [];
  let finalReply = "";
  let error = null;

  for (const [index, message] of scenario.messages.entries()) {
    try {
      const { text, meta } = await agent.run(message);
      finalReply = text;
      turns.push({
        turn: index + 1,
        input: meta.tokens.input,
        output: meta.tokens.output,
        overheadTokens: meta.strategy.overheadTokens ?? 0,
        overheadCalls: meta.strategy.overheadCalls ?? 0,
        blockTokens: meta.strategy.blockTokens ?? 0,
        cost: meta.cost.total,
        overheadCost: meta.strategy.overheadCost,
        note: meta.strategy.note,
      });
    } catch (err) {
      error = err?.message ?? String(err);
      break;
    }
  }

  const usage = agent.usage;
  // A strategy that runs more than one schedule reports them apart. The
  // Agent's own total is right for comparing strategies and useless for tuning
  // one: it cannot tell you whether the bill is the per-turn call or the fold.
  const split = agent.panel()?.usage ?? null;
  return {
    id,
    label,
    error,
    split,
    turns,
    reply: finalReply,
    recall: score(finalReply),
    usage,
    conversationCost: usage.totalCostUsd,
    overheadCost: usage.overheadCostUsd,
    allInCost: usage.totalCostUsd + usage.overheadCostUsd,
    overheadCalls: usage.overheadCalls,
    overheadTokens: usage.overheadInputTokens + usage.overheadOutputTokens,
  };
}

/**
 * Recall, by substring, out of five.
 *
 * A blunt instrument, and the right one: the things being checked are a port
 * number and a surname. Either the model had them in front of it and said
 * them, or it did not.
 */
function score(reply) {
  const text = String(reply ?? "").toLowerCase();
  const hits = scenario.checks.filter((check) => text.includes(check.expect.toLowerCase()));
  return {
    hits: hits.length,
    of: scenario.checks.length,
    missed: scenario.checks.filter((check) => !hits.includes(check)).map((check) => check.label),
  };
}

// ---- output ----------------------------------------------------------------

function printTurns(run) {
  console.log(`\n${bold(run.label)} ${dim(`(${run.id})`)}`);
  console.log(
    dim(
      pad("turn", 5) +
        pad("in", 9) +
        pad("out", 8) +
        pad("overhead", 12) +
        pad("cumulative", 12) +
        "what the strategy did"
    )
  );

  let cumulative = 0;
  for (const turn of run.turns) {
    cumulative += (turn.cost ?? 0) + (turn.overheadCost ?? 0);
    const overhead = turn.overheadTokens
      ? `${formatTokens(turn.overheadTokens)} (${turn.overheadCalls})`
      : "—";
    console.log(
      pad(String(turn.turn), 5) +
        pad(formatTokens(turn.input), 9) +
        pad(formatTokens(turn.output), 8) +
        pad(overhead, 12) +
        pad(money(cumulative), 12) +
        dim(turn.note ?? "")
    );
  }
  if (run.error) console.log("  " + run.error);
}

function printComparison(runs) {
  console.log(`\n${bold("Comparison")} — window ${options.window}, ${scenario.messages.length} turns\n`);
  const header =
    pad("strategy", 17) +
    pad("recall", 9) +
    pad("conversation", 14) +
    pad("overhead", 12) +
    pad("all-in", 12) +
    pad("calls", 7) +
    "overhead tokens";
  console.log(dim(header));
  console.log(dim("-".repeat(header.length)));

  for (const run of runs) {
    console.log(
      pad(run.label, 17) +
        pad(`${run.recall.hits}/${run.recall.of}`, 9) +
        pad(money(run.conversationCost), 14) +
        pad(run.overheadCalls ? money(run.overheadCost) : "—", 12) +
        pad(money(run.allInCost), 12) +
        pad(String(run.overheadCalls), 7) +
        (run.overheadTokens ? formatTokens(run.overheadTokens) : "—")
    );
  }

  for (const run of runs) {
    // Not every bucket is a call. The profile block is input tokens in the
    // turn's own request, counted per turn, and a filter that only knows about
    // calls would drop the one figure that is paid on every single turn.
    const parts = Object.entries(run.split ?? {}).filter(([, bill]) => bill?.calls || bill?.turns);
    if (parts.length < 2) continue;
    console.log(
      dim(
        `  ${run.label}: ` +
          parts
            .map(([name, bill]) => {
              const unit = bill.calls ? `${bill.calls} calls` : `${bill.turns} turns`;
              const tokens = formatTokens(bill.inputTokens + bill.outputTokens);
              return `${name.replace("overhead", "").toLowerCase()} ${unit} / ${tokens} tokens${bill.estimated ? " (est)" : ""} / ${money(bill.costUsd)}`;
            })
            .join(" · ")
      )
    );
  }

  const floor = runs.find((r) => r.id === "sliding");
  const ceiling = runs.find((r) => r.id === "full");
  if (floor && ceiling) {
    console.log(
      dim(
        `\nThe floor is ${money(floor.allInCost)} at ${floor.recall.hits}/${floor.recall.of}; ` +
          `the ceiling is ${money(ceiling.allInCost)} at ${ceiling.recall.hits}/${ceiling.recall.of}. ` +
          "Everything between them is buying recall with money."
      )
    );
  }
}

function printAnswers(runs) {
  console.log(`\n${bold("Asked for the five facts back")}`);
  for (const run of runs) {
    console.log(`\n${bold(run.label)} ${dim(`${run.recall.hits}/${run.recall.of}`)}`);
    if (run.recall.missed.length) console.log(dim("  missed: " + run.recall.missed.join(", ")));
    console.log("  " + String(run.reply ?? "(nothing)").replace(/\n/g, "\n  ").trim());
  }
  console.log("");
}

/**
 * Money, to five places.
 *
 * `formatCost` drops to two decimals above a cent, which is right in the UI
 * and wrong here: the four runs of this table differ in the fourth decimal,
 * and rounding them all to `$0.03` would delete the entire comparison. An
 * unpriced model gives counts and no dollars, which is not the same as free.
 */
function money(usd) {
  return usd ? "$" + usd.toFixed(5) : "—";
}

function pad(text, width) {
  const value = String(text);
  return value.length >= width ? value + " " : value + " ".repeat(width - value.length);
}

// ---- setup -----------------------------------------------------------------

function createProvider({ fake }) {
  const apiKey = fake ? null : process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return new AnthropicProvider({ apiKey, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
  }
  // Zero delay: the point of the offline run is that it finishes.
  return new FakeProvider({ delayMs: 0 });
}

async function loadScenario(name) {
  const file = name.endsWith(".json") ? name : path.join(SCENARIO_DIR, name + ".json");
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  if (!raw) {
    console.error(`Could not read the scenario at ${file}.`);
    process.exit(1);
  }
  const data = JSON.parse(raw);
  if (!Array.isArray(data.messages) || !Array.isArray(data.checks)) {
    console.error("A scenario needs a 'messages' array and a 'checks' array.");
    process.exit(1);
  }
  return data;
}

function parseArgs(argv) {
  const parsed = {
    strategy: "facts",
    window: 10,
    maxTokens: 1024,
    scenario: "requirements-gathering",
    all: false,
    fake: false,
    json: false,
    verbose: false,
    help: false,
  };

  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    switch (key) {
      case "strategy":
        parsed.strategy = value;
        break;
      case "window":
        parsed.window = Math.max(1, Number(value) || 10);
        break;
      case "max-tokens":
        parsed.maxTokens = Math.max(1, Number(value) || 1024);
        break;
      case "scenario":
        parsed.scenario = value;
        break;
      case "all":
        parsed.all = true;
        break;
      case "fake":
        parsed.fake = true;
        break;
      case "json":
        parsed.json = true;
        break;
      case "verbose":
        parsed.verbose = true;
        break;
      case "help":
      case "h":
        parsed.help = true;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        usage();
        process.exit(1);
    }
  }

  return parsed;
}

function usage() {
  console.log(`
Usage: npm run scenario -- [options]

  --strategy=<id>    One of: ${STRATEGY_IDS.join(", ")}   (default: facts)
  --all              Run every strategy and print the comparison table
  --window=<n>       Exchanges in the window                (default: 10)
  --max-tokens=<n>   Reply ceiling                          (default: 1024)
  --scenario=<name>  A file in scenarios/, or a path        (default: requirements-gathering)
  --fake             Force the offline provider even with a key set
  --verbose          Per-turn table for every strategy, not just single runs
  --json             Also dump the raw numbers
`);
}
