# first-agent — memory and task state

A chat app whose interesting part is what goes on the wire. Four memories with
four lifetimes, and a task with an explicit lifecycle that decides what the
model is told and what it is allowed to change.

This README describes the architecture: where state lives, how it moves, and
**exactly what each stage is passed**.


https://github.com/user-attachments/assets/254e0ee4-0793-47af-ace8-2cbe4c3ab3c5


```bash
npm install
npm test                              # 92 tests, stubs, no key, no network
echo 'ANTHROPIC_API_KEY=sk-ant-…' > .env
npm start                             # http://localhost:3000
npm run lifecycle                     # one task through every stage
npm run scenario -- --all --window=10 # the five strategies, compared
npm run compare -- --profiles=plain-english,code-first
```

---

## 1. The object graph

`Agent` owns a persona and a branching conversation. It holds no URL, no key,
no `fetch`, and no opinion about what goes on the wire. Four things are
injected:

| | answers | implementations |
| --- | --- | --- |
| `LlmProvider` | who is the model | `AnthropicProvider`, `FakeProvider` |
| `ConversationStore` | where the conversation lives | `JsonFileStore`, `MemoryStore` |
| `ContextStrategy` | **what goes on the wire** | `sliding`, `summary`, `facts`, `memory`, `full` |
| `ProfileStore` | where what we know about the *user* lives | `JsonFileStore`, `MemoryProfileStore` |

A strategy owns two things: `buildPayload(history) → {system, messages, state}`
and an opaque `state` the `Agent` never inspects. That is what makes a fifth
strategy a new file plus one registry line rather than a new branch in `run()`.
Two rules hold for all five:

- **Strategy calls are billed separately.** A saving whose cost has been added
  to the thing it is measured against is not a measurement.
- **Failure degrades the payload, never the turn.** A summary that could not be
  written or an extraction that failed is logged, the previous state is kept,
  and the turn is answered anyway.

Everything below is about `memory`, the fifth strategy — the only one with an
opinion about time.

```
src/
  agent.js                 persona, branches, retry, the five-step turn
  server.js                HTTP; mounts memoryRoutes with one line
  memoryRoutes.js          the task boundary as HTTP — none of it is a turn
  context/
    strategy.js            the ContextStrategy contract
    index.js               the registry
    memory.js              the four memories, the routing table, applyOps
    taskState.js           the lifecycle: TRANSITIONS, guardFor, transition
    boundaries.js          payload must open on a user message; pairs never split
  store/
    branches.js            messages gain id/parentId; each branch owns strategyState
    profileStore.js        data/memory/<user>.json — outlives every conversation
```

---

## 2. The four memories

| | holds | lives in | ends when |
| --- | --- | --- | --- |
| **Short-term** | recent exchanges verbatim | the conversation record | it falls past a floor (§4) |
| **Digest** | a rolling summary of what scrolled past | `strategyState.memory.digest` | never; rewritten at each fold |
| **Working** | `goal`, `constraint`, `finding`, `open`, `decision`, `agreement`, the stage, the brief | `strategyState.memory`, per branch | the task reaches `done` |
| **Long-term** | `profile`, `preference`, `rule`, promoted decisions | `data/memory/<user>.json` | only an explicit delete |

The digest is compressed short-term, **not** a layer of its own: the digest
records *what was discussed*, working memory records *what is currently true
about the work*. Long-term lives outside `data/conversations/` — delete the
conversation and the profile is still there.

### The routing table

The extractor proposes a **key** and never a layer. The namespace of that key is
looked up in one table, in code, identically every run:

```js
export const ROUTES = {
  goal:       { layer: 'working',  evict: 'task', singular: true },
  constraint: { layer: 'working',  evict: 'task' },
  finding:    { layer: 'working',  evict: 'task' },
  open:       { layer: 'working',  evict: 'task' },
  decision:   { layer: 'working',  evict: 'task', promotable: true },
  agreement:  { layer: 'working',  evict: 'task', promotable: true },
  profile:    { layer: 'longterm', evict: 'never' },
  preference: { layer: 'longterm', evict: 'never' },
  rule:       { layer: 'longterm', evict: 'never' },
};
```

- `layer` — which memory the key lives in. An unrecognised namespace is
  **discarded and logged**, never guessed at.
- `evict: task` — cleared when the task reaches `done`.
- `promotable` — may be offered for long-term at the task boundary. A goal or an
  open question is over when the task is; a decision can outlive it.
- `singular` — `goal` is the only key that may be a bare namespace. A task has
  one goal; a user has a role *and* a city *and* a team, so a bare `profile`
  would be a whole layer collapsed into one slot that each new fact overwrites.

### State shape

```js
strategyState.memory = {
  working:   { 'goal': { value, updatedAt, turn, previous: [] }, … },
  task:      { id, previous, transitions: [], step, expectedAction,
               stepTurn, expectedTurn, suggestion, refused: [] },
  brief:     { text, status: 'pending'|'accepted', turn, through, edited } | null,
  briefThrough: number,         // the floor it set; outlives the brief itself
  digest:    string | null,
  digestThrough: number,        // message index the digest covers to
  pastTasks: [],                // closed tasks: entries, route, brief
  proposals: [],                // promotions and corrections awaiting a human
  discarded: [],                // ops that were refused, with the reason
  promotedAt: {},               // entry id → turn, so a fork cannot read ahead
  profileSeen: {}, profileUser, attribution: [], usage: {},
}
```

It is per-branch and deep-copied on fork, which is how the lifecycle inherits
branching for free.

---

## 3. The task state machine

`taskState.js`. Four stages, the legal edges as data, one mutation path.

```
planning ──▶ execution ──▶ validation ──▶ done
    ▲            │              │
    └────────────┘              │
                 ◀──────────────┘
```

```js
export const TRANSITIONS = {
  planning:   ['execution'],
  execution:  ['validation', 'planning'],
  validation: ['done', 'execution'],
  done:       [],
};
```

**The backward edges are the point.** Validation *failing* is the common case; a
machine that only moves forward leaves "this does not meet the goal"
unrepresentable and the work carries on in `validation` pretending otherwise.

**`done` is terminal.** Reopening it would mean a closed task gaining entries
after its promotion call had run — the one way "promotion fires exactly once"
stops being structurally true. Resuming is a **new task referencing the old
one** (`task.previous`).

**The stage is derived, never stored.** Transitions are an append-only log of
`{from, to, at, by, turn, reason}`; the stage is the last entry's `to`. An empty
log *is* `planning`, so every conversation starts inside the machine with
nothing having been created for it, and there is no null/no-task state anywhere
downstream. One source of truth buys three things that would each otherwise need
maintaining: the transcript's dividers, the audit trail, and resume-after-restart.

### Guards

`guardFor(from, to, working) → true | reason` is a pure function of state, and
the reason string *is* the disabled button's tooltip — the rule lives in one
place and the tooltip is that place quoting itself.

| edge | rule | effect |
| --- | --- | --- |
| any | not in `TRANSITIONS` | **blocked**, discarded and logged |
| `planning → execution` | no `goal` recorded | **blocked** — *"Nothing is recorded as the goal yet"* |
| `planning → execution` | unanswered `open.*` | **warns**, proceeds on confirm |
| `→ done` | unanswered `open.*` | **warns**, proceeds on confirm |

Neither open-question rule blocks. Plenty of real work starts and finishes with
questions nobody answered, and blocking the start while the finish only warns
would gate beginning more strictly than declaring done.

An illegal edge is **discarded and recorded** in `task.refused`, never coerced to
a nearby valid state: coercion makes the machine look like it worked while the
stage becomes something nobody chose.

### Three fields on the task

| field | holds |
| --- | --- |
| `stage` | derived from the transition log |
| `step` | one line: what is in progress right now |
| `expectedAction` | `{ actor: 'user' \| 'agent', what }` |

There is no `blocked` state: blocked is `actor: 'user'`, said in a way the next
turn can act on. Stage says where you are; `expectedAction` says what to do on
the next turn after a week's gap — which is why it holds a sentence rather than
a flag, and why the strip can send it verbatim (§8).

---

## 4. What each stage is passed

The payload is assembled in `buildPayload`. Blocks are omitted entirely when
empty, so nothing pays for a layer it is not using.

```
system:   [persona]
          + <profile>…</profile>     long-term, if any
          + <working>…</working>     the stage, the three fields, the keys
          + <brief>…</brief>         only once accepted
          + [digest]                 only once something has folded

messages: history.slice( max(digestThrough, briefThrough) ), verbatim
```

The message floor is the **later** of the two: a message below either is already
represented in the system prompt, and sending it again would be paying twice to
say it worse. The floor is snapped to a user message, because a payload that
opens on an assistant turn reads to the model as its own words.

### The `<working>` block, in every stage

```
<working>
The task in hand — what is currently *true about the work*, not a record of
what was said. All of it is live.
stage: execution
step: writing the migration script
awaiting: you, the assistant — do the work inside the recorded goal and constraints
STAGE — execution. …one instruction line, per stage, below…
goal: Move the billing service off Heroku before the March 14 contract end
constraint.database: Must stay on Postgres 14
open.region: Same region, or move to Frankfurt?
</working>
```

The stage rides **inside** `<working>` rather than in a block of its own,
because it is the same kind of claim the keys are — what is currently true about
the work — and a fifth block would be a fifth thing the model has to be told how
to read.

### Per stage

| | system prompt | messages | `goal` writable by a model |
| --- | --- | --- | --- |
| **planning** | persona + profile + working + digest | everything since the digest | **yes** |
| **execution** | persona + profile + working + **brief** + digest | only since the brief | no — proposal |
| **validation** | persona + profile + working + **brief** + digest | only since the brief | no — proposal |
| **done** | persona + profile + working + digest | still only since the brief | n/a — working is cleared |

**planning** — `STAGE — planning. Your job here is to understand the task, not
to do it.` It refuses the deliverable outright: no plan, no code, no draft, *not
because the user said "go ahead"*. A direct question that is not the task
("what's the weather") still gets a short answer, so the first message of a chat
is not an interrogation. Otherwise it asks for what is missing — at most one or
two questions a turn, only where a different answer would change the work —
states its assumptions out loud, and is told the goal is about to freeze and the
conversation about to be replaced. When the goal and constraints are recorded
and no `open.*` remain it stops asking and says one fixed line:

> Everything's clear — we can switch to execution now. Or add more details if
> you want to refine it first.

**execution** — `Work inside the goal and the constraints recorded above and add
nothing to them. If something outside them turns out to be needed, name it and
say it is outside the agreed scope; do not quietly widen the work to cover it.`

**validation** — `Check what has been produced against the recorded goal and
constraints, one at a time, and report what fails, what is unverified and what
passes. Do not silently fix anything you find: a fix is a return to execution,
and that is the user's call, not yours.`

**done** — `This task is closed. Nothing further is worked on under it; if the
user wants more, that is a new task.`

Without these lines the machine is decoration. The test is the one used for
profiles: the same question asked in two stages has to come back visibly
different.

---

## 5. What happens on each edge

| edge | model calls | state changes |
| --- | --- | --- |
| `planning → execution` | **1** (`Briefer`) | writes a *pending* brief; **the stage does not move** |
| *accept the brief* | 0 | brief `accepted`, `through` set, stage moves, goal freezes |
| `execution ⇄ validation` | 0 | log entry; `step` and `expectedAction` reset to the stage's defaults |
| `execution → planning` | 0 | log entry; **goal thaws** |
| `validation → done` | **1** (`Promoter`) | working cleared into `pastTasks` with its route and brief; proposals raised; brief cleared |
| *start a new task* | 0 | fresh task in `planning`, `previous` set; brief cleared |

### Leaving planning is a handoff

`→ execution` does not move the stage. It makes one `Briefer` call — the same
shape as `Promoter`: a model call at a stage edge whose output is a *proposal* —
and hands you the result in an editable box. **Accepting it is what leaves
planning.** Then the planning messages stop being sent and `<brief>` stands in
for them.

| | |
| --- | --- |
| `<working>` | the keys — an index, capped at twenty words a value |
| `<brief>` | the description — what the task *is*, in prose you approved |

The stage waits for the accept rather than moving on the click, and that is the
one asymmetry with `→ done`, which moves immediately and leaves its proposals
pending. The difference earns the extra step: a promotion proposal is about
long-term memory and changes nothing about the task in hand, while the brief *is*
what the task in hand runs on from here. A task sitting in `execution` with an
unreviewed brief would be running on exactly the messages the brief replaced. A
failed `Briefer` call leaves the task in planning with nothing pending, for the
same reason — half a handoff drops the conversation and puts nothing in its
place.

Entering `done` clears the brief along with the keys: it describes work that is
over, and left on the wire it would go on telling every later turn what the
finished task was about. Cleared is not deleted — it goes into `pastTasks`,
where it is the most readable thing a closed task leaves behind.

**The floor it set outlives it.** `briefThrough` is a separate field from
`brief.through` for exactly this reason: clearing the brief must not put the
messages it replaced back on the wire. It only ever moves forward, and a
successor task inherits it — the planning of a finished task does not come
back when the next one starts.

### Model proposals about the task

The extractor may put three task ops in its patch:

```json
[{"op":"step",  "value":"writing the migration script"},
 {"op":"awaiting","actor":"user","what":"confirm the March 14 date"},
 {"op":"stage", "to":"validation","reason":"the script is written"}]
```

`step` and `awaiting` are **written** — descriptive, gate nothing, and a status
line nobody will click a button to keep fresh goes stale in two turns and is then
worse than nothing. `stage` is **not**: it becomes a suggestion rendered beside
the corresponding button, and the stage changes on a click or not at all. The
model is told what stage it is in; it is never consulted.

`splitTaskOps` separates the patch before either mutation path sees the other's
ops, so `applyOps` goes on refusing everything that is not a routable key and
`transition` goes on being the only way a stage changes.

---

## 6. Writes: two mutation paths, and nothing else

Everything that changes memory goes through `applyOps`; everything that changes
the stage goes through `transition`. One code path each means one place the
routing table is consulted, one place a malformed key is refused, and one thing
to test. A button in the UI cannot express a change the patch format cannot.

```js
applyOps({ working, profile }, ops, {
  allow,            // which of set | delete | promote are permitted here
  origin,           // 'model' | 'person' — decides whether the write happens
  source,           // 'declared' | 'learned' | null — what to stamp on long-term
  frozen,           // working keys the task has committed to
})
```

`origin` and `source` are deliberately separate: collapsing them makes *a person
approving a correction to a declared entry* — which keeps the entry declared —
unrepresentable.

Three write policies, all the same shape, all producing a **correction proposal**
rather than a silent write or a silent drop:

| policy | a model op is refused when | thaws when |
| --- | --- | --- |
| **declared wins** | the long-term entry's `source` is `declared` | never — a person edits it |
| **the freeze** | the key is in `frozenKeys(task)` — i.e. `goal`, outside planning | the task returns to `planning` |
| **one key, one block** | working and long-term hold the same key with different values | the human answers the proposal |

The freeze is also the goal-drift fix: drift is a planning-stage phenomenon, so
the write policy tightens at the moment the task is committed to rather than
being policed by a prompt for the whole conversation. A declared entry is never
shadowed by the task either — the user wrote it down on purpose and the thing
displacing it was inferred from one exchange.

Two more refusals worth naming, both of which *preserve* rather than destroy:

- A lone `delete` on an `open.*` is refused. A question is very often the only
  place a fact was ever written down, so closing it must record the answer in the
  same array.
- `promote` may only be sent by a person. Routing lets the extractor *write*
  long-term; erasing or promoting is asymmetric, because working memory is
  rebuilt every task and long-term is not.

### Two schedules, billed apart

Extraction runs on **every user turn** over the last exchange — it cannot wait
for the fold, because between folds a turn can slide out uncaptured. Folding runs
at the **high-water mark** through the same `Summarizer` the `summary` strategy
uses, on the same edge discipline: the digest's edge and the verbatim region's
edge are the same index, so no message is ever in neither.

| bucket | what it is | when it is paid |
| --- | --- | --- |
| `overheadWorking` | the extraction call, plus `Briefer` and `Promoter` at the edges | every user turn; the two once per task |
| `overheadSummary` | the fold | at the high-water mark |
| `overheadProfile` | the `<profile>` block riding in the turn's own request | every turn, used or not |

The third is not a call, and it is the one that lets long-term memory look free.
It is an estimate — four characters to a token — and carries `estimated: true`
so nothing downstream mistakes it for the measured figures beside it.

### Branching

Each branch owns a deep copy of `strategyState`, taken at fork time — which
means it inherits entries *and transitions* stamped after the fork point. Two
functions undo that:

- `entriesAsOf(working, turns)` — working keys stamped later are dropped.
- `taskAsOf(task, turns)` — the transition log is trimmed, and `step` /
  `expectedAction` fall back to the stage's defaults rather than to a parent's
  sentences.

A fork that inherited a `validation` its own branch never reached does not look
like a storage bug from the outside. It looks like the agent insisting on work
nobody on that branch ever asked for, with every stage line telling the model
something false about where it is.

---

## 7. HTTP surface

None of these is a turn: no persona, no reply, nothing appended to the
transcript. They read the record, hand the state to the strategy that owns it,
write the record back, and **drop that session's cached `Agent`** — the step that
is easy to forget and produces a memory that reverts itself on the next message.

| route | does |
| --- | --- |
| `POST /chat` | one turn; `strategy`, `profile`, window and ceiling are live controls |
| `POST …/memory/transition` | one edge of the machine. `→ execution` writes a brief and waits |
| `POST …/memory/brief` | `accept` (with edits) or `discard` |
| `POST …/memory/new-task` | a successor task, once `done` |
| `POST …/memory/proposals/:id` | `approve` (with edits) or `reject` |
| `POST …/memory/ops` | *forget*, *promote*, and the profile editor — the `applyOps` path |
| `POST …/memory/compare` | same message, N profiles, read-only |

A guarded or illegal edge returns **200 with `ok: false`** and the guard's own
sentence. The request was well formed and the answer is "no, and here is why",
which is a thing the UI renders rather than an error it reports.

---

## 8. The UI

**The stage strip** sits above the composer, always visible, because it answers
*whose turn is it* before you type rather than after you have typed something the
agent was not waiting for. Four dots, the `step` line, an `awaiting` line styled
distinctly by actor, and a button per currently-legal edge rendered from
`TRANSITIONS` filtered by the stage — so the UI cannot offer an edge the table
does not have. Disabled buttons carry the guard's reason.

**A transition changes the next reply's instruction; it does not produce a
reply.** The agent only ever answers a message. So when the stage is waiting on
the agent the strip offers `▶ let it continue`, which sends `expectedAction.what`
as the next turn. It is a button of its own rather than something the arrows do
quietly, because it costs a model call and a cost you did not press is a cost you
press four times by accident.

**The brief editor** replaces the strip's controls while a brief is pending —
rendering the arrows beside it would invite a click that skips the one step the
handoff exists for.

**The memory panel** draws the layers, the accepted brief, the proposals, the
discarded keys and what memory has cost. Every row has *forget*; promotable rows
have *promote*; a frozen `goal` carries a lock; corrections appear on the row
they are about rather than in a list you have to scroll to. The profile editor
writes through the same `/memory/ops` route, with one flag saying the sentences
came from a person — that flag is the whole of what `declared` means.

**The transcript** draws a thin divider at each transition, from the log —
consecutive clicks with nothing said between them collapse into one line.
Messages below the floor are greyed, and the boundary says which mechanism
replaced them: *"⟵ 2 planning messages replaced by the brief"* reads differently
from *"folded into the digest"*, and should.

**The resume banner** is composed from state with **no model call**: stage, step,
actor, and how long ago it last moved. That is the whole payoff of deriving the
stage from an append-only log.

---

## 9. Verifying it

```bash
npm test                        # 92 tests
npm run lifecycle               # the full cycle, including validation → execution
npm run lifecycle -- --fake     # offline; the machine still runs
npm run lifecycle -- --blocks   # print the <working> block after every turn
```

`scripts/lifecycle.js` walks `scenarios/migration-lifecycle.json`, where a step
is either something said or a button pressed, and asserts what the machine did
with each: the guard refusing an edge before there was a goal, the brief written
and accepted, the goal frozen, validation sending the work back to execution, and
the promotion call firing exactly once on the way into `done`. It drives
transitions through the same read-transition-write path the routes take, because
a demo that reached past the routes into the agent's own state would be
demonstrating something the app does not do.

The **restart test** is the one that matters for resume: `npm start` mid-task,
kill it, restart, reopen the conversation. The banner renders from state and the
agent's first reply continues the work instead of asking what it was.

### The five strategies, for context

`claude-haiku-4-5`, 15 turns, five planted facts recalled at the end. All-in is
the conversation plus whatever the strategy spent on its own calls.

| | | recall | all-in |
| --- | --- | :---: | ---: |
| `sliding` | last N exchanges | 0/5 | $0.02555 |
| `summary` | digest in the system prompt | 5/5 | $0.03061 |
| `facts` | key-value block, patch-based extraction | 4/5 | $0.03606 |
| `memory` | profile + working + brief + digest | 5/5 | $0.06250 |
| `full` | everything, every turn | 5/5 | **$0.02539** |

At fifteen turns, sending everything is still the cheapest thing that works, and
the whole difference between the rows is overhead. `full` grows quadratically
while `memory`'s per-turn cost is flat, so the curves cross — where exactly is
arithmetic on a 15-turn measurement, not a measurement. Pick `full` until it
hurts; pick `memory` when something has to survive the conversation, or when the
work has stages.
