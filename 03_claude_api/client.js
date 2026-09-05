// Shared Anthropic client + a global cap on how many API calls are in flight.
//
// The cap sits at the *leaf* (one API call), not at the task level. expert_panel
// is itself four calls, so if a method held a slot while awaiting its own inner
// calls the pool could deadlock. Limiting only the leaf makes that impossible.
import Anthropic from "@anthropic-ai/sdk";

// Identity-linked API keys must name the workspace the request acts in; plain
// workspace keys don't. Harmless to omit when the key doesn't need it.
const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;

export const client = new Anthropic(
  workspaceId
    ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } }
    : {}
);

export const MAX_IN_FLIGHT = 6;

function createLimiter(max) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

/** Run an async fn once a slot is free. Never more than MAX_IN_FLIGHT at a time. */
export const limit = createLimiter(MAX_IN_FLIGHT);

/** Concatenate the text blocks of a Messages response. */
export function textOf(message) {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Zeroed usage accumulator. */
export function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, calls: 0 };
}

/** Fold one response's usage into an accumulator. */
export function addUsage(acc, message) {
  acc.inputTokens += message.usage?.input_tokens ?? 0;
  acc.outputTokens += message.usage?.output_tokens ?? 0;
  acc.calls += 1;
  return acc;
}

export function countWords(text) {
  const trimmed = (text ?? "").trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
