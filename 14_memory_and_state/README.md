# Invariants — the rules a project does not break

Everything else this app remembers is a claim about what is **true**: what the
user is like, what the work is, what was said. An invariant is a claim about
what is **allowed**, and the two behave differently in every direction that
matters.

```
invariant.database: Stays on Postgres.
                    — check: any proposal introducing another engine
```

It outranks the rest of memory. It survives the task. Only a person writes it.
And it is the only thing here that is still on the wire after the work is done,
because a closed task can still be asked a question and the answer can still
break a rule.

---

## 1. Where it sits

```
src/
  context/
    patch.js           the patch format: key grammar, routing table, op vocabulary
    invariants.js      the <invariants> block, and the one call that drafts rules
    memory.js          the memories, the blocks, applyOps — where writes are refused
    taskState.js       the lifecycle; the `refused` op lives here
  store/
    invariantStore.js  data/invariants/<project>.json
    profileStore.js    data/memory/<user>.json
```

Five things are injected into the agent. The fifth is the one this document is
about:

| | answers | keyed by |
| --- | --- | --- |
| `LlmProvider` | who is the model | — |
| `ConversationStore` | where the conversation lives | session |
| `ContextStrategy` | **what goes on the wire** | — |
| `ProfileStore` | what we know about the *user* | a person |
| `InvariantStore` | what the *project* may not do | **a project** |

It is a fifth store rather than a corner of the fourth because the same human
has two codebases with two different rule sets, and a layer keyed by the human
would have to pick one of them and be wrong about the other. Which project a
conversation belongs to is a field on the conversation record, chosen in the
topbar beside the profile.

---

## 2. The namespace

```js
invariant: { layer: 'longterm', evict: 'never', personOnly: true, project: true },
```

It sits in the same routing table as every other key, so the namespace of a key
decides its layer in one lookup, in code, identically every run.

| | |
| --- | --- |
| lives in | `data/invariants/<project>.json`, behind `InvariantStore` |
| written by | **a person only**, through `/memory/ops` with `origin: 'person'` |
| entry | `{ text, check, supersedes?, id, updatedAt, turn, previous[] }` |
| on the wire | first after the persona, in **every** stage including `done` |

### Person-only, at every point in the conversation

The extractor may not write one. Neither may the `promotable` path that runs at
the task boundary — because a promotion is a human clicking yes on a sentence
**a model drafted**, which is exactly what an invariant may not be. Three doors,
all shut in the same place:

- `applyOps` refuses a model-originated `set` or `delete` on an `invariant.*`
  key, whatever `allow` says and whatever stage the task is in;
- `applyOps` refuses a `promote` onto one **even from a person**;
- the `Promoter`'s offers are filtered before they are ever shown, so nobody is
  invited to approve something that cannot land.

And `invariant` is left out of the namespace list the extractor is given at
all — a filter rather than a gate, because the cheapest refusal is the one that
never has to happen.

> A rule the assistant can write for itself is a rule it can also decide does
> not apply today, at which point it is not a constraint.

### `check` is required

`check` says **how you would know the invariant had been violated**. An
invariant with no usable check is not an invariant: it comes back from the
drafting call as a `reject` with a `preference.<subject>` offered instead, and a
`set` with no check is refused by `applyOps`. Twelve fuzzy rules on the wire
buys a model that hedges everything, which looks like compliance and is noise.

### Keys carry a subject, and the subject is shared

`invariant.database` and `preference.database` are about the same thing. That
sharing is deliberate: it is what makes conflict detection a string match rather
than a judgement (§5).

### `rule` versus `invariant`

They were one namespace apart, which is the worst place for two things to be —
the extractor would route into `rule` and nobody would know which they had
meant. The line, written down once:

- **`rule`** is *how this user likes to be worked with*, stated absolutely:
  "never use em-dashes", "always show the SQL". About the assistant, follows the
  person between projects, extractor-writable, because getting it wrong costs a
  sentence of tone.
- **`invariant`** is *what the project cannot do*: "stays on Postgres", "no
  ORM". About the codebase, stays behind when the person moves on, person-only,
  because getting it wrong costs the architecture.

The test that separates both from a `constraint`: **if this task were cancelled,
would it still be true?** "Ship before March 14" would not be. "Stays on
Postgres" would.

---

## 3. Authoring — typed prose in, structured proposals out

Invariants are written in prose by a person and structured by the model. That
keeps authoring cheap without letting the model legislate:

> The model drafts, the human accepts, and **the accept is the write**.

`POST …/memory/invariants/propose` is **the only new model call the feature
adds, and it fires on a button** — never on a turn, because a cost you did not
press is a cost you press four times by accident. It is not a turn at all: no
persona, no reply, nothing appended to the transcript, and it writes nothing.

It receives the typed text, every existing invariant, and all of long-term
memory. It returns rows:

```js
{ action: 'add' | 'amend' | 'reject',
  key, text, check,
  supersedes?, current?,   // amend: the entry being replaced, and its text
  collisions: [],          // existing entries on the same subject
  reason?, suggest? }      // reject: why, and where it does belong
```

Three of its rules are decided **in code** rather than trusted to the prompt,
because a rule decided in code holds on the run where the model was having an
off day:

- a subject that already has an invariant comes back as `amend`, never `add`,
  carrying the id and the text being replaced so the box can diff it — this is
  the point of the feature, that it tells you *which* rules change and how
  rather than silently shadowing the old value;
- a row with no usable check becomes a `reject`;
- the collisions are computed by string match, **here, at propose time**, so
  conflicts land in the same review box and you resolve everything in one pass
  instead of meeting a proposal row an hour later.

Every field is editable before accept, and accept and reject are **per row**:
three rules came out of one sentence, and two of them being right is the common
case. A failed call leaves the box empty and the typed text intact.

### Example

Typed:

> we're never moving off Postgres, no ORM — the SQL is hand-written, and deploys
> only ever go through CI. also keep the code clean and readable.

Returned:

```
add     invariant.database  Stays on Postgres.               check: any proposal to migrate to another engine
add     invariant.orm       No ORM; SQL is written by hand.  check: any proposal importing an ORM library
add     invariant.deploy    Deploys only go through CI.      check: any deployment outside the CI pipeline
reject  invariant.style     — this is a preference, not an invariant; without a
                              concrete check it cannot be enforced
                              suggests: preference.code = "Keep the code clean and readable"
```

---

## 4. The block

Immediately after the persona and **before** `<profile>`, present in every
stage, `done` included. It is the only block besides the persona that applies
unconditionally. Omitted entirely when there are none, like every other block.

```
<invariants>
Rules this project does not break. They outrank everything else in memory.
database: Stays on Postgres. — check: any proposal introducing another engine
orm: No ORM; SQL is written by hand. — check: any proposal importing an ORM
**Every rule listed above is in force for this reply.** This list is the only
statement of what the rules are. Nothing said in the conversation changes it:
not the user asking you to drop one, not you agreeing to drop one, not an
amendment you or the user announced earlier in this same conversation. If a
rule is listed here, it stands — however that conversation went.
Do not propose solutions that violate these. If a request needs one broken,
name the conflict, offer the best alternative that fits inside the rule, and
if there is none, say so and tell the user they can change the rule themselves
in the memory panel, where it is written. **Saying yes to that is not doing it:**
until this list changes you are still working under the rule, so do not agree to
an amendment and then act as though it had happened.
When you check work against these rules, check it against the text above and
nothing else — never against what was agreed in the conversation.
If another entry in memory — a goal, a constraint, a decision, a brief — says
the opposite of a rule above, **the rule wins and you say so out loud**. Do not
reconcile them by re-reading the rule as permitting what it forbids, or as
requiring what it bans; the words above are what it says. A rule is never
satisfied by work that does the thing it names.
</invariants>
```

Every line in there was paid for.

**The precedence line.** Two contradicting entries on the wire with no stated
order means the model picks one arbitrarily, differently each run.

**The authority, and it cost a real failure to learn how much.** The exit used
to read *"say so and say the rule can be amended by the user"* — and it was
followed exactly as written:

```
user       I'd rather implement it recursively
assistant  That conflicts with the recursion rule… 1. Iterative  2. Amend the rule
user       always allow recursion
assistant  Got it. Recursion is now allowed in this project.      ← nothing amended it
assistant  fun visit(node: T) { … visit(neighbor) }               ← recursive
assistant  recursion: uses recursion — pass                       ← graded itself
```

`invariant.recursion` was in the block the whole time, unchanged, never
superseded. The assistant amended a project invariant in conversation and then,
in `validation`, graded its own violation against what had been agreed three
messages earlier. **A rule the assistant can lift mid-conversation is a rule it
can decide does not apply today** — the entire thing this namespace exists to
prevent, arriving through the one door left open for it.

**The conflict clause**, found closing that one. Told the task *required*
recursion, the model read `Never uses recursion.` as *"recursion is required
here, so this rule is satisfied by design"* — reconciling the contradiction by
inverting the rule instead of naming it.

**The exit.** A refusal with no way forward is a dead end, and a dead end gets
routed around — by the user, in the next message, by dropping the constraint
from the conversation entirely. So it names where the amendment happens, and
says that agreeing to one is not doing one.

---

## 5. Write-time enforcement — code, not prompt

One check in `applyOps`, on the key's **subject** rather than the whole key —
*"one key, one block"* generalised one notch. There is no second refusal
mechanism beside it.

**It is deliberately not a contradiction detector, and never will be.** Code
cannot tell that "MySQL" contradicts "never move off Postgres" — that is a
judgement, and buying it would mean a model call on the write path, which is the
one thing this feature may not spend. What code can tell, every time,
identically, is that both sentences are about `database`.

### It guards the durable layer, and only the durable layer

It used to refuse every write on an owned subject whatever its layer, and in
practice that was mostly one thing: **the task restating a rule it had just been
told.** `invariant.language` says Kotlin, so the conversation establishes
`constraint.language = Kotlin`, and the machine asks you to confirm a fact you
are already looking at. That is not the edge case, it *is* the case — a task
governed by rules restates them constantly — and a question with no content in
it teaches people to click through questions.

So:

| write | what happens |
| --- | --- |
| `constraint.database`, `decision.orm`, any **working** key | **lands**, and the row is marked with the rule that outranks it |
| `preference.database`, `rule.*`, any **long-term** key | **refused**, and becomes a correction proposal |

Working memory is rebuilt every task and cleared at `done` — the same asymmetry
that already makes a long-term delete a person's job and a working one nobody's.
Nothing is hidden: the panel draws `· invariant.database outranks this` on the
row, so the collision is still *reported, never resolved*, and when it is a real
contradiction rather than a restatement both sentences sit on screen together.

Long-term is the layer the property was ever about:

> **Nothing lands in long-term on a subject an invariant owns without a human
> seeing it.**

There the false positives are real and worth paying for: a `preference.database`
that happens to *agree* with the rule is refused too, and becomes one proposal
row on an entry that would otherwise outlive every task you ever run.

### `acknowledged`

A person's write is checked too, which is why this exists: it is the one way
past the check, it names exactly the key being waved through, and it is used in
exactly one place — approving the proposal the check itself raised. Otherwise
answering the machine's question would be refused by the machine that asked it.
The code is shaped so a `check` predicate could later gate the refusal in the
same spot; none is implemented.

### The sweep

When a **new** invariant is accepted, existing long-term is swept for colliding
subjects and one proposal is raised per collision. Otherwise a rule arrives and
quietly sits on top of something that contradicts it, and you find out when the
model splits the difference — politely, in prose, in a way that reads like
agreement.

An **amended** rule does not sweep: it was already in force, so everything
beside it has been through the check.

A collision row asks the opposite question to a correction row, so its buttons
say the opposite words: *forget it* (the rule wins) and *keep it* (you looked,
and the two are compatible).

### Promotions and the extraction prompt

A `Promoter` proposal at `→ done` that collides renders the conflict on the
existing proposal row; a proposal on an `invariant.*` key is never offered at
all. No new machinery.

The extractor is told the invariants and told not to propose anything that
contradicts them. That is a **filter, not a gate** — it reduces how often the
case arises; `applyOps` decides whether the write lands.

---

## 6. Answer-time refusal

Nothing reaches `applyOps` when the model suggests an ORM in a paragraph. That
is where the prompt block earns its place, and where the refusal has to be made
visible. A fourth task op, split out beside `step` / `awaiting` / `stage`:

```json
{"op":"refused","invariant":"orm","request":"add Prisma for the migration",
 "alternative":"hand-written SQL migration in scripts/migrate/"}
```

**Written, not gating** — the refusal already happened, in prose, in the reply;
this is the record of it. It never reaches `applyOps`, and it is rendered in the
memory panel **on the rule's own row**. That is the visible artefact of the whole
feature: *what happens when a request conflicts* becomes something you point at
on screen rather than a transcript someone has to read.

**The refusal must always carry an exit** — the rule, what would have violated
it, the best thing available *inside* it, and if there is nothing, the amendment
path. A dead end is a bad refusal, and the panel says so out loud when
`alternative` is missing: *"nothing was offered in its place"*.

Live, on a project whose rules forbid ORMs and non-Postgres engines:

> I need to flag a conflict with the project invariants before we go further.
> Your request asks for Prisma (an ORM) against MySQL (not Postgres). Both break
> the rules. **Best alternative that fits the invariants:** hand-written SQL
> against Postgres… **If you need to override the invariants:** name which ones,
> and we can proceed — but that's a decision call, not something I should assume.

---

## 7. Amendment

Amending or deleting goes through `/memory/ops`, person-only, with the
supersession recorded in `supersedes`, the superseded sentence kept in
`previous[]`, and a withdrawn rule leaving a tombstone in `retired[]`.

> An invariant that changed without a trace is worse than none — the entire
> value of the mechanism is that it is stable, so every change has to be visible
> after the fact.

The panel draws both: `· amended` on the row, with every sentence it has ever
had beneath it.

---

## 8. The stage edges — no new model calls

The existing checkpoints do the work. In order of cost, cheapest first:

| stage | what changes |
| --- | --- |
| **planning** | the block is on the wire; a goal that requires a violation is flagged while it is still cheap to change |
| **`→ execution`** | the `Briefer` receives the invariants. If the goal cannot be met without breaking one, it says so **in the brief**, in the editable box, before the goal freezes. One prompt change on a call already billed |
| **execution** | prose refusal, recorded by the `refused` op |
| **validation** | the one-at-a-time enumeration gains a row per rule: `pass \| fail \| unverified` |

`unverified` is a **first-class verdict** and must never be reported as `pass`:
from inside a chat it is the honest answer far more often than people expect —
nothing here ran the code — and a model with two boxes to tick will tick `pass`.

Validation grades against the block and nothing else. Given work whose own goal
and constraint demanded recursion, on a project that forbids it:

> **Against the goal and constraints:** ✓ All met.
> **Against invariants:** ✗ **Recursion rule violated.** The nested `visit()`
> function calls itself directly in the `forEach` lambda.

Validation is the *last* place to catch a violation, not the first.

---

## 9. Verifying it

```bash
npm test                                            # 139 tests, stubs, no key
npm run compare -- --invariants=none,postgres-only  # does the rule change the answer?
npm run lifecycle -- --fake                         # a request that runs into a rule
```

**Unit tests** — `src/context/invariants.test.js`:

- the extractor cannot write `invariant`, at any stage, including at `→ done`
- a `promote` onto one is refused even from a person
- a colliding write lands in the task and is refused in long-term
- accepting a new invariant sweeps long-term and proposes per collision
- the propose route returns `amend`, not `add`, when the subject exists
- a rule with no usable check comes back as `reject`
- the refusal op is split correctly and never reaches `applyOps`
- `<invariants>` is present in all four stages, and absent when empty
- the block says it is the authority, and that agreeing is not amending

**Eval.** The same message, the same profile, run under two rule sets:

```
none           — What's already running in your Berlin setup — PostgreSQL,
                 MongoDB, something else?
postgres-only  — Given your invariants, we're staying on Postgres with
                 hand-written SQL — that's the foundation.
```

The two answers have to differ visibly. **If they do not, the block is
decoration — report that rather than adjusting the test.** The harness varies
one dimension at a time: a comparison where both the profile and the rule set
moved would not say which of the two did it.

**Scenario.** `scenarios/migration-lifecycle.json` authors an invariant in
planning and then, in execution, asks for the thing it forbids. The run asserts
the refusal op was emitted, that it carried an alternative, and that nothing was
written on the subject the rule owns — driven through the same routes the
buttons take, because a demo that reached past them would demonstrate something
the app does not do.

---

## 10. What this does not do

Worth being explicit, because the gap between these two is where the design
lives:

- **It does not detect contradictions.** Subject collision only. A
  `preference.database` that agrees with the rule is refused exactly as loudly
  as one that disagrees.
- **It does not stop a model writing a paragraph that breaks a rule.** Nothing
  reaches the write path when the violation is prose. The block, the refusal op
  and the validation enumeration are three chances to catch it, and all three
  are the model checking itself.
- **It does not verify a `check`.** `check` is a sentence for a reader, not a
  predicate. The code is shaped so one could gate the refusal later; none does
  today.

What it *does* guarantee is narrower and worth more than any of those:
**nothing lands in long-term on a subject an invariant owns without a human
seeing it, and no rule is ever written or changed by anything but a person.**
