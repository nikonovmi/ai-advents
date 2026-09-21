# first-agent — memory and task state

A chat app whose interesting part is what goes on the wire. Five kinds of state
with five lifetimes, and a task with an explicit lifecycle that decides what the
model is told and what it is allowed to change.

This README is about **state**: where it lives, who may write it, how it moves,
and exactly what each stage is passed. The rules a project does not break have a
document of their own — [INVARIANTS.md](INVARIANTS.md).


https://github.com/user-attachments/assets/254e0ee4-0793-47af-ace8-2cbe4c3ab3c5


```bash
npm install
npm test                              # 139 tests, stubs, no key, no network
echo 'ANTHROPIC_API_KEY=sk-ant-…' > .env
npm start                             # http://localhost:3000
npm run lifecycle                     # one task through every stage
npm run scenario -- --all --window=10 # the five strategies, compared
npm run compare -- --profiles=plain-english,code-first
```

---

## 1. Where state lives

`Agent` owns a persona and a branching conversation. It holds no URL, no key, no
`fetch`, and no opinion about what goes on the wire. Five things are injected:

| | answers | keyed by |
| --- | --- | --- |
| `LlmProvider` | who is the model | — |
| `ConversationStore` | where the conversation lives | a session |
| `ContextStrategy` | **what goes on the wire** | — |
| `ProfileStore` | what we know about the *user* | a person |
| `InvariantStore` | what the *project* may not do | a project |

A strategy owns `buildPayload(history) → {system, messages, state}` and an
opaque `state` the `Agent` never inspects. That is what makes a fifth strategy a
new file plus one registry line rather than a new branch in `run()`. Two rules
hold for all five:

- **Strategy calls are billed separately.** A saving whose cost has been added
  to the thing it is measured against is not a measurement.
- **Failure degrades the payload, never the turn.** A summary that could not be
  written or an extraction that failed is logged, the previous state is kept,
  and the turn is answered anyway.

```
src/
  agent.js                 persona, branches, retry, the five-step turn
  server.js                HTTP; mounts memoryRoutes with one line
  memoryRoutes.js          the task boundary as HTTP — none of it is a turn
  context/
    patch.js               the patch format: key grammar, routing table, op vocabulary
    memory.js              the memories, the blocks, applyOps
    invariants.js          the <invariants> block and the call that drafts rules
    taskState.js           the lifecycle: TRANSITIONS, guardFor, transition
    boundaries.js          payload must open on a user message; pairs never split
  store/
    branches.js            messages gain id/parentId; each branch owns strategyState
    profileStore.js        data/memory/<user>.json — outlives every conversation
    invariantStore.js      data/invariants/<project>.json — outlives every user
```

---

## 2. Five lifetimes

| | holds | lives in | ends when |
| --- | --- | --- | --- |
| **Short-term** | recent exchanges verbatim | the conversation record | it falls past a floor (§4) |
| **Digest** | a rolling summary of what scrolled past | `strategyState.memory.digest` | never; rewritten at each fold |
| **Working** | `goal`, `constraint`, `finding`, `open`, `decision`, `agreement`, the stage, the brief | `strategyState.memory`, per branch | the task reaches `done` |
| **Long-term** | `profile`, `preference`, `rule`, promoted decisions | `data/memory/<user>.json` | only an explicit delete |
| **Invariants** | `invariant.*` — what the *project* may not do | `data/invariants/<project>.json` | only an explicit, human delete |

The digest is compressed short-term, **not** a layer of its own: the digest
records *what was discussed*, working memory records *what is currently true
about the work*. Long-term lives outside `data/conversations/` — delete the
conversation and the profile is still there. Invariants live outside both,
because one human has two codebases with two different rule sets.

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
  invariant:  { layer: 'longterm', evict: 'never', personOnly: true, project: true },
};
```

- `layer` — which memory the key lives in. An unrecognised namespace is
  **discarded and logged**, never guessed at.
- `evict: task` — cleared when the task reaches `done`.
- `promotable` — may be offered for long-term at the task boundary. A goal or an
  open question is over when the task is; a decision can outlive it.
- `personOnly` — **no model op ever writes it**, whatever `allow` says and
  whatever stage the task is in. One namespace has it; see
  [INVARIANTS.md](INVARIANTS.md).
- `singular` — `goal` is the only key that may be a bare namespace. A task has
  one goal; a user has a role *and* a city *and* a team, so a bare `profile`
  would be a whole layer collapsed into one slot.

### State shape

```js
strategyState.memory = {
  working:   { 'goal': { value, updatedAt, turn, previous: [] }, … },
  task:      { id, previous, transitions: [], step, expectedAction, expectedBy,
               stepTurn, expectedTurn, suggestion, refused: [], refusals: [] },
  brief:     { text, status: 'pending'|'accepted', turn, through, edited,
               open: [] } | null,
  briefThrough: number,         // the floor it set; outlives the brief itself
  digest:    string | null,
  digestThrough: number,        // message index the digest covers to
  pastTasks: [],                // closed tasks: entries, route, brief
  proposals: [],                // promotions, corrections, collisions
  discarded: [],                // ops that were refused, with the reason
  promotedAt: {},               // entry id → turn, so a fork cannot read ahead
  profileSeen: {}, profileUser, invariantsSeen: {}, invariantProject,
  attribution: [], usage: {},
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
maintaining: the transcript's dividers, the audit trail, and
resume-after-restart.

### Guards

`guardFor(from, to, working) → true | reason` is a pure function of state, and
the reason string *is* the disabled button's tooltip.

| edge | rule | effect |
| --- | --- | --- |
| any | not in `TRANSITIONS` | **blocked**, discarded and logged |
| `planning → execution` | no `goal` recorded | **blocked** |
| `planning → execution` / `→ done` | an `open.*` key on the list | **warns**, proceeds on confirm |

**The warning has one source: `open.*` keys.** It used to have two — the second
read the `awaiting` field, on the argument that the `open.*` rule is one
paragraph in a long extractor prompt and the turn it matters on is the busy one.
It was removed with the op. A second tripwire in a representation with no key,
no row and no way to close bought a second chance to record the fact and paid
with a second chance to be wrong in a form you could only argue with — which is
what it did: *"confirm whether to use iterative DFS instead of recursive"*, about
an assumption the reply had stated, citing an invariant nobody can override,
repeated for three turns.

The warning also says **"recorded as open"**, not "unanswered". The two are a
whole turn apart: extraction runs before the reply, so at the moment anyone reads
that dialog the newest reply is unread and may well have answered the thing.

### Model proposals about the task

The extractor may put three task ops in its patch:

```json
[{"op":"step",  "value":"writing the migration script"},
 {"op":"stage", "to":"validation","reason":"the script is written"},
 {"op":"refused","invariant":"orm","request":"add Prisma",
  "alternative":"hand-written SQL in scripts/migrate/"}]
```

`step` and `refused` are **written** — descriptive, they gate nothing, and a
status line nobody will click a button to keep fresh goes stale in two turns.
`stage` is **not**: it becomes a suggestion rendered beside the corresponding
button, and the stage changes on a click or not at all. The model is told what
stage it is in; it is never consulted.

There was a fourth, `awaiting`, and it is gone — see *Three fields on the task*.
An op still arriving is refused by `applyTaskOps` and recorded in *discarded*,
naming the two keys it should have been: an unanswered question is an `open.*`,
a stated assumption is a `decision.*`.

---

## 6. Writes: two mutation paths, and nothing else

Everything that changes memory goes through `applyOps`; everything that changes
the stage goes through `transition`. One code path each means one place the
routing table is consulted, one place a malformed key is refused, and one thing
to test. A button in the UI cannot express a change the patch format cannot.

```js
applyOps({ working, profile, invariants }, ops, {
  allow,          // which of set | delete | promote are permitted here
  origin,         // 'model' | 'person' — decides whether the write happens
  source,         // 'declared' | 'learned' | null — what to stamp on long-term
  frozen,         // working keys the task has committed to
  acknowledged,   // keys a person has already answered a collision on
})
```

`origin` and `source` are deliberately separate: collapsing them makes *a person
approving a correction to a declared entry* — which keeps the entry declared —
unrepresentable.

Four write policies, all the same shape, all producing a **correction proposal**
rather than a silent write or a silent drop:

| policy | a write is refused when | thaws when |
| --- | --- | --- |
| **declared wins** | the long-term entry's `source` is `declared` and the op came from a model | never — a person edits it |
| **the freeze** | the key is in `frozenKeys(task)` — i.e. `goal`, outside planning | the task returns to `planning` |
| **one key, one block** | working and long-term hold the same key with different values | the human answers the proposal |
| **the invariant check** | the key's *subject* is owned by an `invariant.*` **and the key is long-term** | the human answers the proposal |

The freeze is the goal-drift fix: drift is a planning-stage phenomenon, so the
write policy tightens at the moment the task is committed to rather than being
policed by a prompt for the whole conversation.

Two more refusals worth naming, both of which *preserve* rather than destroy: a
lone `delete` on an `open.*` is refused, because a question is very often the
only place a fact was written down; and `promote` may only be sent by a person,
because working memory is rebuilt every task and long-term is not.

### The patch format, and the one rule that keeps it honest

`patch.js` owns the key grammar, the routing table, the op vocabulary, the
coercion and the split into the two mutation paths. It used to be five scattered
readers, each dropping what it did not recognise in its own way.

A model returns a patch as JSON, and the part it gets wrong is never the content
— it is the **envelope**: the key in the `op` field, the verb missing, a verb it
invented, an array wrapped in prose. `coerceOp` reads through it with two rules
that cannot invent anything — a key in the verb's place with a value is a `set`,
and a routable key with a value and no verb anyone knows is a `set` — while a
verb that *is* known stays what it says, so `promote` from a model is refused and
named rather than rewritten into something allowed.

But coercion always runs out. The property is:

> Every item in a patch either **lands** or is **reported, with a reason**.
> There is no third outcome.

`readPatch` hands back what could be used *and* what could not; `applyTaskOps`
does the same; every caller merges both into the panel's *Proposed, not stored*
list beside `applyOps`'s own refusals. `src/context/patch.test.js` is the census,
with one test asserting the three piles account for every item that went in — so
the shape nobody predicted is a line in the panel rather than a fact that quietly
never existed.

### Two schedules, billed apart

Extraction runs on **every user turn** over the last two exchanges — the newest
user message, the exchange before it, and the reply above that. One exchange was
nearly enough, since extraction runs *before* the reply and so never reads the
user late; what it could not do is recover from a turn that failed, because the
exchange a timed-out extractor could not read was never in the window again. Two
means a dropped turn heals on the next one. It is not what would close the
one-turn lag on the assistant's own reply, since no window can contain the
message being written into it; see the note on the lag below.

Folding runs at the **high-water mark** through the same `Summarizer` the
`summary` strategy uses: the digest's edge and the verbatim region's edge are the
same index, so no message is ever in neither. The edge stops at the live task's
work and resumes at `→ done`.

| bucket | what it is | when it is paid |
| --- | --- | --- |
| `overheadWorking` | extraction, plus `Briefer` and `Promoter` at the edges | every user turn; the two once per task |
| `overheadSummary` | the fold | at the high-water mark |
| `overheadProfile` | the `<profile>` block riding in the turn's own request | every turn, used or not |

The third is not a call, and it is the one that lets long-term memory look free.
It is an estimate — four characters to a token — and carries `estimated: true` so
nothing downstream mistakes it for the measured figures beside it.

**Extraction runs before the model answers, and that costs one turn of lag.** The
exchange it reads ends with the message you just sent, so the *reply* to that
message is not read until the next turn. The ordering buys something real — a
preference stated in this message shapes the answer to this message — and it
costs anything the **assistant** establishes: in planning it asks six questions
and the task shows nothing open until you say something else. There is no second
call to close that with, so the panel says so, and the `Briefer` at the handoff
catches what the lag would otherwise lose.

Widening the extraction window does **not** shorten it, and it is worth being
clear why: the window already contains the previous reply, so everything the
assistant established is read before the next answer is built. What is missing is
only the reply being written right now, and no amount of history reaches forward
into it.

**One case out of that is closed, and it is the one that was not cosmetic.** A
reply very often answers an open question itself — *"the starting node is passed
as a parameter… everything's clear, we can switch to execution now"* — and until
something read that reply, `open.starting_node` stayed on the list, the edge
warning went on reporting it, and the only way out was a person deleting a row
that had been answered in front of them. So when `<working>` carries at least one
`open.*` row, it asks for one thing back:

```
<memory-close>{"key":"open.starting_node","answer":"Passed as a parameter by the caller"}</memory-close>
```

`MemoryStrategy.afterTurn` parses those out of the finished reply, turns each into
the pair the store already wants — `set decision.<subject>` and `delete open.<subject>`
— and hands the Agent the reply with the fences removed. **It is the only place
the answering model writes to memory, and it costs no call**: the call was already
made, and `afterTurn` reports no usage because it spent nothing.

It is scoped as narrowly as it can be. The only keys it may name are the `open.*`
rows printed directly above it; the only thing it may say is *this one is
answered, and here is the answer*; the write goes through `applyOps` with
`origin: 'model'`, so the frozen goal, declared profile entries and invariant
subjects are protected exactly as during extraction; and `open.X` lands on
`decision.X` by the router's rule that where a fact lives is a lookup, never a
judgement — one drawer over from a `finding.*`, both task-scoped, and the
extractor can still correct it next turn on its own call at temperature 0. A
close naming a key that is not on the list, or one that is not JSON, is stripped
from the reply and reported in *discarded* rather than written.

Everything else the reply establishes is still a turn behind, and the trade is
unchanged: `buildPayload` keeps the extraction pass in front of the answer,
because a preference stated in this message shaping the answer to this message is
worth more than a current panel.

### Branching

Each branch owns a deep copy of `strategyState`, taken at fork time — which means
it inherits entries *and transitions* stamped after the fork point. Two functions
undo that:

- `entriesAsOf(working, turns)` — working keys stamped later are dropped.
- `taskAsOf(task, turns)` — the transition log is trimmed, and `step` /
  `expectedAction` fall back to the stage's defaults rather than a parent's
  sentences.

A fork that inherited a `validation` its own branch never reached does not look
like a storage bug from the outside. It looks like the agent insisting on work
nobody on that branch ever asked for.

Invariants are **not** filtered this way: they are not established by a
conversation, so there is no point in its history at which they were not already
true.

---

## 7. HTTP surface

None of these is a turn: no persona, no reply, nothing appended to the
transcript. They read the record, hand the state to the strategy that owns it,
write the record back, and **drop that session's cached `Agent`** — the step that
is easy to forget and produces a memory that reverts itself on the next message.

| route | does |
| --- | --- |
| `POST /chat` | one turn; `strategy`, `profile`, `project`, window and ceiling are live controls |
| `POST …/memory/transition` | one edge of the machine. `→ execution` writes a brief and waits |
| `POST …/memory/brief` | `accept` (with edits, and what to leave out) or `discard` |
| `POST …/memory/new-task` | a successor task, once `done` |
| `POST …/memory/proposals/:id` | `approve` (with edits) or `reject` |
| `POST …/memory/invariants/propose` | one model call, read-only, writes nothing |
| `POST …/memory/ops` | *forget*, *promote*, the profile editor, and accepting an invariant — the `applyOps` path |
| `POST …/memory/compare` | same message, N profiles or N rule sets, read-only |

A guarded or illegal edge returns **200 with `ok: false`** and the guard's own
sentence. The request was well formed and the answer is "no, and here is why",
which is a thing the UI renders rather than an error it reports.

**A conversation nobody has spoken in yet is a real state, not a 404.** The page
mints a session id when it opens and the record is written on the first turn, so
treating a missing record as an error meant every button in the panel was dead
until you had typed something. The empty single-branch record is conjured, and it
reaches disk only if the handler succeeds.

---

## 8. The UI

**The strategy-and-cost row** sits at the top, collapsible: the controls decide
the payload and the chart is the bill for it, so they are one block rather than
one above the transcript and one below it.

**The stage strip** sits above the composer, always visible, because it answers
*whose turn is it* before you type. Four dots, the `step` line, an `awaiting`
line styled by actor (the stage's own sentence — nothing writes it), and a button per currently-legal edge rendered from
`TRANSITIONS` — so the UI cannot offer an edge the table does not have. Disabled
buttons carry the guard's reason.

**A transition changes the next reply's instruction; it does not produce a
reply.** So when the stage is waiting on the agent the strip offers
`▶ let it continue`, which sends `expectedAction.what` as the next turn. It is a
button of its own because it costs a model call — and it never appears in
`planning`, because nothing may write `actor: 'agent'` there.

**The brief editor** replaces the strip's controls while a brief is pending, and
lists what planning left unanswered with a `×` on each.

**The memory panel** draws the layers, the accepted brief, the proposals, the
discarded keys and what memory has cost. Rows are normally *what this branch was
sent on its last turn* — a snapshot, stamped, branch-local, so a fork shows what
*it* was told. A branch with no turns has no snapshot, and drawing an empty panel
from it says *there is nothing* when the truth is *nothing has been sent yet*, so
a caller that has read the stores hands them in. Both follow the pickers: the
panel answers *what would the next turn be sent*.

**The transcript** draws a thin divider at each transition, from the log.
Messages below the floor are greyed, and the boundary says which mechanism
replaced them: *"⟵ 2 planning messages replaced by the brief"* reads differently
from *"folded into the digest"*, and should.

**The resume banner** is composed from state with **no model call**: stage, step,
actor, and how long ago it last moved. That is the whole payoff of deriving the
stage from an append-only log.

---

## 9. Verifying it

```bash
npm test                        # 139 tests
npm run lifecycle               # the full cycle, including validation → execution
npm run lifecycle -- --fake     # offline; the machine still runs
npm run lifecycle -- --blocks   # print the <working> block after every turn
```

`scripts/lifecycle.js` walks `scenarios/migration-lifecycle.json`, where a step
is either something said, a rule authored or a button pressed, and asserts what
the machine did with each: the guard refusing an edge before there was a goal,
the brief written and accepted, the goal frozen, a request meeting the invariant
that forbids it, validation sending the work back to execution, and the promotion
call firing exactly once on the way into `done`. It drives transitions through
the same read-transition-write path the routes take, because a demo that reached
past the routes would demonstrate something the app does not do.

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
