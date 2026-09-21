# Day 14 — Invariants and State Constraints

Add **invariants** to `first-agent`: project-level rules the assistant must not
violate. They are stored outside the conversation, enforced in code where code
can decide, and in the prompt where only judgement can.

Read the project README before starting. Reuse the mechanisms it already
describes — `applyOps`, `splitTaskOps`, proposals, the stage edges, the routing
table. Do **not** add parallel machinery beside them.

**Hard constraint: no new model calls on the turn path.** Exactly one new call
is introduced, and it fires only when the user presses a button (§2).

---

## 1. Storage

A new namespace, `invariant`, in long-term memory.

```js
invariant: { layer: 'longterm', evict: 'never', personOnly: true },
```

- **Person-only.** The extractor may never write it, at any point in the
  conversation — not even via the `promotable` path that runs at the task
  boundary. A model-proposed invariant is always a proposal awaiting a human.
  A rule the assistant can write for itself is a rule it can also decide does
  not apply today, at which point it is not a constraint.

- **Keys carry a subject:** `invariant.database`, `invariant.orm`,
  `invariant.deploy`. The subject namespace is **shared** with `preference`,
  `rule` and `constraint`. This sharing is what makes collision detection a
  string match rather than a judgement (§4).

- **Entry shape:**

  ```js
  { text, check, supersedes?, id, updatedAt, turn }
  ```

  `check` says how you would know the invariant had been violated. It is
  required. An invariant with no usable check is not an invariant — see §2 for
  what happens to it.

- **Invariants belong to the project, not the user.** `data/memory/<user>.json`
  is keyed by the human; the same human has two codebases with two different
  rule sets. Add `data/invariants/<project>.json` behind a store interface,
  injected alongside the existing four. If the app has no natural project
  identifier, add one to the conversation record rather than overloading the
  user key.

- **Resolve the overlap with `rule`.** `rule` is currently long-term and
  extractor-writable, which is an invariant with weaker rules sitting one
  namespace away — the extractor will route into it and users will not know
  which they wanted. Pick one and document it:
  - `rule` becomes the invariant namespace under the new person-only policy, or
  - `rule` is narrowed to *how the user likes to work* and `invariant` is
    *what the project cannot do*.

  The test that separates them: **if this task were cancelled, would it still
  be true?** "Ship before March 14" would not be — that is a `constraint`.
  "Stays on Postgres" would be.

---

## 2. Authoring: typed prose in, structured proposals out

Invariants are written in prose by a person and structured by the model. This
keeps authoring cheap without letting the model legislate: the model drafts,
the human accepts, and **the accept is the write** — which is what keeps the
namespace person-only.

The shape is the same as `Briefer`: a model call at an explicit boundary whose
output is a proposal, never a mutation.

### UI

In the memory panel's invariants section:

- the **current invariants**, listed above the input — otherwise people retype
  rules they already have and get a wall of `amend` rows they do not understand
- a **textarea** for free prose: *"we're never moving off Postgres, no ORM,
  deploys go through CI only"*
- a **Propose** button. A button, not something riding on every turn: this
  costs a model call, and a cost you did not press is a cost you press four
  times by accident.

### Route

`POST …/memory/invariants/propose` — one model call, read-only, writes nothing.
Not a turn: no persona, no reply, nothing appended to the transcript. It
receives the typed text, all existing invariants, and all long-term entries.

It returns rows:

```js
{ action: 'add' | 'amend' | 'reject',
  key,            // invariant.<subject>
  text,           // the rule, one sentence
  check,          // how you would know it was violated
  supersedes?,    // amend: the entry id being replaced
  current?,       // amend: the existing text, so the box can diff it
  collisions: [], // existing long-term entries on the same subject
  reason?         // reject: why
}
```

Rules for the call:

- **One row per distinct rule.** Three rules in one sentence is three rows.
- **If the subject already has an invariant, the row is `amend`, never `add`.**
  This is the point of the feature: the model tells you *which* invariants
  change and how, rather than silently shadowing the old value.
- **If no usable check can be written, the row is `reject`**, with the reason
  *"this is a preference, not an invariant"* and a suggested
  `preference.<subject>` row offered instead. Twelve fuzzy invariants on the
  wire buys a model that hedges everything, which looks like compliance and is
  noise.
- **Collisions are reported, never resolved.**

### Review

Every row is fully editable before accept — key, text and check. Accept and
reject are **per-row**, not all-or-nothing. Accepting routes through the
existing `/memory/ops` path with `origin: 'person'`.

A failed propose call leaves the box empty and the typed text intact. Nothing
is written on a partial result.

The collision sweep (§4) runs **here, at propose time**, so conflicts land in
the same review box and the human resolves everything in one pass instead of
meeting a proposal row an hour later.

---

## 3. Payload

A new `<invariants>` block, placed **immediately after the persona** — before
`<profile>` — and present in **every stage, including `done`**. It is the only
block besides the persona that applies unconditionally: a closed task can still
be asked a question, and the answer can still violate a rule.

Contents: each invariant's text and check, plus two instruction lines.

```
<invariants>
Rules this project does not break. They outrank everything else in memory.
database: Stays on Postgres. — check: any proposal introducing another engine
orm: No ORM; SQL is written by hand. — check: any proposal importing an ORM
Do not propose solutions that violate these. If a request needs one broken,
name the conflict, offer the best alternative that fits inside the rule, and
if there is none, say so and say the rule can be amended by the user.
If another entry in memory conflicts with one of these, say so rather than
silently picking one.
</invariants>
```

The precedence line is load-bearing: two contradicting entries on the wire with
no stated order means the model picks one arbitrarily, differently each run.

Omit the block entirely when there are no invariants, like every other block.

---

## 4. Write-time enforcement — code, not prompt

One check, applied to **every** write in `applyOps`, regardless of target layer,
so `preference` gets the same treatment as `constraint`.

- If an op's key **subject** matches an invariant's subject → **refuse the
  write** and raise a correction proposal carrying both values and the
  invariant's check.
- This is the existing *"one key, one block"* policy generalised one notch. Do
  not add a second refusal mechanism.

**Do not build a semantic contradiction detector.** Code cannot tell that
"MySQL" contradicts "never move off Postgres". Subject collision only. False
positives are acceptable — a `preference.database` that happens to *agree* with
the invariant becomes a proposal row a human clicks through, which is cheap.
Structure the code so a `check` predicate could later gate the refusal, but do
not implement predicates now.

The important property is not catching every contradiction. It is that
**nothing lands in long-term on a subject an invariant owns without a human
seeing it.**

### The sweep

When a **new** invariant is accepted, sweep existing long-term for colliding
subjects and raise a proposal for each. Otherwise a rule arrives and quietly
sits on top of something that contradicts it, and you find out when the model
splits the difference.

### Promotions

A `Promoter` proposal at `→ done` that collides with an invariant renders the
conflict on the existing proposal row. Those are already human-approved. No new
machinery.

### The extraction prompt

Add a line telling the extractor not to propose entries that contradict the
invariants. This is a **filter, not a gate** — it reduces how often the case
arises; `applyOps` decides whether the write lands.

---

## 5. Answer-time refusal

Nothing reaches `applyOps` when the model suggests an ORM in a paragraph. That
is where the prompt block earns its place, and where the refusal has to be made
visible.

A new task op, split out by `splitTaskOps` alongside `step` / `awaiting` /
`stage`:

```json
{"op":"refused","invariant":"orm","request":"add Prisma for the migration",
 "alternative":"hand-written SQL migration in scripts/migrate/"}
```

**Written, not gating** — like `step` and `awaiting`. Rendered in the memory
panel on the invariant's own row, next to `discarded`. This is the visible
artefact of the whole feature: *"what happens when a request conflicts"*
becomes something you point at on screen rather than a transcript someone has
to read.

The refusal itself must always carry an exit. Model it on the existing
execution scope line: name the invariant, name what would violate it, propose
the best thing available **inside** the invariant, and if there is nothing, say
so and point at the amendment path (§6). A dead end is a bad refusal.

---

## 6. Amendment

Amending or deleting an invariant goes through `/memory/ops`, person-only, with
the supersession recorded (`supersedes`), and the superseded text kept in
`previous[]`.

An invariant that changed without a trace is worse than none — the entire value
of the mechanism is that it is stable, so every change must be visible after
the fact.

---

## 7. Stage edges — no new model calls

The existing checkpoints do the work. In order of cost, cheapest first:

| stage | what changes |
| --- | --- |
| **planning** | block is on the wire; a goal that requires a violation is flagged while it is still cheap to change |
| **`→ execution` (Briefer)** | receives the invariants. If the goal cannot be met without violating one, it says so **in the brief**, in the editable box, before the goal freezes. One prompt change on a call already billed. |
| **execution** | prose refusal per §5 |
| **validation** | the one-at-a-time enumeration gains a row per invariant: `pass \| fail \| unverified`. **`unverified` is a first-class verdict** and must never be reported as `pass` — from inside a chat it is the honest answer more often than people expect. |

Validation is the *last* place to catch a violation, not the first. Do not make
it the only one.

---

## 8. Verification

**Unit tests**

- the extractor cannot write `invariant`, at any stage, including at `→ done`
- a colliding write is refused and raises a proposal
- accepting a new invariant sweeps existing long-term and proposes per collision
- the propose route returns `amend` (not `add`) when the subject exists
- a rule with no usable check comes back as `reject`
- the refusal op is split correctly and never reaches `applyOps`
- `<invariants>` is present in all four stages, and absent when empty

**Eval**

Same message, run twice: `--invariants=none` and `--invariants=postgres-only`.
The two answers must differ visibly. If they do not, the block is decoration —
**report that rather than adjusting the test.** This is the test already used
for profiles.

**Scenario**

Add a step to `scenarios/` where a request conflicts with an invariant,
asserting the refusal op was emitted and no working key was written. Drive it
through the routes, as `scripts/lifecycle.js` already does — a demo that
reached past the routes would demonstrate something the app does not do.

---

## 9. README

Update it with: the new namespace and its person-only policy, the block's
position and its precedence line, the authoring flow and where the one model
call fires, the collision rule **and its known false positives**, the
`rule` / `invariant` line, and the amendment path.
