import { MemoryStrategy } from "./memory.js";

/**
 * The strategy entry point.
 *
 * `LlmProvider` answers "who is the model?", `ConversationStore` answers "where
 * does the conversation live?", and `ContextStrategy` answers the third
 * question the Agent should not have an opinion about: given everything that
 * has been said, what actually goes on the wire?
 *
 * There used to be five implementations and a registry to pick between them.
 * Four of them existed to be compared against this one — a sliding window that
 * forgets, a rolling digest, a key-value fact table, and sending everything
 * every turn. The comparison is over, so what is left is the one that ships.
 *
 * The abstraction itself stays. `MemoryStrategy` is a large class with a
 * documented contract (`strategy.js`), the Agent still hands it a history and
 * receives a payload, and the state it keeps is still opaque to everything
 * above it. What went away is the indirection that let you choose, not the
 * seam.
 */

/** The only strategy there is. */
export const DEFAULT_STRATEGY = "memory";

/** @param {unknown} id */
export function isStrategyId(id) {
  return id === DEFAULT_STRATEGY;
}

/**
 * @param {string} [id]
 * @param {object} [options] - Passed to the strategy's constructor.
 * @returns {import("./strategy.js").ContextStrategy}
 */
export function createStrategy(id = DEFAULT_STRATEGY, options = {}) {
  if (!isStrategyId(id)) {
    throw new Error(`Unknown context strategy "${id}". The only one is: ${DEFAULT_STRATEGY}.`);
  }
  return new MemoryStrategy(options);
}

export { ContextStrategy } from "./strategy.js";
export { profileBlock, workingBlock, summaryBlock, ROUTES } from "./memory.js";
export { invariantsBlock } from "./invariants.js";
