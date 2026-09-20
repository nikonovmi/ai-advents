#!/usr/bin/env node
/**
 * **The task lifecycle, walked end to end.**
 *
 * `scripts/scenario.js` answers "which strategy remembers the most, and what
 * did it cost" — every strategy, the same fifteen messages, recall scored at
 * the end. This one answers a different question, about one strategy: *does
 * the state machine actually do anything?*
 *
 * So a step here is either something said or a button pressed, and the run
 * prints what the machine did with it: the guard that refused an edge before
 * there was a goal, the goal freezing on the way out of planning, the model
 * proposing a transition that nothing applies, validation sending the work
 * back to execution, and the promotion call firing exactly once on the way
 * into `done`.
 *
 *   npm run lifecycle                  # needs a key to be interesting
 *   npm run lifecycle -- --fake        # offline, the machine still runs
 *   npm run lifecycle -- --blocks      # print the <working> block every turn
 *
 * The transitions go through the same path the buttons do — read the record,
 * hand the state to a strategy that holds no conversation, write the record
 * back, drop the cached agent — because a demo that reached past the routes
 * into the agent's own state would be demonstrating something the app does
 * not do.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";

import { Agent, personas } from "../src/agent.js";
import { createStrategy } from "../src/context/index.js";
import { STAGES } from "../src/context/taskState.js";
import { AnthropicProvider, FakeProvider } from "../src/llm/anthropic.js";
import { getBranchHistory } from "../src/store/branches.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { MemoryProfileStore } from "../src/store/profileStore.js";

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const ESC = String.fromCharCode(27);
const bold = (text) => (COLOUR ? `${ESC}[1m${text}${ESC}[0m` : text);
const dim = (text) => (COLOUR ? `${ESC}[2m${text}${ESC}[0m` : text);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = path.join(__dirname, "..", "scenarios");
const SESSION = "00000000-0000-4000-8000-000000000002";
const BRANCH = "main";

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}

const scenario = await loadScenario(options.scenario);
const provider = createProvider(options);
const store = new MemoryStore();
// Long-term memory outlives a conversation, so the demo gets its own rather
// than promoting this run's decisions into the profile you actually use.
const profileStore = new MemoryProfileStore();

console.log(`\n${bold(scenario.title)} — ${scenario.steps.length} steps`);
console.log(
  dim(
    `provider: ${provider.model}` +
      (provider instanceof FakeProvider ? " (offline — reflects context, does not reason)" : "")
  )
);
console.log(dim(scenario.description ?? ""));
if (provider instanceof FakeProvider && scenario.offlineNote) console.log(dim(scenario.offlineNote));

/** Every expectation the scenario stated that the machine did not meet. */
const broken = [];
let promotionCalls = 0;

for (const [index, step] of scenario.steps.entries()) {
  const number = String(index + 1).padStart(2, " ");
  if (step.note) console.log(`\n${dim("· " + step.note)}`);

  if (typeof step.say === "string") await said(number, step);
  else await pressed(number, step);
}

await report();

// ---- the two kinds of step -------------------------------------------------

/** A turn: the user says something and the agent answers. */
async function said(number, step) {
  console.log(`\n${bold(number + "  you")} ${step.say}`);

  const agent = await load();
  let meta;
  try {
    ({ meta } = await agent.run(step.say));
  } catch (err) {
    console.log("    " + (err?.message ?? String(err)));
    broken.push(`step ${number} failed: ${err?.message ?? err}`);
    return;
  }

  const life = meta.strategy.panel?.lifecycle;
  console.log(dim(`    ${stageBar(life)}   step: ${life?.step ?? "—"}`));
  console.log(dim(`    awaiting: ${who(life)}`));
  if (meta.strategy.note) console.log(dim("    memory: " + meta.strategy.note));

  // The interesting refusal, called out rather than left in a note: the
  // extractor proposed a new goal and the freeze turned it into a proposal.
  for (const proposal of pendingCorrections(meta.strategy.panel)) {
    console.log(
      dim(`    held back (${proposal.reason}): ${proposal.key} — “${proposal.value}”, still “${proposal.was}”`)
    );
  }
  if (life?.suggestion) {
    console.log(dim(`    the agent suggests → ${life.suggestion.to}: ${life.suggestion.reason ?? "no reason given"}`));
  }
  if (options.blocks) printBlock(await workingBlockOf());

  // The offline extractor turns every message into a `decision.*` key and can
  // produce no `goal` at all, so with `--fake` the scenario types the keys in
  // by hand — through `applyPanelOps`, which is the path the panel's own
  // buttons take and is marked as person-originated. Nothing is pretended: it
  // is printed, and with a key it never runs.
  if (options.fake && step.offline?.length) await typedIn(step.offline);
}

/** What a person typing into the panel does, as the route does it. */
async function typedIn(ops) {
  const strategy = createStrategy("memory", { profileStore });
  const record = await store.load(SESSION);
  const branch = record.branches[BRANCH];
  const history = getBranchHistory(record, BRANCH);
  const applied = await strategy.applyPanelOps({
    state: branch.strategyState?.memory ?? strategy.emptyState(),
    ops,
    turns: history.filter((message) => message.role === "user").length,
  });

  branch.strategy = "memory";
  branch.strategyState = { ...branch.strategyState, memory: applied.state };
  await store.save(SESSION, record.messages, record.usage, {
    branches: record.branches,
    activeBranchId: record.activeBranchId,
  });
  console.log(dim(`    offline: typed in by hand — ${ops.map((op) => op.key).join(", ")}`));
}

/** A click: one edge of the machine, through the path the route takes. */
async function pressed(number, step) {
  const strategy = createStrategy("memory", { profileStore });
  const record = await store.load(SESSION);
  const branch = record?.branches?.[BRANCH];
  const state = branch?.strategyState?.memory ?? strategy.emptyState();
  const history = record ? getBranchHistory(record, BRANCH) : [];

  const before = strategy.panel(state, { turns: Infinity }).lifecycle.stage;
  const moved = await strategy.transition({
    state,
    to: step.transition,
    by: "user",
    reason: step.reason ?? "",
    history,
    provider,
  });
  if (moved.proposals?.length) promotionCalls += 1;

  const verdict = moved.ok ? (moved.awaitingBrief ? "brief written" : "moved") : "refused";
  console.log(`\n${bold(number + "  click")} → ${step.transition}   ${moved.ok ? "" : dim("(refused)")}`);
  console.log(dim(`    ${verdict}: ${moved.note}`));

  if (!moved.ok) {
    // The state must be exactly what it was. That is the claim being made by
    // "discarded and logged, never coerced to a nearby valid state".
    const after = strategy.panel(moved.state, { turns: Infinity }).lifecycle.stage;
    if (after !== before) broken.push(`step ${number}: a refused edge moved the stage to ${after}`);
    console.log(dim(`    still in ${after}`));
  }
  if (step.expect === "refused" && moved.ok) broken.push(`step ${number}: ${step.transition} was expected to be refused`);
  if (step.expect !== "refused" && !moved.ok) broken.push(`step ${number}: ${step.transition} was refused — ${moved.note}`);

  if (moved.warning) console.log(dim("    warning (not a block): " + moved.warning));
  for (const proposal of moved.proposals ?? []) {
    console.log(dim(`    proposed for long-term: ${proposal.key} — “${proposal.value}”`));
  }

  let next = moved.state;

  // **Leaving planning is two steps, and the second one is a person.** The
  // click wrote a brief; accepting it is what actually moves the stage and
  // drops the planning conversation off the wire. The demo prints the brief
  // in full, because a handoff nobody read is the failure this step exists to
  // prevent and a demo that skipped past it would be hiding the interesting
  // part.
  if (moved.awaitingBrief) {
    const brief = strategy.panel(next, { turns: Infinity }).lifecycle.brief;
    console.log(dim("    ┌─ the brief, as written ─────────────────────────────"));
    for (const line of brief.text.split("\n")) console.log(dim("    │ " + line));
    console.log(dim("    └─────────────────────────────────────────────────────"));

    const accepted = await strategy.answerBrief({ state: next, history, action: "accept" });
    if (!accepted.ok) broken.push(`step ${number}: the brief was written but could not be accepted — ${accepted.note}`);
    next = accepted.state;
    console.log(dim(`    accepted: ${accepted.note}`));
    if (accepted.warning) console.log(dim("    warning (not a block): " + accepted.warning));
  }

  // Persist it and drop nothing: the next `load()` reads this back, which is
  // the server's `invalidate` doing its job.
  if (record) {
    branch.strategy = "memory";
    branch.strategyState = { ...branch.strategyState, memory: next };
    await store.save(SESSION, record.messages, record.usage, {
      branches: record.branches,
      activeBranchId: record.activeBranchId,
    });
  }

  const life = strategy.panel(next, { turns: Infinity }).lifecycle;
  console.log(dim(`    ${stageBar(life)}   step: ${life.step}`));
  console.log(dim(`    awaiting: ${who(life)}`));
}

// ---- the end -----------------------------------------------------------------

async function report() {
  const strategy = createStrategy("memory", { profileStore });
  const record = await store.load(SESSION);
  const state = record.branches[BRANCH].strategyState.memory;
  const panel = strategy.panel(state, { turns: Infinity });
  const life = panel.lifecycle;

  console.log(`\n${bold("The transition log")} ${dim("— append-only; the stage is the last line of it")}`);
  for (const entry of life.log) {
    console.log(
      `  ${entry.from} → ${bold(entry.to)}` +
        dim(`  after turn ${entry.turn} · by ${entry.by}${entry.reason ? " · " + entry.reason : ""}`)
    );
  }
  if (life.refused.length) {
    console.log(`\n${bold("Refused")} ${dim("— discarded and logged, never coerced")}`);
    for (const row of life.refused) console.log(dim(`  ${row.from} → ${row.to}: ${row.reason}`));
  }

  // The banner the UI draws on reopening a mid-flight task, composed from
  // stored state with no model call. Printing it here is the whole proof: the
  // same three fields, read back out of the store.
  console.log(`\n${bold("Resume")} ${dim("— composed from state, no model call")}`);
  console.log(`  You were here — ${life.stage}${life.updatedAt ? dim(" · " + life.updatedAt) : ""}`);
  console.log(`  in progress: ${life.step}`);
  console.log(`  next: ${who(life)}`);

  console.log(`\n${bold("Closed tasks")}`);
  for (const past of panel.pastTasks) {
    const route = [past.transitions[0]?.from, ...past.transitions.map((entry) => entry.to)].filter(Boolean);
    console.log(
      `  turn ${past.turn} · ${past.stage} · ${past.entries.length} entries` + dim("  " + route.join(" → "))
    );
    for (const entry of past.entries) console.log(dim(`    ${entry.key}: ${entry.value}`));
  }
  const pending = panel.proposals.filter((p) => p.status === "pending");
  console.log(dim(`  ${pending.length} proposal${pending.length === 1 ? "" : "s"} waiting for a human`));

  if (promotionCalls !== 1) broken.push(`the promotion call fired ${promotionCalls} times, not once`);
  if (Object.keys(state.working).length) broken.push("working memory was not cleared on the way into done");

  // The one thing an offline run cannot show. The freeze is a rule about ops
  // the *extractor* emits, and the fake extractor emits a `decision.*` for
  // every message and never a `goal` — so there is nothing for the freeze to
  // refuse. Saying so is better than a run that looks complete and quietly is
  // not; the unit tests cover it, and a keyed run shows it at step 8.
  if (provider instanceof FakeProvider) {
    console.log(
      dim(
        "\noffline: the freeze is not exercised above. It refuses `goal` ops from the extractor," +
          " and the fake one never proposes a `goal`. Run with a key to see step 8 held back."
      )
    );
  }

  console.log("");
  if (broken.length) {
    console.log(bold("Not as scripted:"));
    for (const line of broken) console.log("  " + line);
    process.exitCode = 1;
  } else {
    console.log(bold("Every step did what the scenario said it would."));
  }
  console.log("");
}

// ---- helpers ------------------------------------------------------------------

/** `● ● ○ ○  validation` — the strip, in a terminal. */
function stageBar(life) {
  const current = STAGES.indexOf(life?.stage ?? "planning");
  return STAGES.map((_, index) => (index < current ? "●" : index === current ? "◉" : "○")).join(" ") +
    "  " + (life?.stage ?? "planning");
}

function who(life) {
  const actor = life?.expectedAction?.actor === "agent" ? "the agent" : "you";
  return `${actor}${life?.expectedAction?.what ? " — " + life.expectedAction.what : ""}`;
}

function pendingCorrections(panel) {
  return (panel?.proposals ?? []).filter((p) => p.status === "pending" && p.kind === "correction");
}

/** The exact `<working>` block the last turn sent, pulled back out of state. */
async function workingBlockOf() {
  const record = await store.load(SESSION);
  const state = record?.branches?.[BRANCH]?.strategyState?.memory;
  if (!state) return "";
  const { workingBlock } = await import("../src/context/memory.js");
  return workingBlock(state.working, state.task);
}

function printBlock(block) {
  for (const line of String(block).split("\n").filter(Boolean)) console.log(dim("    | " + line));
}

/**
 * A fresh agent off the store for every turn.
 *
 * The server caches one per session and drops it whenever a memory route
 * writes; loading every time is the same thing said more simply, and it is
 * what makes a transition taken between two turns actually reach the next one.
 */
function load() {
  return Agent.load({
    provider,
    store,
    sessionId: SESSION,
    systemPrompt: personas.helpful,
    contextMessages: options.window,
    maxTokens: options.maxTokens,
    temperature: 0,
    strategy: "memory",
    strategyOptions: { profileStore },
  });
}

function createProvider({ fake }) {
  const apiKey = fake ? null : process.env.ANTHROPIC_API_KEY;
  if (apiKey) return new AnthropicProvider({ apiKey, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
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
  if (!Array.isArray(data.steps)) {
    console.error("A lifecycle scenario needs a 'steps' array of { say } and { transition } entries.");
    process.exit(1);
  }
  return data;
}

function parseArgs(argv) {
  const parsed = {
    scenario: "migration-lifecycle",
    window: 10,
    maxTokens: 1024,
    fake: false,
    blocks: false,
    help: false,
  };

  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    switch (key) {
      case "scenario":
        parsed.scenario = value;
        break;
      case "window":
        parsed.window = Math.max(1, Number(value) || 10);
        break;
      case "max-tokens":
        parsed.maxTokens = Math.max(1, Number(value) || 1024);
        break;
      case "fake":
        parsed.fake = true;
        break;
      case "blocks":
        parsed.blocks = true;
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
Usage: npm run lifecycle -- [options]

  --scenario=<name>  A file in scenarios/, or a path   (default: migration-lifecycle)
  --window=<n>       Exchanges in the window           (default: 10)
  --max-tokens=<n>   Reply ceiling                     (default: 1024)
  --fake             Force the offline provider even with a key set
  --blocks           Print the <working> block after every turn
`);
}
