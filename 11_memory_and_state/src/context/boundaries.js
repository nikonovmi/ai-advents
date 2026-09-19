/**
 * The boundary rules, in one place.
 *
 * Every strategy crops, folds or passes through a history, and every one of
 * them has to obey the same two rules about where a payload may begin. They
 * used to live in `agent.js`, where exactly one caller could reach them; they
 * live here now so that "the window opens on a user message" is a property of
 * the codebase rather than a property of whichever strategy remembered it.
 *
 *   1. **The payload must open on a user message.** The Messages API rejects a
 *      `messages` array whose first entry is an assistant turn. A crop that
 *      counts messages instead of exchanges lands on one about half the time,
 *      so this is an intermittent 400 that depends on nothing but the parity
 *      of the conversation.
 *   2. **A turn pair is never split.** A user message whose reply is outside
 *      the payload, or a reply whose question is, is worse than sending
 *      neither: the model reads half an exchange as a whole one.
 *
 * Both come out of the same move — walk the boundary back to the user message
 * that opens the turn it landed inside.
 *
 * These are free functions rather than methods because the boundary rules are
 * the part most worth testing, and a private method cannot be tested from
 * outside.
 */

/**
 * The index of every user message at or after `from` — one per exchange, since
 * an exchange is a user message and everything that answers it.
 *
 * @param {{ role: string }[]} history
 * @param {number} [from]
 * @returns {number[]}
 */
export function exchangeStarts(history, from = 0) {
  const starts = [];
  for (let i = Math.max(0, from); i < (history?.length ?? 0); i++) {
    if (history[i].role === "user") starts.push(i);
  }
  return starts;
}

/**
 * The nearest exchange boundary at or before `index`: rule 1 and rule 2, as a
 * single function.
 *
 * A history that opens with an assistant turn has no earlier edge to snap back
 * to, so the boundary walks *forward* to the first user message instead.
 * Walking forward loses a message the model would otherwise have seen; sending
 * a payload the API refuses loses the whole turn.
 *
 * @param {{ role: string }[]} history
 * @param {number} index - Anywhere in `[0, history.length]`.
 * @returns {number} The index of a user message, or `history.length`.
 */
export function snapToUserMessage(history, index) {
  const messages = history ?? [];
  const at = Math.min(Math.max(0, Math.floor(Number(index) || 0)), messages.length);
  if (at === messages.length) return at;

  let i = at;
  while (i > 0 && messages[i].role !== "user") i--;
  if (messages[i].role === "user") return i;

  const firstUser = messages.findIndex((message) => message.role === "user");
  return firstUser === -1 ? messages.length : firstUser;
}

/**
 * Where a window of `contextMessages` exchanges begins: the index of the
 * `contextMessages`-th most recent user message, snapped.
 *
 * The window is measured in user messages rather than in messages outright, so
 * it survives a model that answers in several parts — an assistant reply can
 * never push the user's own question out of the request that contains it.
 *
 * @param {{ role: string }[]} history
 * @param {number} contextMessages
 * @returns {number} Index into `history`; everything before it is out of view.
 */
export function windowStart(history, contextMessages) {
  const messages = history ?? [];
  const turns = Math.max(1, Math.floor(contextMessages));
  let start = 0;
  let seen = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    if (++seen === turns) {
      start = i;
      break;
    }
  }

  return snapToUserMessage(messages, start);
}

/**
 * The last `contextMessages` exchanges, stripped back to what a provider is
 * allowed to see. The shape every strategy's zone 2 is built from.
 *
 * @param {{ role: string, content: string }[]} history
 * @param {number} contextMessages
 * @returns {{ start: number, messages: import("../llm/provider.js").Message[] }}
 */
export function takeLastExchanges(history, contextMessages) {
  const start = windowStart(history, contextMessages);
  return { start, messages: toWire((history ?? []).slice(start)) };
}

/**
 * Where a summary's edge moves when the oldest `exchanges` exchanges after
 * `from` are folded into it.
 *
 * The result is always the index of a user message, which is what keeps both
 * boundary rules true for free. It also never advances past the last exchange
 * — the turn being answered right now is never folded away underneath the
 * answer.
 *
 * @param {{ role: string }[]} history
 * @param {number} from - The current edge of the summary.
 * @param {number} exchanges - How many to fold in.
 * @returns {number} The new edge.
 */
export function foldTo(history, from, exchanges) {
  const starts = exchangeStarts(history, from);
  const fold = Math.min(Math.max(0, Math.floor(exchanges)), Math.max(0, starts.length - 1));
  return fold === 0 ? from : starts[fold];
}

/**
 * Stored messages carry ids, token counts and per-turn bookkeeping. A provider
 * is shown `{ role, content }` and nothing else.
 *
 * @param {{ role: string, content: string }[]} messages
 * @returns {import("../llm/provider.js").Message[]}
 */
export function toWire(messages) {
  return (messages ?? []).map(({ role, content }) => ({ role, content }));
}
