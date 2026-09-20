# Day 13 — Task State Machine

Give the task an explicit lifecycle. Day 11 gave it a start and an end
(*Finish task*); this is the structure in between. Nothing new needs storing —
`strategyState` is already per-branch, deep-copied on fork, and persisted.

Read `src/context/memory.js` first. Every invariant stays: one mutation path,
patch-only writes, failure degrades the payload rather than the turn.

## 1. `src/context/taskState.js`

A new file, in the same design language as `ROUTES`:

- **`TRANSITIONS`** — the legal edges, as data:

  ```
  planning   → execution
  execution  → validation | planning
  validation → done | execution
  done       → (terminal)
  ```

  Backward edges are not optional — validation failing is the interesting case.
  `done` never reopens; resumed work is a new task referencing the old one.

- **`guardFor(from, to, working) → true | reason`** — a pure function of state.
  The reason string drives the disabled button's tooltip, so the rule lives in
  one place. Guards read working memory:
  - leaving `planning` requires a `goal`
  - entering `done` with unanswered `open.*` **warns, does not block**

- **`transition(state, event)`** — the only mutation path, mirroring `applyOps`.
  Buttons, model proposals and scenarios all go through it. An illegal edge is
  **discarded and logged**, never coerced to a nearby valid state.

Transitions are an **append-only log** of `{from, to, at, by: 'user'|'model'|'system', reason}`.
Current stage is derived from the last entry — that gives the transcript
dividers, the audit trail and resume-after-restart for free.

## 2. Three fields on the working record

| field | holds |
| --- | --- |
| `stage` | derived from the transition log |
| `step` | one line: what is in progress right now |
| `expectedAction` | `{ actor: 'user' \| 'agent', what }` |

`expectedAction` is what makes resume work — stage says where you are, this says
what to do on the next turn after a week's gap. There is no `blocked` state;
blocked is `actor: 'user'`.

Every conversation starts in `planning`. There is no null/no-task state.

## 3. Stage changes the prompt

Each stage contributes one instruction line to the system block, inside
`<working>`. Without this the FSM is decoration, and the test is the same one
used for profiles: the same question in two stages gives visibly different
answers.

**Planning is the stage that matters most.** Its instruction must:

- **not gate answering.** Every chat starts here, including "what's the
  weather". Answer the question, and clarify alongside — never clarify first.
- **bound the clarifying.** At most one or two questions per turn, and only
  where the answer would change the work. An agent that asks four questions per
  turn is one people click past.
- **point clarification at `open.*`.** Surface unknowns as open questions rather
  than assuming them. That gives the `planning → execution` guard something real
  to check.
- **say the goal is about to freeze.** The model behaves differently when it
  knows this is the last chance to shape it.

Execution: work within the recorded constraints, don't add scope.
Validation: check the work against the recorded goal and constraints; report
what fails rather than fixing it silently.

## 4. Freeze on leaving planning

Once `planning` is left, `goal` is no longer freely writable: a
**model-originated** op on it becomes a correction proposal instead of a write,
exactly as Day 12 does for declared profile entries. A person-originated op
still writes.

This also fixes the goal-drift bug — drift is a planning-stage phenomenon, and
the write policy tightens once the task is committed.

## 5. `Finish task` becomes `→ done`

Not a parallel mechanism. Promotion to long-term and clearing into `pastTasks`
fire on **entering `done`**, through `transition`. Keep the existing promotion
call and proposal flow unchanged.

## 6. Model proposals

The extractor may propose a transition in its patch. It is rendered as a
suggestion beside the corresponding button — **never auto-applied**. Stage
changes only on a click. Never ask the model what stage it is in; it is told,
not consulted.

## 7. UI

- **Stage strip, above the composer, always visible** — the highest-value
  element, because it answers "whose turn is it" before the user types:
  four dots (past solid, current filled, future hollow), the `step` line, an
  `awaiting: you / agent` line styled distinctly by actor, and buttons for the
  currently-legal edges. Disabled buttons show the guard's reason.
- **Memory panel** — stage at the top of the working section; frozen `goal`
  marked with a lock; past tasks show their final stage.
- **Transcript** — a thin divider rendered at each transition from the log.
- **Resume banner** — on loading a mid-flight task, a "you were here" line
  composed **from state, with no model call**.

Plain HTML, no build step: the strip is one flex row, the buttons render from
`TRANSITIONS` filtered by the current stage.

## Verify

- Illegal edge → discarded and logged, state unchanged.
- Guard blocks with its reason; `→ done` with open questions warns but proceeds.
- Model op on a frozen `goal` → proposal, no write. Person op → writes.
- `done` is terminal; promotion fires exactly once on entry.
- **Restart test**: `npm start` mid-task, reopen the conversation — the banner
  renders from state and the agent's first reply continues the work instead of
  asking what it was.
- Demo scenario walking the full cycle **including `validation → execution`**.
