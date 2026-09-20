# first-agent

A minimal chat app — Express server, plain-HTML chat UI, reusable `Agent` behind
a provider-neutral LLM abstraction. Real tokens and cost per turn, and context
management as a **pluggable strategy**: five of them, switchable per
conversation, measured against each other by a scripted scenario.


https://github.com/user-attachments/assets/ae0361be-d8e7-4ac0-85e0-8beb4d24b556


## Run

Node 20.11+. Without an API key the server falls back to `FakeProvider`.

```bash
npm install
npm test                              # stubs, no key, no network
echo 'ANTHROPIC_API_KEY=sk-ant-…' > .env
npm start                             # http://localhost:3000
npm run scenario -- --all --window=10 # the numbers below
npm run compare -- --profiles=plain-english,code-first   # one question, two people
```

## Design

Four abstractions injected into `Agent`, which holds no URL, key, `fetch` or
vendor name: `LlmProvider` (who is the model), `ConversationStore` (where the
conversation lives), `ContextStrategy` (what goes on the wire) and — new with
the memory model — `ProfileStore` (where what we know about the *user* lives,
outside any conversation). A strategy owns `buildPayload` and an opaque `state`
the `Agent` never inspects, so a fifth one is a new file and a registry line:
`memory.js` plus one line in `context/index.js`, with nothing changed in
`agent.js`. Its calls are billed separately; its failures degrade the payload,
not the turn. Two silent-failure rules live in `boundaries.js`: the payload must
open on a user message, and a turn pair is never split. Nothing is deleted from
the store — cropping affects only what is sent. Branching is a storage change
(messages gain `id`/`parentId`, each branch owns a deep-copied `strategyState`),
so it composes with all five. *Which* profile a turn reads and writes is a live
control like the window and the token ceiling: the Agent pushes it onto the
strategy per turn through a `useProfile` hook that four of the five inherit as a
no-op, so the class that holds no URL and no key holds no notion of a user
either.

## Strategies and numbers

`claude-haiku-4-5-20251001`, 15 turns, five planted facts recalled at the end.
All-in: the conversation plus whatever the strategy spent on its own calls.

| | | w10 recall | w10 all-in | w5 recall | w5 all-in |
| --- | --- | :---: | ---: | :---: | ---: |
| `sliding` | last N exchanges | 0/5 | $0.02555 | 0/5 | $0.01858 |
| `summary` | digest in the system prompt, oldest half folded at a high-water mark | 5/5 | $0.03061 | 5/5 | $0.03250 |
| `facts` | key-value block, patch-based extraction, never regenerative | 4/5 | $0.03606 | 4/5 | $0.03196 |
| `memory` | profile + working memory + digest, three lifetimes | 5/5 | $0.06250 | 5/5 | $0.06558 |
| `full` | everything, every turn | 5/5 | **$0.02539** | 5/5 | **$0.02753** |

**At fifteen turns, sending everything is still the cheapest thing that works.**
Sliding's zero recall didn't say "I don't know" — it confidently asked to start
over. `facts` missing one at both windows is extraction quality, not capacity:
the block never filled up, the fact simply never got extracted.

**The layered strategy is the most expensive and the most reliable.** It and
`full` were the only two to answer 5/5 at both windows. What it is *not*, at
this length, is the smaller payload the previous run suggested: the five
conversations cost between $0.02539 and $0.02559 at window 10 — a spread of two
hundredths of a cent, which is noise. The entire difference between the
strategies in that table is overhead, and for `memory` that is two schedules:
15 extraction calls plus 2 folds at window 10, and 15 plus 6 at window 5. The
panel bills them apart (`overheadWorking` and `overheadSummary`) precisely
because the fix differs — halving the window doubles the folds and leaves
extraction untouched.

`memory` also got dearer this time round, and the reason is legible rather than
mysterious: the extractor's system prompt grew by about a fifth when the durable
namespaces and their examples were added to it, and that prompt is re-sent on
every user turn. Measured back to back on the same day, the previous extractor
ran the same scenario at $0.05608 against this one's $0.06250. A routing table
you extend by teaching a prompt has a per-turn price, and it is worth knowing
which line item it lands on.

`full` grows quadratically while `memory`'s per-turn cost is flat, so the two
curves still cross — later than the previous run implied, since the flat line
moved up. Where exactly is arithmetic on a 15-turn measurement, not a
measurement. What the run *does* establish is that at this length the per-turn
extraction call is the whole of what you are paying for.

Pick `full` until it hurts, then `facts` with a narrow window, `summary` when
narrative matters more than values, and `memory` when something has to survive
the conversation.

## The memory model

`memory` is the fifth strategy, and the only one with an opinion about *time*.
Three layers, three lifetimes, one wire format:

| Layer | What | Lives in | Ends when |
| --- | --- | --- | --- |
| Short-term | recent exchanges verbatim + a rolling digest | the conversation record | it slides out of the window |
| Working | `goal`, `constraint`, `finding`, `open`, `decision`, `agreement` | `strategyState`, per branch | the user finishes the task |
| Long-term | `profile`, `preference` (incl. `.style`, `.format`), `rule`, promoted decisions | `data/memory/<user>.json` | only an explicit delete |

```
system:   [persona] + <profile>…</profile> + <working>…</working> + [digest]
messages: the exchanges since the digest's edge, verbatim
```

The digest is compressed short-term, **not** a fourth layer, and not a second
copy of working memory: the digest records *what was discussed*, working memory
records *what is currently true about the work*. Long-term deliberately lives
outside `data/conversations/`, which is the whole point — delete the
conversation and the profile is still there.

**Explicit routing.** The extractor proposes a key and never a layer. The
namespace of that key is looked up in one table in `memory.js`, in code,
identically every run:

```js
const ROUTES = {
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

**A misfiled fact is usually a missing row.** Both namespaces added after the
first build came from the same failure: something had nowhere to go, so it was
filed under whatever was nearest and the consequences followed from *that*
namespace's rules. "I'm a senior Android developer" had no `profile.*` and was
dropped. "He couldn't implement DFS without help" had no `finding.*`, was filed
as `open.candidate.dfs_performance` — a *question* — and two turns later, when
the exchange answered the question, the only record of the DFS struggle was
deleted along with it. The lesson is not about prompts: a namespace whose rules
do not fit the fact will apply them anyway.

**And it happened a third time, to the most obvious facts of all.** Tone,
length, format and standing rules — "keep it short", "bullets please", "never
use em-dashes" — had no durable home either. `preference` existed, but nothing
told the extractor that a request about *how to answer* belonged there, so they
landed as `constraint.*`, which is task-scoped, and were deleted at the next
*Finish task*. The one kind of thing a user expects never to have to repeat was
the one kind the system reliably forgot.

The fix is mostly not a new layer. The router draws one distinction — **durable
vs task-scoped** — and `preference` was already durable; what was missing was
the *meanings* table naming `preference.style` and `preference.format` directly,
so the extractor has somewhere obvious to put them. `rule` is a namespace of its
own because a standing rule is not a want: "I prefer bullets" and "never use
em-dashes" behave differently when they disagree with each other, and they read
differently in the block the model is handed. Ask of a sentence *when it stops
being true* — at the end of this task, or never — and the routing follows:
"keep this migration plan under two pages" is a `constraint.*`, "keep your
answers short" is a `preference.style`.

One more line had to be added to `<profile>` for any of this to do anything.
Told only that something is "known about this user", a model reads *prefers
bullets* as biography and answers in prose anyway; the block now says out loud
that the `preference.*` and `rule.*` lines are standing instructions to follow
in this reply and every reply. It is emitted only when there is such a line to
follow, so a profile of pure biography does not pay for it.

Closing an open question therefore has to record its answer. The extractor is
told to emit the `delete` and the `set` in one array, and `applyOps` refuses a
lone `delete` on an `open.*` key — a question is very often the only place a
fact was ever written down, so erasing it is not resolution. A person clicking
*forget* may still close one without answering it.

`goal` is `singular`, and it is the only one: a task has one goal, so a bare
`goal` is a key. A user has a role *and* a city *and* a team, so a bare
`profile` is not a key — it is a whole layer collapsed into one slot where each
new fact silently overwrites the last, permanently, because long-term never
expires. Every namespace but `goal` needs a sub-key or the write is refused.

`profile.*` is who the user is — role, team, stack — and it is there because
its absence was a real bug: with `preference` as the only route to long-term,
"I'm a senior Android developer" had **nowhere to go**, so it was dropped, and
the only thing that survived a finished task was a fact about somebody else.
The table is also the whole of the fix: a missing layer is a missing row.

Being conservative applies to *rewriting what is stored* and to nothing else.
That distinction had to be spelled out to the extractor after the anti-drift
rules made it conservative about everything: on one real conversation, the turn
where the user said *"alright, I'll look for a flat there, I'm ready to pay
more"* recorded nothing at all — no decision, no loosened budget, and the
`open.*` key holding a question the assistant had already answered stayed open.
A store that has stopped moving is as wrong as one that never settles.

An unrecognised namespace is **discarded, not guessed at** — and logged, so the
panel can say *proposed, not stored: `random.thing`* rather than looking like a
turn on which the extractor found nothing. The patch discipline is the one
`facts` established: the model may only emit `[{op:"set"|"delete", key, value}]`
and `applyOps` applies it in code. `promote` is a third operation that only a
human can send, which is what makes an approval an approval.

**A patch against something visible.** The extractor is shown everything
already stored *with its current values*, not just the key names. Names alone
make "do not restate what has not changed" an instruction the model cannot
follow: unable to see what `goal` currently says, it rewrites it in the
vocabulary of whatever was said last, every single turn. Replaying one real
conversation six turns long, key-names-only produced 8 rewrites across 3 runs
(the goal rewritten 4 times, ending on a restatement of the last message);
values plus a rule that *zooming in is not a change of goal* produced 2, with
the goal untouched in all three. The panel marks a rewritten key `⟲n`, because
drift is the failure a memory block cannot show by itself — every version of a
rewritten key looks right, since every version agrees with the newest message.

**One key, one block.** A key the current task holds is sent from `<working>`
and left out of `<profile>`, and the long-term copy is not rewritten — it is
offered back as a *correction* to approve. Routing is by namespace, so a
`decision.*` always lands in working even when a copy of that exact key was
promoted to long-term two conversations ago; without the collision rule, "we
fired him" would update working while the profile went on telling every future
conversation that he was hired. The payload states it once, from the more
recent of the two, and the human decides what long-term should say.

**Two schedules.** Extraction runs on every user turn, over the last exchange —
it cannot wait for the fold, because between folds a turn can slide out of the
window uncaptured, and a digest is the wrong input for a constraint stated once
in passing. Folding runs at the high-water mark through the same `Summarizer`
the `summary` strategy uses, on the same edge discipline: the digest's edge and
the verbatim region's edge are the same index, so no message is ever in neither.

**The task boundary is a button, not a heuristic.** "Finish task" makes one
promotion call (working memory in, long-term proposals out, each one *rephrased
to stand alone* — `constraint.latency = "200ms"` means nothing next week), shows
you each proposal to approve or edit, and clears working memory. There is no
`openTask` op, no status field and no switch detection: the next thing you say
starts the next task implicitly. Clearing is not deleting — the closed record
moves to `pastTasks` and simply stops being sent. Pending proposals live in the
conversation record and expire with it; nothing is ever auto-approved, because
an auto-approval turns the explicit policy back into an implicit one.

The promoter is asked for what the work says **about the user**, never what
happened in it. That distinction is load-bearing: asked for durable facts, it
promoted *"the candidate was hired as a Senior Android Developer"* — true,
useless, about somebody else, and false within the month. Asked what the
decision says about the user, the same conversation yields *"Willing to overlook
a weak algorithms screen when system design and domain depth are strong."* One
of those survives firing him.

If you never press the button, working memory degrades to `facts` with an LRU
budget at `maxWorking`. That is the documented failure mode, not a surprise.

**Stamping.** Long-term entries promoted on a branch carry the turn they were
promoted at, and `factsAsOf` applies to them exactly as it does to working
memory: a branch cannot read what its parent promoted after the fork. A leak
there would not present as a storage bug — it would present as the model
hallucinating something nobody on that branch ever said.

**In the UI.** The panel draws the three sections plus the proposals, the
discarded keys and what memory has cost so far; every row has *forget*, and
promotable rows have *promote*, both going through the same `applyOps` path as
the extractor's patch. Declared rows are marked *you declared this* and carry
their pending correction inline, on the row it is about rather than in a list
you have to scroll to — a correction you answer without seeing what it would
replace is not much of an approval. The per-turn counter attributes the blocks
inside the input figure — `512 in (140 profile, 98 task)` — by apportioning the
measured block total across the blocks as they were on that turn. The profile
editor, the topbar picker and the comparison view are below.

Two notes on what this cost the rest of the app. The task boundary needs a
server surface, so `memoryRoutes.js` is mounted with one line in `server.js`; it
writes through the conversation store and then drops that session's cached
`Agent`, since a cached agent would write stale memory back over it on the next
turn. And the panel's split of the input figure is an apportionment, not three
more token counts — an exact per-block measurement would mean three extra
`count_tokens` round trips per turn to answer a question about proportions.

## Declared and learned

Every long-term entry says where it came from. `declared` means the user wrote
it in the profile form. `learned` means the extractor proposed it and it was
routed or approved — which is every entry written before this field meant this,
because nobody had declared anything yet. Two values and no more, because the
only question the rest of the system asks of the field is whether a *model* may
overwrite the entry; anything finer-grained is recorded elsewhere and would make
that question ambiguous.

Both rules live in `applyOps`, which already knew whether a patch came from a
model or a person:

**Declared wins.** A model-originated `set` onto a key whose current entry is
`declared` does not write. It becomes a correction proposal in the conversation
record — the same shape the task boundary produces — reading *you declared X,
the conversation suggests Y*. Learned-over-learned keeps overwriting exactly as
before; a person-originated op always writes. The op is kept rather than dropped
because the model is not so much wrong as unaware: it has read one exchange, and
the user has read their own profile.

**Declared entries are never shadowed.** *One key, one block* omits a long-term
key from `<profile>` when the task holds it, on the reasoning that the task is
the more recent statement. For a fact about the work that is right. For
something the user wrote down about how they want to be answered it is exactly
wrong — they said it on purpose, in a form, and the thing displacing it was
inferred from one exchange. So a declared entry is always sent, and the
disagreement becomes the same correction proposal. Working memory is untouched
by either rule: both rows are still there and both are still on the wire from
`<working>`.

`origin` and `source` are kept apart in `applyOps` on purpose: `origin` is who
sent the patch and decides whether the write happens, `source` is what to stamp
on what gets written. Collapsing them into one field was the first thing tried,
and it makes *a person approving a correction to a declared entry* —
which keeps the entry declared, because they are still the one deciding what it
says — unrepresentable.

## The editor, the picker and the comparison

**The editor** is a form in the memory panel — pick `memory` in the strategy
selector and it is there, under the Profile section, beside *Compare profiles* —
with fields for style, format and rules, plus free-form key/value for the rest.
It does **not** wait for a turn to have been taken, which was the first thing
that was wrong with it: the profile is long-term memory, it exists before this
branch has said a word, and making you talk to the assistant before you could
tell it how to talk to you had the dependency backwards. When a branch has no
memory state yet the panel is drawn from an empty one — the layers are empty
because nothing has been sent, the editor and the picker are not, because they
are about the store rather than about this turn. It writes through the *same*
`/memory/ops` route the panel's *forget* and *promote* buttons use, with one
extra flag saying the sentences came from a person — that flag is the whole of
what `declared` means, and a form with its own endpoint would be a second write
path into long-term with no test behind it. There is no proposal step, because a
proposal is a question addressed to you and you are the one typing. Emptying a
field is a `delete`, which is how the form takes something back. A rule is keyed
by a slug of its own text (`rule.never-use-em-dashes`, not `rule.r3`), so
rewording one moves it to a new key and the old key is deleted. `applyOps`
refuses a declared write to a task-scoped namespace outright: a `constraint.*`
typed into a field labelled *how I like to be answered* would be deleted at the
next *Finish task*, which is the failure the durable namespaces exist to end,
arriving through a different door.

**The picker** is in the topbar rather than in the conversation, because whose
profile this is is not a property of the conversation: the same chat can be
continued as someone else. The id rides on `/chat` and on every memory route as
a live control, exactly like the window and the token ceiling, and the Agent
pushes it onto the strategy per turn through a `useProfile` hook that four of
the five strategies inherit as a no-op. `data/memory/<user>.json` was already
parameterised, so the store needed nothing but a `list()`. The panel records
*which* profile each turn was built with, so after a switch it says "above: what
was sent last turn, as X; the next turn will use Y" rather than quietly showing
one profile's entries under another's name.

**The comparison** is the same message, the same history, N profiles, side by
side — three samples each, all shown, because extraction is sampled and one run
is an anecdote.

It is strictly read-only, and that is the hard part. `memory` extracts on every
user turn, so an arm is a whole turn: nine extraction calls whose patches all
want to be written, a digest wanting to fold, and three profile stores wanting
to change because somebody *looked*. The discipline is enforced in three places
rather than trusted once — every arm gets a `ReadOnlyProfileStore` that loads
through and swallows writes; the `state` returned by every `buildPayload` is
discarded, so no op is applied and no proposal recorded; and the route
deliberately does not go through the save-everything helper the other memory
routes share. The test asserts the profile files are byte-identical and the
conversation record unchanged afterwards. The bill goes into its own `meta`:
folding the cost of measuring into the number being measured is not a
measurement.

Nothing asks the model which preferences it used — it would confabulate. The
evidence is structural: the result carries the exact `<profile>` block each arm
was sent, and two profiles answering the same question differently is the demo.

```
npm run compare -- --profiles=plain-english,code-first --samples=3
```

One question — *how does a bloom filter avoid false negatives?* — two seeded
profiles, three runs each, `claude-haiku-4-5`:

| | `plain-english` | `code-first` |
| --- | --- | --- |
| declared | terse, plain words, analogies, never any code | dense, code first, assume expert, no preamble |
| opened with | "A bloom filter can't actually avoid false negatives — that's the trade-off." | "It doesn't avoid them—it eliminates them by design." |
| and then | *a bouncer*, *a guest list with checkboxes*, *invisible ink* | *k* independent hash functions, tunable false positives, "use a quotient filter" |
| three runs | 978 in / 409 out · $0.00943 | 1,084 in / 540 out · $0.01060 |

Both arms get the same fact right, which is the model answering the question.
Everything else — the register, the analogy or its absence, the preamble or its
absence, whether "hash function" is a word you are assumed to know — is the
profile, and it holds across all three runs of each arm.

Three runs is also the sample that stops you over-reading one. The `code-first`
arm opened with a runnable Go snippet in two of three runs on an earlier
sampling of this same question, and with dense prose in all three here: "code
first" moves the register reliably and the literal code block only sometimes.
A single run would have reported either of those as a fact.

The whole comparison — 12 calls, 3,011 tokens, $0.02003, 14.2s — is billed to
itself, and `git status` on `data/memory/` is clean afterwards.

## What the profile costs

`usage.overheadProfile` sits beside the two call bills, and it is the only one
of the three that is not a call: the `<profile>` block is input tokens in the
turn's *own* request, on every turn, whether or not anything used it. Leaving it
out of the ledger is what lets long-term memory look free.

| | what it is | when it is paid |
| --- | --- | --- |
| `overheadWorking` | the extraction call | every user turn |
| `overheadSummary` | the fold, through `Summarizer` | at the high-water mark |
| `overheadProfile` | the `<profile>` block on the wire | every turn, used or not |

The third is an **estimate** — four characters to a token — and the bucket
carries `estimated: true` so nothing downstream can mistake it for the measured
figures beside it. Measuring it exactly would mean a second `count_tokens` round
trip per turn to answer a question about proportions. What it has to be is
consistent: two profiles compared against each other are measured by the same
ruler, however approximate. The `plain-english` profile above is 209 tokens a
turn, or $0.0002 at Haiku input rates — small, and paid on every turn for the
life of the profile. The 15-turn scenario further up paid $0.00085 for its
profile block, against $0.03262 of extraction; the scenario harness prints the
three buckets side by side under the comparison table.

The per-turn counter's `(140 profile, 98 task)` split is a different number and
still an **apportionment**, not a measurement: the block total under a reply is
measured (the server counted the request twice, once with the blocks and once
without) and the split across the three blocks is that total divided by how big
each block was on the turn it was sent. An exact per-block count would need three
more `count_tokens` round trips per turn.
