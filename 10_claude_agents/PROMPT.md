# Day 10 — Context Strategies (incremental change to `first-agent`)

Update the existing project. Keep current structure and style. Don't restructure anything not listed.

Goal: context management becomes a pluggable strategy. Four strategies, switchable per conversation, plus dialogue branching and a scripted comparison.

## 1. Strategy abstraction

New `src/context/strategy.js` — abstract `ContextStrategy`, same pattern as `LlmProvider`:

```js
get id()        // "sliding" | "facts" | "summary" | "full"
get label()
async buildPayload({ history, systemPrompt, state, provider, model })
  // → { system, messages, state, meta }   never mutates history
async afterTurn({ history, state, provider, model, userMessage, reply })
  // → { state, usage, ms }
```

`state` is JSON-serialisable, owned by the strategy, persisted by the store, never inspected by the Agent. Strategy LLM calls report `usage` separately from the conversation's. Strategy failure is non-fatal: log, degrade, still answer the turn.

New `src/context/boundaries.js` — extract the existing boundary rules (`snapToUserMessage`, `takeLastExchanges`) so all strategies share them. Move the current parity tests onto these helpers and assert every strategy's payload opens on a user message for histories of 10 and 11.

## 2. The four strategies

**`slidingWindow.js`** — today's `compressionEnabled: false` path. Last N exchanges, empty state, no overhead calls. The cost floor.

**`summarization.js`** — Day 9's logic moved out of `Agent` unchanged. State `{ summary, summarizedThrough, summaryUpdatedAt }`. Keep the high-water-mark scheme and the touching-edges invariant exactly as-is — relocate, don't redesign. Delete `compressionEnabled` from `Agent`; "off" is now `strategy: "sliding"`.

**`fullHistory.js`** — everything, no cropping. The recall ceiling and cost baseline for the tables.

**`facts.js`** — new. State `{ facts: { [key]: { value, updatedAt, turn, previous: [] } } }`. Sends last N exchanges plus a facts block in the **system prompt** (same placement as the summary; omit entirely when empty):

```
<known_facts>
Established facts about this conversation. Treat as true unless the user corrects them.
goal: migrate billing off Heroku by Q1
constraint.database: Postgres 14, port 8477
preference.tooling: never suggest Kubernetes
</known_facts>
```

Extraction rules:
- **Patch-based, never regenerative.** After each user message, send current fact keys + latest exchange, get back `[{op:"set"|"delete", key, value}]`. Apply deterministically in code. Asking for the whole fact set makes the model silently drop facts it didn't restate — the exact failure this strategy exists to prevent.
- Dotted lowercase keys namespaced `goal.* / constraint.* / preference.* / decision.* / agreement.*`. Pass existing keys in the prompt so it reuses rather than duplicates.
- `set` on an existing key overwrites; keep the last 3 previous values so the UI can show a fact changed.
- Cap at `maxFacts` (default 40), evict least-recently-updated.
- `maxTokens` ≈300. Runs before the main call. Malformed ops discarded individually; on total failure keep existing facts and answer anyway.

## 3. Branching

Branching is a **storage** change that composes with all four strategies, not a fifth strategy.

Store: messages gain `id` and `parentId`. Record gains `branches: { [id]: { id, name, headId, forkedFromMessageId, parentBranchId, strategyState } }` and `activeBranchId`. Branch history = path from `headId` to root, reversed — add `getBranchHistory(record, branchId)`.

**Each branch owns its own `strategyState`**, copied from the parent at fork time. Sharing it lets branches contaminate each other's facts, which presents as hallucination rather than as a storage bug.

Migration: old flat-array files load in memory as a single `main` branch, with `summary`/`summarizedThrough` moved into `main.strategyState`. Don't rewrite on disk until next save.

Routes: `POST /conversations/:id/branches` (`{fromMessageId, name}`), `GET .../branches`, `POST .../branches/:branchId/activate`, `DELETE .../branches/:branchId` (refuse `main` or active). `POST /chat` takes optional `branchId`, default active.

## 4. Agent + server

- `Agent` takes `strategy` instead of `compressionEnabled`/`summarizeEvery`; validate it like `provider`.
- `run()`: load branch history → `buildPayload` → provider call → append → `afterTurn` → persist state.
- `meta` gains `strategy: { id, label, overheadTokens, overheadCost, overheadMs, note }` — `note` is one human line ("folded 3 exchanges", "3 facts set, 1 deleted", "no overhead"). Keep existing `meta.tokens`/`meta.cost` shape.
- `POST /chat` accepts `strategy`, validated against a registry, persisted per branch. Switching mid-conversation keeps the old strategy's state so switching back isn't a reset.
- `/replay` accepts `strategies: [...]` and answers the same question once per strategy in parallel, read-only, each arm reporting its own failure.

## 5. Scenario harness

`scenarios/requirements-gathering.json` — 15 scripted user messages. Five checkable facts planted in the first five (name, port number, hard constraint, rejected option, deadline), ten turns of unrelated discussion, then a final message asking for all five back.

`npm run scenario -- --strategy=facts --window=10` prints per-turn input/output/overhead tokens, cumulative cost, and a recall score out of 5 by substring match. `--all` runs every strategy and prints one comparison table. Must work against `FakeProvider` with no API key.

## 6. UI

- Strategy selector by the composer, one line of description each; mid-conversation switches marked in the transcript.
- Right column is strategy-aware: **summary** keeps today's panel; **facts** shows a live key-value table grouped by namespace, small type, flashing changed rows with an inline "was: …"; **sliding/full** show a short placeholder saying there's no auxiliary block and what that costs.
- Branch bar above the transcript: active branch name, switcher, "Fork from here" on message hover. Small inline-SVG tree (vertical trunk, labelled offshoots) — keep it simple.
- Compare panel runs all four and tables reply / input / overhead / cost / recall.
- Per-turn counters attribute overhead in the existing style: `512 in (98 facts)`.

## 7. README

Add a "Strategies" section in the existing voice: design reasoning, measured numbers from `--all` at window 10 (recall /5, conversation cost, overhead cost, all-in, overhead calls), then the verdict. Facts extracts on **every** user message versus summarization's every `window/2` — given compression at window 5 already cost more than full history, report where facts actually lands rather than assuming it wins. State that branching is orthogonal to the other three.

## Verify

1. All four strategies answer a turn with distinct overhead in `meta`.
2. Every payload opens on a user message, both parities.
3. State a preference, reverse it 5 turns later — facts holds the new value, UI shows the old.
4. Fork at message 4, run both branches 3 turns, switch back and forth — no facts or summary leaked between them.
5. Day 8/9 conversation files still load.
6. `npm run scenario -- --all` completes on `FakeProvider` with no key.
