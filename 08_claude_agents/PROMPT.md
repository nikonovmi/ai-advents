# Day 8 — Working with Tokens (incremental change to the existing `first-agent` project)

This is an update to the existing project, not a rewrite. Keep the current structure, naming conventions, and code style. Do not restructure anything not listed below.

Goal: the app reports real token usage and cost for every turn and for the conversation as a whole, and demonstrates what breaks when history is cropped to a small window.

Two things carry over unchanged from earlier days: the `LlmProvider` abstraction stays the only place that knows about Anthropic, and `agent.js` stays free of `fetch`, URLs, and API keys.

## KEY DESIGN POINT

Token counts must be **real numbers from the API**, never estimated character counts. Two sources:

- The Messages response already includes a `usage` object with `input_tokens` and `output_tokens`. The current `AnthropicProvider` discards it. Stop discarding it.
- `POST https://api.anthropic.com/v1/messages/count_tokens` accepts the same body shape as the Messages API and returns `{ input_tokens }` without running the model. It is free and not billed, so it can be called freely for pre-flight measurement.

## NEW FILE — `src/llm/pricing.js`

- Export a `PRICING` map keyed by model id, with `inputPerMillion` and `outputPerMillion` in USD. Seed it with `claude-haiku-4-5-20251001`: `{ inputPerMillion: 1.00, outputPerMillion: 5.00, contextWindow: 200000, maxOutput: 64000 }`.
- Export `estimateCost({ model, inputTokens, outputTokens })` → `{ inputCost, outputCost, totalCost }` in USD.
- Export `formatCost(usd)` → a human-readable string that does not collapse small amounts to `$0.00`: use 4 decimal places under one cent (`$0.0023`), 2 decimals above (`$1.24`).
- Export `formatTokens(n)` → thousands separators under 10,000 (`8,432`), compact above (`12.4K`, `1.2M`).
- Unknown model ids must degrade gracefully: return null costs and let the UI show tokens without a price, never crash.

## CHANGES TO `src/llm/provider.js`

Widen the contract. `complete()` now resolves to:

```js
{
  text,
  model,
  stopReason,              // "end_turn" | "max_tokens" | "stop_sequence" | ...
  usage: { inputTokens, outputTokens }
}
```

Add a second method to the base class: `async countTokens({ system, messages })` → `{ inputTokens }`, throwing `Not implemented` by default.

`usage` and `stopReason` are provider-neutral names — the translation from `input_tokens` / `stop_reason` happens in the Anthropic implementation, not in the Agent.

## CHANGES TO `src/llm/anthropic.js`

- Map `response.usage.input_tokens` / `output_tokens` and `response.stop_reason` into the neutral shape above.
- If the response includes `cache_read_input_tokens` or `cache_creation_input_tokens`, pass them through as optional extra fields on `usage`. Do not require them.
- Implement `countTokens()` against `/v1/messages/count_tokens` with the same headers and timeout as `complete()`. It sends `model`, `system`, and `messages`, and must not send `max_tokens`.
- Update `FakeProvider` to return plausible synthetic usage numbers and a `stopReason`, so the UI and tests work with no API key.

## CHANGES TO `src/agent.js`

### Cropping (replaces `historyLimit`)

- Rename the option to `contextMessages`, default **5**. This is the number of most-recent messages sent to the model, counted as individual messages, not turn pairs.
- The crop applies **only to what is sent**. The store still holds the full conversation — cropping must not delete anything from `#history` or from disk. This is the key behavioural change: the agent's memory on disk is complete, but its view is a sliding window.
- Add a getter `get droppedCount()` → how many stored messages fell outside the current window.

### Usage tracking

- Before sending, call `provider.countTokens()` twice and record both: once with just the new user message, and once with the full cropped payload including the system prompt. These are the challenge's "current request" and "entire history sent" figures.
- After the reply, take real `usage` from the response.
- `run()` returns:

```js
{
  text,
  meta: {
    agent, model, ms, stopReason,
    truncated,            // true when stopReason === "max_tokens"
    tokens: {
      request,            // just this user message
      sent,               // full cropped payload actually sent
      input,              // billed input, from usage
      output,             // billed output, from usage
      total               // input + output for this turn
    },
    cost: { input, output, total },
    window: { contextMessages, droppedCount, storedMessages }
  }
}
```

- Maintain cumulative totals across the conversation (`totalInputTokens`, `totalOutputTokens`, `totalCostUsd`, `turnCount`) and persist them via the store so they survive a restart.
- Never let a `countTokens` failure break a turn: log it, set those fields to `null`, and continue.

## CHANGES TO `src/store/` — persisting usage

- The conversation record gains `usage: { totalInputTokens, totalOutputTokens, totalCostUsd, turnCount }` and each stored message gains an optional `tokens` field with that turn's counts.
- Old conversation files without these fields must still load: default missing usage to zeros rather than crashing.
- `listSessions()` includes `totalCostUsd` in each summary.

## CHANGES TO `src/server.js`

- Pass `tokens`, `cost`, `window`, and `truncated` straight through in the `/chat` response.
- New `GET /conversations/:id/usage` → per-turn token counts plus running cumulative totals, for the chart.
- Add a `contextMessages` field to the chat request body so the UI can change the window size live; validate it as an integer between 1 and 100, defaulting to 5.
- **Raise the body limit**: `express.json({ limit: "5mb" })`. The default is 100 KB, which is small enough to reject a long pasted message before it ever reaches the agent.

## CHANGES TO `public/index.html`

### The context window label (required, prominent)

Above the chat input, a always-visible banner reading something like:

> **Context window: last 5 messages.** The agent stores the whole conversation but only sends the 5 most recent messages to the model. 12 older messages are outside the window and invisible to it.

- The dropped count updates live after each turn.
- Include a number input to change the window size (1–100) so the effect can be demonstrated interactively.
- When `droppedCount` first becomes greater than zero, visually mark the boundary in the transcript — a horizontal divider labelled "⟵ outside the model's context" above the messages that are no longer being sent. This makes the cropping legible instead of theoretical.

### Per-message counters

Under each agent reply, small muted text with human-readable numbers:

`1,204 in · 312 out · $0.0027 · 1.8s · haiku-4.5`

Under each user message: `48 tokens`.

### Conversation totals

A persistent panel or header strip showing, using `formatTokens` / `formatCost`:

- total input tokens, total output tokens, total tokens
- total cost so far
- turn count and average cost per turn
- tokens sent on the most recent request, plus what percentage of the 200K window that is

### Cost growth chart

A small canvas or inline SVG chart (no chart library) plotting cumulative cost against turn number, fed by `GET /conversations/:id/usage`. Below it, one line of plain text explaining the shape: with a fixed 5-message window, per-turn input cost plateaus instead of growing, so the cumulative line is roughly linear — whereas sending the full history would make it curve upward, since every turn re-sends everything before it.

### Truncation warning

When `meta.truncated` is true, show a clear inline warning on that message: the reply hit the `max_tokens` ceiling and was cut off mid-sentence. Include a note that it was still saved to history as-is, so the model will treat its own unfinished sentence as intentional on the next turn.

Add a `maxTokens` control (e.g. 30 / 300 / 1024) next to the window-size input so this is easy to trigger on purpose.

## WHAT TO DEMONSTRATE

Update `README.md` with a short "Token experiments" section covering three runs:

1. **Short conversation** — 2–3 turns, everything inside the window. Note tokens and cost per turn.
2. **Long conversation** — 15+ turns. Note that `droppedCount` grows, per-turn input tokens flatten out rather than climbing, and the agent starts failing to recall facts stated early on. Give a concrete example: state a fact in turn 1, ask for it in turn 10, show the answer is wrong.
3. **Window comparison** — the same conversation with `contextMessages` at 5 versus 50. Contrast recall quality against tokens and cost per turn. This is the real trade-off the challenge is pointing at: memory costs money, and cropping is how you pay less for a worse memory.

## FINALLY

Restart the server and verify:
1. Counters appear under every message and the totals panel updates.
2. After 6+ messages the banner shows a non-zero dropped count and the divider appears in the transcript.
3. A fact given at the start is forgotten once it falls outside the window.
4. Setting `maxTokens` to 30 produces a visible truncation warning and a reply cut off mid-sentence.
5. Totals survive a server restart.
