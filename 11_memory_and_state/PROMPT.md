# Day 11 — Agent Memory Model

Give the agent an explicit, three-layer memory model. Build it as a **fifth
context strategy** (`src/context/memory.js` + one line in `src/context/index.js`).
Nothing in `agent.js`, the routes, or the UI shell should need to change — if it
does, the abstraction has leaked.

## The three layers

| Layer | Content | Stored in | Ends when |
| --- | --- | --- | --- |
| **Short-term** | recent exchanges verbatim + rolling digest | conversation record | slides out of the window |
| **Working** | goal, constraints, decisions, open questions | `strategyState` (branch) | the user finishes the task |
| **Long-term** | profile, preferences, promoted decisions | new profile store | never (only on explicit delete) |

Short-term already exists — the window plus `Summarizer`. The digest is
compressed short-term, **not** a fourth layer.

Working memory is today's `facts` store minus `preference.*`. Distilled, not a
transcript: `{ goal, constraints[], decisions[], open[] }` as namespaced keys.
It is not a second summary — the digest records *what was discussed*, working
memory records *what is currently true about the work*.

Long-term lives **outside** `data/conversations/`, so it survives a new chat.

## Payload

```
system:   [persona] + <profile>…</profile> + <working>…</working> + [digest]
messages: last N exchanges verbatim
```

Four sources, three lifetimes, one wire format.

## Explicit routing

The extractor **proposes a key, never a layer.** Layer assignment is a table in
code, one place, identical every run:

```js
const ROUTES = {
  'goal':       { layer: 'working', evict: 'task' },
  'constraint': { layer: 'working', evict: 'task' },
  'open':       { layer: 'working', evict: 'task' },
  'decision':   { layer: 'working', evict: 'task', promotable: true },
  'agreement':  { layer: 'working', evict: 'task', promotable: true },
  'preference': { layer: 'longterm', evict: 'never' },
};
```

An unrecognised namespace is **discarded, not guessed at** — and logged, so the
panel can show *proposed, not stored: `random.thing`*.

Reuse the existing patch discipline: the model may only emit
`[{op:"set"|"delete", key, value}]`, `applyOps` applies them in code. Nothing is
ever regenerated.

## Schedules

- **Extraction: every user turn**, patch-based, on the last exchange (what
  `facts` already does). It cannot wait for the fold — between folds a turn can
  slide out of the window uncaptured, and a digest is the wrong input for
  constraints stated once in passing.
- **Folding: at the high-water mark**, via the existing `Summarizer`.
- Bill them apart: `usage.overheadWorking` and `usage.overheadSummary`, never
  folded into the conversation totals.

## Task boundary — the "Finish task" button

One UI control, three effects:

1. One promotion call: working memory in, long-term proposals out — **rephrased
   to stand alone**, since `constraint.latency = "200ms"` means nothing next week
   without its context.
2. User approves or edits each proposal; approved items write to the profile store.
3. Working memory clears — the task is over. The next turn starts a new one
   implicitly. No `openTask` op, no status field, no switch detection.

**Clear, don't delete.** The closed record moves to `pastTasks` in
`strategyState` and simply stops being sent.

**Pending proposals live in the conversation record**, never in the profile store
with a flag — an unapproved write must not exist in long-term. Unanswered
proposals expire at conversation end. Never auto-approve; that would turn the
explicit policy back into an implicit one.

If the user never presses the button, working memory degrades to `facts` with
LRU at `maxFacts`. Acceptable — document it.

## Also build

- **`ProfileStore`** abstraction (`load` / `save` / `clear`) next to the existing
  three, injected the same way, with `JsonProfileStore`
  (`data/memory/<user>.json`) and an in-memory twin for tests. `Agent` learns no
  file path.
- **Stamping**, so a fork cannot read what its parent promoted after the fork —
  the `factsAsOf` rule, applied to long-term. A leak here presents as
  hallucination, not as a storage bug.
- **Panel** (`panel(state)`): three sections — profile, current task, past tasks —
  plus the discarded-proposals list. Each row gets *forget* and *promote*, going
  through the same `applyOps` path so there is one code path to test.
- **Per-turn counter** reads `512 in (140 profile, 98 task)`, attributing the
  blocks inside the input figure.

## Verify

- `ROUTES` test: every namespace resolves to exactly one layer; an unknown one
  lands nowhere.
- Two-conversation scenario: does the profile survive a restart?
- One-conversation, two-task scenario: after "Finish task", the second task
  can see a promoted decision and **cannot** see the cleared constraints.
- Run the comparison at window 5 and 10 against the existing four strategies.
  The claim to test is that layering wins at small windows — where `facts`
  already beat `full`. Report the extra per-turn call in the cost column.
