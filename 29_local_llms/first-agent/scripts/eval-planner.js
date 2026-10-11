#!/usr/bin/env node
/**
 * **Does the planner pick the right tools?** Real model, real servers.
 *
 * Plans each goal below with the same planner the app uses — the Pipeline
 * agent's model, the catalog of every server it may plan with — and compares
 * the plan's tool sequence (prompt steps as "prompt") to the expected one.
 * Prints every plan, one line per step, and exits non-zero on any mismatch or
 * on a plan that did not validate. Not part of `npm test`: it costs tokens and
 * needs the servers.
 *
 *   npm run eval:planner                 # every goal
 *   npm run eval:planner -- winner       # only goals whose id contains "winner"
 *
 * Needs ANTHROPIC_API_KEY, imdb_mcp_server (3001) and scheduler_mcp_server
 * (3002) running, and Notion connected in the app (its tokens are read from
 * data/mcp/notion.json).
 */

import { agentFor } from "../src/agents.js";
import { AnthropicProvider } from "../src/llm/anthropic.js";
import { estimateCost } from "../src/llm/pricing.js";
import { Planner, buildCatalog } from "../src/pipeline/planner.js";
import { stepName } from "../src/pipeline/validatePlan.js";
import { cliRegistry } from "./mcp-common.js";

const GOALS = [
  {
    id: "by-id",
    goal: "Get the full details of the film with IMDb id tt0133093.",
    expect: ["omdb.get_movie"],
  },
  {
    id: "search-then-details",
    goal: "Search OMDb for \"batman\" and get the full details of the first search result.",
    expect: ["omdb.search_movies", "omdb.get_movie"],
  },
  {
    id: "random-pitch",
    goal: "Pick a random well-known movie and write a two-sentence pitch for it.",
    expect: ["omdb.random_movie", "prompt"],
  },
  {
    id: "random-record",
    goal: "Pick a random well-known movie and record it in this chat's history, keyed by its IMDb id. Nothing else.",
    expect: ["omdb.random_movie", "scheduler.record"],
  },
  {
    id: "history-sentence",
    goal: "Read the numbers about what this pipeline has recorded so far and write one sentence about them.",
    expect: ["scheduler.aggregate", "prompt"],
  },
  {
    id: "notion-search",
    goal: "Search my Notion for pages about \"movie night\" and summarize what comes back in three bullet points.",
    expect: ["notion.notion-search", "prompt"],
  },
  {
    id: "review-to-notion",
    goal: "Look up The Godfather, write a one-paragraph review of it, and save the review to Notion as a new page.",
    expect: ["omdb.get_movie", "prompt", "notion.notion-create-pages"],
  },
  {
    id: "winner",
    goal:
      "Look up Inception, The Matrix and Heat. Pick the one with the highest IMDb rating, write a 3-sentence summary of it, " +
      "save the summary to Notion, and record the winner in this chat's history.",
    expect: ["omdb.get_movie", "omdb.get_movie", "omdb.get_movie", "prompt", "notion.notion-create-pages", "scheduler.record"],
  },
];

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set: the eval needs the real model.");
  process.exit(2);
}

const only = process.argv[2];
const goals = only ? GOALS.filter((each) => each.id.includes(only)) : GOALS;
const agent = agentFor("pipeline");
const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
const registry = cliRegistry();
const catalog = await buildCatalog({ registry, allow: agent.plannerTools });

console.log(`Model: ${agent.model ?? provider.model}`);
console.log(`Catalog: ${catalog.tools.length} tools — ${catalog.tools.map((tool) => tool.name).join(", ")}`);
for (const { server, error } of catalog.down) console.log(`⚠️  ${server} is down: ${error}`);
console.log("");

// The catalog is read once: every goal is planned against the same one.
const planner = new Planner({ provider, model: agent.model, catalog: async () => catalog });
const sequence = (steps) => steps.map((step) => (step?.kind === "tool" ? `${step.server}.${step.tool}` : "prompt"));

let failures = 0;
const usage = { inputTokens: 0, outputTokens: 0 };
for (const { id, goal, expect } of goals) {
  let result;
  try {
    result = await planner.propose({ goal });
  } catch (err) {
    failures += 1;
    console.log(`✗ ${id}: the planner call failed: ${err?.message ?? err}\n`);
    continue;
  }
  usage.inputTokens += result.usage.inputTokens;
  usage.outputTokens += result.usage.outputTokens;
  const got = sequence(result.steps);
  const matches = result.ok && got.length === expect.length && got.every((name, i) => name === expect[i]);
  if (!matches) failures += 1;

  console.log(`${matches ? "✓" : "✗"} ${id}${result.attempts === 2 ? " (after one retry)" : ""}`);
  console.log(`  goal:     ${goal}`);
  console.log(`  expected: ${expect.join(" → ")}`);
  console.log(`  got:      ${got.join(" → ") || "(nothing)"}`);
  result.steps.forEach((step, i) => {
    const body = step?.kind === "tool" ? JSON.stringify(step.args ?? {}) : JSON.stringify(step?.text ?? "");
    console.log(`    ${i + 1}. ${stepName(step)} ${clip(body, 160)}`);
    if (step?.format === "json") console.log(`       returns ${Object.keys(step.outputSchema?.properties ?? {}).join(", ")}`);
    if (step?.why) console.log(`       why: ${step.why}`);
  });
  for (const error of result.firstErrors) console.log(`  first attempt: ${error}`);
  if (result.notes) console.log(`  notes: ${result.notes}`);
  for (const error of result.errors) console.log(`  invalid: ${error}`);
  console.log("");
}

const cost = estimateCost({ model: agent.model ?? provider.model, ...usage });
console.log(`${goals.length - failures}/${goals.length} matched · ${usage.inputTokens} in / ${usage.outputTokens} out tokens${cost.totalCost != null ? ` · ≈$${cost.totalCost.toFixed(4)}` : ""}`);
await registry.closeAll();
process.exit(failures ? 1 : 0);

function clip(text, limit) {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
}
