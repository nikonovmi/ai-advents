import { FactsStrategy } from "./facts.js";
import { FullHistoryStrategy } from "./fullHistory.js";
import { MemoryStrategy } from "./memory.js";
import { SlidingWindowStrategy } from "./slidingWindow.js";
import { SummarizationStrategy } from "./summarization.js";

/**
 * The registry.
 *
 * One place that knows the strategies exist. The Agent validates against it,
 * the routes validate against it, the UI is built from it and the scenario
 * harness iterates it — so adding one more is a file and a line here, and
 * nothing else anywhere. The fifth was exactly that: `memory.js`, plus the
 * line below.
 *
 * The order is the order they are offered in, and it is deliberate: cheapest
 * and dumbest first, most expensive and most complete last, with the ones that
 * do real work in between.
 */
const REGISTRY = new Map([
  ["sliding", (options) => new SlidingWindowStrategy(options)],
  ["summary", (options) => new SummarizationStrategy(options)],
  ["facts", (options) => new FactsStrategy(options)],
  ["memory", (options) => new MemoryStrategy(options)],
  ["full", (options) => new FullHistoryStrategy(options)],
]);

/** Every strategy id, in the order they are offered. */
export const STRATEGY_IDS = [...REGISTRY.keys()];

/** What the Agent uses when nobody says otherwise. */
export const DEFAULT_STRATEGY = "summary";

/** @param {unknown} id */
export function isStrategyId(id) {
  return typeof id === "string" && REGISTRY.has(id);
}

/**
 * @param {string} id
 * @param {object} [options] - Passed to the strategy's constructor.
 * @returns {import("./strategy.js").ContextStrategy}
 */
export function createStrategy(id, options = {}) {
  const make = REGISTRY.get(id);
  if (!make) {
    throw new Error(`Unknown context strategy "${id}". Expected one of: ${STRATEGY_IDS.join(", ")}.`);
  }
  return make(options);
}

/**
 * Id, label and description for each — everything the selector needs, from the
 * strategies themselves rather than from a second list in the UI that can
 * quietly disagree with them.
 */
export function strategyCatalog() {
  return STRATEGY_IDS.map((id) => {
    const strategy = createStrategy(id);
    return { id, label: strategy.label, description: strategy.description };
  });
}

/**
 * The right-hand panel for a stored state, built by the strategy that owns it.
 * Used by the routes, which hold records rather than agents.
 */
export function panelFor(id, state, context) {
  if (!isStrategyId(id)) return { kind: "none", title: "", note: "" };
  return createStrategy(id).panel(state, context);
}

export { ContextStrategy } from "./strategy.js";
export { summaryBlock } from "./summarization.js";
export { factsBlock } from "./facts.js";
export { profileBlock, workingBlock, ROUTES } from "./memory.js";
