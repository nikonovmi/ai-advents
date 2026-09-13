# Day 9 — Context Management: History Compression (incremental change to the existing `first-agent` project)

This is an update to the existing project, not a rewrite. Keep the current structure, naming conventions, and code style. Do not restructure anything not listed below.

Goal: instead of silently dropping messages outside the context window, compress them into a running summary that is stored separately and injected into each request. Then measure whether it actually helps.

Carried over unchanged: `LlmProvider` stays the only place that knows about Anthropic, and `agent.js` stays free of `fetch`, URLs, and API keys.

## THE THREE-ZONE PAYLOAD

Every request is assembled from three parts:

1. **System prompt** — the persona, plus the summary appended under a clear header.
2. **Recent messages** — the last `contextMessages` messages, verbatim.
3. **The new user message.**

Everything older than zone 2 exists only as the summary.

**The summary goes in the system prompt, not in the messages array.** Injecting it as an assistant message would make the model treat a third-person digest as something it said. Append it to the system string, e.g.:

```
<conversation_summary>
Summary of earlier parts of this conversation, which are no longer shown in full:
...
</conversation_summary>
```

Omit the block entirely when there is no summary yet — never send an empty header.

## TWO REQUIRED CORRECTNESS FIXES

**1. The window must start on a user message.** The API rejects a `messages` array whose first entry has `role: "assistant"`. Cropping to the last N messages lands on an assistant message roughly half the time, so this is an intermittent 400 that is already latent in the Day 8 code. After computing the window, if the first message is an assistant turn, move the boundary back one message. Add a test for both parities.

**2. Never split a turn pair across the boundary.** A user message whose assistant reply is outside the window (or vice versa) produces confusing context. Snap the boundary to a clean turn edge.

## NEW FILE — `src/summarizer.js`

Export `class Summarizer`, constructed with `{ provider, model, maxTokens = 600 }`. The provider is injected, exactly like the Agent's.

- `async summarize({ previousSummary, messages })` → `{ text, usage }`.
- **Incremental by design**: the prompt receives the existing summary plus only the newly-dropped messages, and asks for an updated summary that folds the new material in. Never re-summarize the whole conversation from scratch — that would cost more than it saves.
- **Structured output, not prose.** A free-form paragraph loses exactly the details that recall tests probe for. Instruct the model to return sections with concrete specifics preserved verbatim:

```
## Facts about the user
## Decisions made
## Preferences and constraints
## Open questions
## Discarded / superseded
```

Explicitly instruct: keep names, numbers, file paths, versions, port numbers, and identifiers exactly as stated; prefer dropping narrative over dropping a specific value; keep it under roughly 400 words.

- Return the summarizer's own `usage` so its cost can be accounted for separately. This call is not free and must not be hidden.

## CHANGES TO `src/agent.js`

### New options

- `contextMessages` (default 5) — unchanged meaning: verbatim messages sent.
- `summarizeEvery` (default 10) — compress once this many messages have accumulated outside the window.
- `compressionEnabled` (default true) — when false, behave exactly like Day 8 (crop, no summary). Needed for the comparison.

### New state (persisted)

- `#summary` — the current summary text, or null.
- `#summarizedThrough` — an index into the full history marking how much has been folded into the summary. This is what makes summarization incremental and idempotent.

### Flow in `run()`

1. Append the user message to full history.
2. Compute the window (with the two boundary fixes above).
3. If the count of messages between `#summarizedThrough` and the window start has reached `summarizeEvery`, run the Summarizer on exactly that slice, replace `#summary`, and advance `#summarizedThrough`.
4. Assemble system + summary + windowed messages and call the provider.
5. Append the reply, persist, return.

Rules:
- **Summarization failure is non-fatal.** If the Summarizer throws, log it, keep the previous summary, do not advance `#summarizedThrough`, and continue with the turn. A failed compression must never lose a user's message or block a reply.
- Summarization happens **before** the main call in the same turn, so the summary is current. Accept the added latency and report it separately in `meta`.

### New getters

- `get summary()` — the current summary text.
- `get summaryTokens()` — token count of the summary block, via `provider.countTokens`.

### `meta` additions

Extend the existing `meta.tokens` with:

```js
compression: {
  enabled,
  summaryTokens,          // size of the injected summary
  summarizedMessages,     // how many messages it stands in for
  compressedThisTurn,     // bool — did a summarization run happen
  summarizerTokens,       // input+output the summarizer itself consumed
  summarizerCost,
  summarizerMs
}
```

## CHANGES TO `src/store/`

- The conversation record gains `summary`, `summarizedThrough`, and `summaryUpdatedAt`.
- Cumulative usage gains `summarizerInputTokens`, `summarizerOutputTokens`, `summarizerCostUsd`, tracked separately from conversation usage so net savings can be computed honestly.
- Records written by Day 8 must still load — default the new fields to `null` / `0` rather than crashing.

## NEW — `POST /conversations/:id/replay` (the comparison endpoint)

This is how the challenge's "compare" requirement gets answered with data instead of impressions.

- Accepts `{ question }`.
- Loads the stored conversation and answers the same question three ways, in parallel:
  1. **full** — entire history, no cropping, no summary
  2. **cropped** — last N verbatim only (Day 8 behaviour)
  3. **compressed** — summary + last N verbatim (Day 9 behaviour)
- Returns all three replies with their input tokens, output tokens, cost, and latency.
- Uses the stored conversation read-only: the replay must not mutate history, the summary, or the usage totals.

## CHANGES TO `public/index.html`

- Update the context banner to describe all three zones, e.g.: *"Sending: a summary of 24 earlier messages + the last 5 verbatim. Full history is stored but not sent."*
- Replace the "outside the context" divider with a **collapsible summary block** at that boundary, showing the actual summary text. Seeing what the model is working from is the single most useful piece of UI here.
- **A persistent "Active summary" panel**, always visible without scrolling — in the sidebar under the conversation list, or as a fixed panel beside the chat column. This shows the exact summary text currently being injected into the system prompt.
  - Small type: roughly 11–12px, muted foreground colour, slightly tighter line height than the chat, monospace optional for the section headers. It is reference material, not part of the conversation, and should read as secondary to it.
  - Its own scroll container with a sensible max height (around 40% of viewport height) so a long summary never pushes the chat off screen.
  - A one-line header with live stats: `Summary · 412 tokens · covers 24 messages · updated 2 turns ago`.
  - Render the Markdown section headers (`## Facts about the user` etc.) as small bold labels so the structure is scannable at that size.
  - Briefly highlight the panel — a background flash or a "just updated" badge for a few seconds — on the turn where compression runs, so it's obvious when the model's memory of the old conversation changed.
  - Empty state before the first compression: muted placeholder text explaining that nothing has been summarized yet because no messages have left the context window.
  - Collapsible, with the collapsed/expanded state remembered in `localStorage`.
  - On narrow screens it moves below the chat or behind a toggle rather than squeezing the message column.
- Flag the turn where compression ran ("summary updated — 10 messages folded in") with the summarizer's own token cost shown, so the overhead is visible rather than hidden.
- Per-message counters gain summary tokens as a separate component of the input figure.
- Toggles for `compressionEnabled` and `summarizeEvery` next to the existing window-size control.
- A **Compare** panel: a question box that calls `/replay` and renders the three answers side by side with their token counts and costs.

## WHAT TO DEMONSTRATE

Add a "Compression experiments" section to `README.md`:

1. **Recall test.** State three specific facts in the first few turns (a number, a name, a preference). Chat past 15 turns. Ask for all three. Run it with `compressionEnabled` false and true. Report how many facts survived each way. This is the quality comparison.
2. **Token comparison.** Use `/replay` on the same long conversation and report the three input-token counts. Full history is the baseline; cropped is the floor; compressed sits between them.
3. **Honest net cost.** Report summarizer tokens separately and state the break-even point. Note plainly that compared with *cropping alone*, compression costs more, not less — the saving only exists relative to sending full history. What compression buys over cropping is recall, and the numbers should say so rather than implying a free lunch.

## FINALLY

Restart the server and verify:
1. After ~15 messages a summary exists and is visible in the collapsed block.
2. A fact from turn 1 is recalled correctly with compression on, and wrong with it off.
3. Summarizer cost appears separately in the totals.
4. `/replay` returns three distinguishable answers with different token counts.
5. Summary and `summarizedThrough` survive a server restart.
6. Conversations with both even and odd message counts send successfully — no `role` ordering errors.
