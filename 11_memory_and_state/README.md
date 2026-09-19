# first-agent

A minimal chat app — Express server, plain-HTML chat UI, reusable `Agent` behind
a provider-neutral LLM abstraction. Real tokens and cost per turn, and context
management as a **pluggable strategy**: five of them, switchable per
conversation, measured against each other by a scripted scenario.


https://github.com/user-attachments/assets/c4021fa3-62c8-4764-a67a-598e370a5ede



## Run

Node 20.11+. Without an API key the server falls back to `FakeProvider`.

```bash
npm install
npm test                              # stubs, no key, no network
echo 'ANTHROPIC_API_KEY=sk-ant-…' > .env
npm start                             # http://localhost:3000
npm run scenario -- --all --window=10 # the numbers below
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
so it composes with all five.

## Strategies and numbers

`claude-haiku-4-5-20251001`, 15 turns, five planted facts recalled at the end.
All-in: the conversation plus whatever the strategy spent on its own calls.

| | | w10 recall | w10 all-in | w5 recall | w5 all-in |
| --- | --- | :---: | ---: | :---: | ---: |
| `sliding` | last N exchanges | 1/5 | $0.02404 | 0/5 | $0.01940 |
| `summary` | digest in the system prompt, oldest half folded at a high-water mark | 5/5 | $0.03037 | 5/5 | $0.02927 |
| `facts` | key-value block, patch-based extraction, never regenerative | 5/5 | $0.03798 | 3/5 | $0.03089 |
| `memory` | profile + working memory + digest, three lifetimes | 5/5 | $0.04302 | 5/5 | $0.05034 |
| `full` | everything, every turn | 5/5 | **$0.02656** | 5/5 | **$0.02602** |

**At fifteen turns, sending everything is still the cheapest thing that works.**
Sliding's near-zero recall didn't say "I don't know" — it confidently asked to
start over. `facts` dropping to 3/5 at window 5 is extraction quality, not
capacity: the block never filled up, the name and the rejected option simply
never got extracted.

**The layered strategy is the most expensive and the most reliable.** It was the
only one besides `full` to answer 5/5 at both windows, and its *payload* is the
smallest of anything that remembers: $0.02406 of conversation at window 10,
against `full`'s $0.02656, `facts`'s $0.02705 and `summary`'s $0.02517. Only
`sliding` sends less, by two thousandths of a cent, and it recalls nothing.
Every cent of the difference is the two schedules: 15 extraction calls plus 2
folds at window 10, and 15 plus 6 at window 5. The panel bills them apart (`overheadWorking` and
`overheadSummary`) precisely because the fix differs — halving the window
doubles the folds and leaves extraction untouched.

Extrapolating the two curves from this run, `full`'s cumulative cost overtakes
`memory`'s somewhere in the mid-twenties of turns, because `full` grows
quadratically while `memory`'s per-turn cost is flat. That is arithmetic on a
15-turn measurement, not a measurement. What the run *does* establish is that
the layering buys recall and a smaller payload, and that at this length the
per-turn extraction call is what you are paying for.

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
| Long-term | profile, preferences, promoted decisions | `data/memory/<user>.json` | only an explicit delete |

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

**In the UI.** The panel draws the three sections plus the proposals and the
discarded keys; every row has *forget*, and promotable rows have *promote*, both
going through the same `applyOps` path as the extractor's patch. The per-turn
counter attributes the blocks inside the input figure — `512 in (140 profile, 98
task)` — by apportioning the measured block total across the blocks as they were
on that turn.

Two notes on what this cost the rest of the app. The task boundary needs a
server surface, so `memoryRoutes.js` is mounted with one line in `server.js`; it
writes through the conversation store and then drops that session's cached
`Agent`, since a cached agent would write stale memory back over it on the next
turn. And the panel's split of the input figure is an apportionment, not three
more token counts — an exact per-block measurement would mean three extra
`count_tokens` round trips per turn to answer a question about proportions.
