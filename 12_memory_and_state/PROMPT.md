# Day 12 — Personalizing the Assistant

Build on the `memory` strategy. Long-term memory already exists, is already
injected into every request, and is already keyed by user — this day makes it
**authorable**, **switchable**, and **comparable**.

Read `src/context/memory.js` before starting. Every invariant in it stays:
`applyOps` remains the only mutation path, long-term is patched and never
regenerated, and failure degrades the payload rather than the turn.

## 1. Missing routes (do this first)

`ROUTES` (`memory.js` 24) has no durable home for style, format or standing
rules. Today they land in `constraint` → working → deleted at *Finish task*.
That is the exact failure the README calls the recurring lesson.

Add long-term, never-expiring namespaces for them — `preference` already exists,
so this is mostly about the *meanings* table (`memory.js` 39) telling the
extractor which keys to use:

```
preference.style      tone, verbosity, persona-level wants
preference.format     bullets vs prose, code-first, length
rule                  hard standing constraints ("never use em-dashes")
```

Keep the distinction the router actually cares about: **durable vs task-scoped**,
not what the preference is about. Update the extractor prompt (`memory.js` 140)
with one example of each, and add a routing test asserting each new namespace
resolves to long-term.

## 2. Provenance: declared vs learned

Every long-term entry gains `source: 'declared' | 'learned'`. Existing entries
migrate to `learned`.

- **declared** — the user wrote it in the profile form.
- **learned** — the extractor proposed it and it was routed or approved.

Two rules, both enforced in `applyOps` (`memory.js` 365), which already knows
whether an op came from a model or a person:

**a. Declared wins.** A *model-originated* op targeting a key whose current
entry is `declared` does not write. It becomes a correction proposal in the
conversation record — the same shape `finishTask` already produces — reading
*you declared X, the conversation suggests Y*. Learned-over-learned keeps
overwriting as it does today. A person-originated op always writes.

**b. Declared entries are never shadowed.** Invariant 2 (one key, one block)
omits a long-term key from `<profile>` when the task holds it. Exempt declared
entries: they are always sent, and the working copy raises a correction proposal
instead. A declared preference must not be silently overridden by task state.

Working memory is unaffected by both rules.

## 3. Profile editor and picker

- **Editor**: a form in the memory panel writing directly to the profile store
  via the existing ops route (`memoryRoutes.js` 146), with `source: 'declared'`.
  Fields for style, format and rules, plus free-form key/value for the rest.
  Declared rows are visually marked in the panel and show their pending
  correction proposal, if any.
- **Picker**: `data/memory/<user>.json` is already parameterized — add a profile
  selector to the topbar and carry the id through to `JsonProfileStore`. Include
  at least two seeded profiles with sharply different preferences, for the
  comparison below.

## 4. Comparison view

Same message, same history, N profiles, side by side — the evidence that
personalization is doing anything.

**It must be strictly read-only.** Harder than the old strategy replay, because
`memory` extracts on every user turn: a comparison arm calls `buildPayload` and
the provider, then **discards the returned state** — no ops applied, no fold, no
writes to the profile store or the conversation record. Bill it into its own
`meta`, never into the conversation's totals.

Extraction is sampled, so sample each arm 3× and show all runs. One run is an
anecdote.

## 5. Cost

Add `usage.overheadProfile` beside the existing extraction and fold figures, so
the profile's per-turn cost is a number rather than a claim. The per-turn
counter already apportions `(140 profile, 98 task)` — keep that, and note in
the README that it remains an apportionment, not a separate measurement.

## Not building

- A per-conversation override scope. Working memory already covers anything
  task-shaped; a fourth scope before the third has been lived with is how the
  abstraction leaks.
- Asking the model which preferences it used. It will confabulate. The evidence
  is structural: the panel lists what was sent, and two profiles answering the
  same question differently is the demo.

## Verify

- Routing test: each new namespace → long-term, never cleared by *Finish task*.
- `applyOps` tests: model op onto a declared key → proposal, no write; person op
  onto the same key → writes; learned-over-learned → writes.
- Shadowing test: task holds a key the profile declares → both rules fire
  (profile still sent, correction proposed).
- Read-only test: run a comparison, assert the profile store and conversation
  record are byte-identical afterwards.
- Demo scenario: one question, two profiles — *terse, no code, assume novice*
  vs *dense, code first, assume expert*. The answers should be unrecognisable
  as coming from the same system.
