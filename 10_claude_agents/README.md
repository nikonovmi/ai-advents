# first-agent

A minimal chat app: an Express server, a plain-HTML chat UI, and a reusable
`Agent` class behind a provider-neutral LLM abstraction. It reports real tokens
and cost per turn, and context management is a **pluggable strategy** — four of
them, switchable per conversation, measured against each other by a scripted
scenario rather than argued about.


https://github.com/user-attachments/assets/592fd24b-cec4-4d2e-92a4-5dbc664f42d7


## Run

Node 20.11+.

```bash
npm install
npm test                              # stub providers, no key, no network
npm run scenario -- --all --fake      # the comparison harness, offline
echo 'ANTHROPIC_API_KEY=sk-ant-…' > .env
npm start                             # http://localhost:3000
npm run scenario -- --all --window=10 # the real numbers below
```

Without a key the server falls back to `FakeProvider` — no network. If a request
says the key *"is not scoped to a workspace"*, also set `ANTHROPIC_WORKSPACE_ID`.

Three controls sit by the composer: **Strategy** (the four below, switchable
mid-conversation), **Window (exchanges)** (2–100, default 10), and **Max
tokens** (the reply cap — set it to 30 to see a truncated reply saved to history
mid-sentence). Above the transcript is the **branch bar**; hovering any message
offers **Fork from here**.

## Layout

```
src/
  llm/
    provider.js    the abstraction (LlmProvider + LlmError)
    anthropic.js   AnthropicProvider + FakeProvider
    pricing.js     the price table, estimateCost, formatCost, formatTokens
  context/
    strategy.js       the abstraction (ContextStrategy + overhead accounting)
    boundaries.js     the boundary rules every strategy shares
    slidingWindow.js  crop and forget — the cost floor
    summarization.js  the running summary, folded at a high-water mark
    facts.js          patch-based fact extraction + FactExtractor
    fullHistory.js    everything, every turn — the recall ceiling
    index.js          the registry
    context.test.js   boundary rules, all four strategies, fact patching
  store/
    conversationStore.js  the abstraction (ConversationStore + normalisers)
    branches.js           the message graph: ids, parents, branches, forking
    jsonFileStore.js      one JSON file per conversation
    memoryStore.js        the same contract, backed by a Map
  agent.js         the Agent and the personas
  agent.test.js    strategy wiring, branch isolation, loading old files
  summarizer.js    the Summarizer — folds old exchanges into a running summary
  server.js        Express routes and session bookkeeping
scenarios/
  requirements-gathering.json   15 scripted turns, 5 checkable facts
scripts/scenario.js             the comparison harness
public/index.html               the chat UI
data/conversations/             saved conversations, one file each
```

Three abstractions, all injected into `Agent`, so it contains no URL, no key, no
`fetch`, no vendor name — and no opinion about what goes on the wire:

```js
async complete({ system, messages, temperature, maxTokens, model })
// → { text, model, stopReason, usage: { inputTokens, outputTokens } }
async countTokens({ system, messages, model })  // → { inputTokens }

async load(sessionId) / save(sessionId, messages, usage, graph) / clear(sessionId)

async buildPayload({ history, systemPrompt, state, provider, model })
// → { system, messages, state, meta }
async afterTurn({ history, state, provider, model, userMessage, reply })
// → { state, usage, ms }
```

Anthropic's `stop_reason` and `input_tokens` become `stopReason` and
`inputTokens` in `anthropic.js` and nowhere else. Failures normalise to
`LlmError` with a `status`, which is how the Agent knows to retry a 429 or 5xx
(three attempts, 500/1000/2000 ms).

Conversations are written atomically (`.tmp` then `rename()`) with the full
history, never the cropped view. Records written by earlier versions still load:
a missing `usage` key, missing overhead fields, an absent summary, messages with
no ids and no branch map all read back as a one-branch conversation that has
cost nothing, not as a parse failure. The browser imports the server's own
`pricing.js` from `GET /pricing.js`, so a number in the UI is formatted by
exactly the code that priced it.

## The payload, and the two boundary rules

Every request is a system string and a message array. What goes in them is the
strategy's business, but two rules hold for all four, and `boundaries.js` is the
one place that enforces them — because both fail silently:

1. **The payload must open on a user message.** The Messages API rejects a
   `messages` array whose first entry is an assistant turn. A crop that counts
   messages instead of exchanges lands on one about half the time — an
   intermittent 400 that depends on nothing but the parity of the conversation.
2. **A turn pair is never split.** A question whose answer is outside the
   payload, or an answer whose question is, is worse than neither: the model
   reads half an exchange as a whole one.

Both come out of the same move — `snapToUserMessage` walks the boundary back to
the user message that opens the turn it landed inside. `context.test.js` checks
every window size against a history of 10 and of 11, and then checks that
**every strategy's** payload opens on a user message at both parities, because a
rule that only the strategy that happened to import the helper obeys is not a
rule.

Nothing is ever deleted from the store. Cropping applies only to what is sent.

## Strategies

`ContextStrategy` answers the third question the Agent should not have an
opinion about. `LlmProvider` answers *who is the model*, `ConversationStore`
answers *where does the conversation live*, and this one answers **given
everything that has been said, what actually goes on the wire**.

A strategy owns exactly two things:

- **`buildPayload`** — turn a history into this turn's system string and message
  array. It never mutates the history it is handed.
- **`state`** — whatever it needs between turns. JSON-serialisable, owned by the
  strategy, persisted by the store, and **never inspected by the `Agent`**. That
  last part is what makes a fifth strategy a new file and a line in the registry
  rather than a new branch in `run()`. Even the right-hand panel is built by the
  strategy itself (`panel(state)` → `{ kind, … }`), so nothing above the
  boundary reads a field belonging to one particular strategy.

Two rules hold for every implementation:

- **Strategy calls are billed separately.** Overhead is reported in its own
  `meta.strategy` and its own `usage.overhead*` totals, never folded into the
  conversation's. A saving whose cost has been added to the thing it is being
  compared against is not a measurement.
- **Failure is non-fatal.** A summary that could not be written or facts that
  could not be extracted degrade the payload; they do not cost the user their
  turn. Each strategy handles its own expected failures, and `Agent` catches the
  unexpected kind and falls back to a plain window.

### `sliding` — the cost floor

The last N exchanges, verbatim. No state, no calls, and whatever leaves the
window is gone: the model will tell you it was never told. Every other strategy
is an argument that recall is worth the difference between its bill and this one.

### `summary` — a running digest in the system prompt

Day 9's scheme, moved out of `Agent` unchanged. `contextMessages` is a
**high-water mark**, not a sliding window: verbatim exchanges accumulate until
there are that many, then the oldest **half** is folded into the summary in one
go.

```
[u1 a1 u2 a2 u3 a3 u4 a4 u5 a5 u6]     6 exchanges — at the mark
 └──────── fold these 3 ────────┘
[summary][u4 a4 u5 a5 u6 a6]           and the reply lands here
```

**The two edges touch, and that is the whole point.** `summarizedThrough` is
both where the summary ends and where the verbatim messages begin, so every
stored message is either folded in or on the wire — never in neither. That
failure mode is easy to build by accident: crop to a sliding window and
summarise the overflow "every N messages", and between compressions the messages
that have left the window but not yet reached the summary are invisible — and
they are the *most recent* of the dropped ones, the ones most likely to still
matter. Measured on an earlier build, with a window of 5 and a batch of 10, it
sawtoothed up to **8 invisible messages** before every compression.

The fold size is half the window, which makes the scheme self-pacing: fold less
and the summarizer runs almost every turn, fold more and the verbatim region
collapses right after each one. **That coupling is the cost dial, and it runs
the wrong way from intuition — halving the window doubles how often you pay.**
At window 10 this scenario folds twice; at window 5 it folds six times.

The summary goes in the **system prompt**, not the messages array. Injected as
an assistant message, a third-person digest ("the user's name is Priya") would
read to the model as something it had said out loud, and it would answer in that
register. In the system prompt it reads as briefing material, which is what it
is. With no summary the block is omitted entirely — never an empty header, which
only invites the model to invent what belongs under it.

The output is **structured, not prose**: five fixed sections, and an instruction
to keep names, numbers, paths, versions and port numbers exactly as stated,
dropping narrative before dropping a specific value. A free-form paragraph is
precisely the shape that keeps "we discussed configuration" and loses "port
8477", and the port number is the only part a recall test ever asks about.

### `facts` — a key-value block, patched every turn

The last N exchanges plus everything that has been established, as a block in
the same place the summary goes:

```
<known_facts>
Established facts about this conversation. Treat as true unless the user corrects them.
constraint.database: Postgres 14, compliance-tied
constraint.port: 8477, fixed by a firewall rule
decision.rejected: Kubernetes, ruled out last year
goal.deadline: March 14
</known_facts>
```

The decision that matters here is not the prompt. It is that extraction is
**patch-based and never regenerative**. Asking the model for the whole fact set
each turn reads as the cheaper option — one call, one source of truth — and it
silently drops every fact it did not happen to restate. That is not a degraded
summary; it is a fact that was true last turn and is simply *gone* this turn,
with nothing in the output to say so. So the model may only propose
`[{op:"set"|"delete", key, value}]`, and `applyOps` changes the store
deterministically in code: keys must match a namespaced dotted pattern
(`goal.* / constraint.* / preference.* / decision.* / agreement.*`), a `set` on
an existing key keeps the last three values it replaced, a malformed op is
discarded on its own without taking the rest of the patch with it, a `set` that
changes nothing is not a change, and the store is capped at `maxFacts` (40) by
evicting the least recently updated.

Existing keys are passed in the prompt so the model reuses them rather than
inventing a parallel one. Extraction runs **before** the main call, on the newest
user message with the previous reply for context, so the turn that establishes a
fact is already answered with it in view — waiting for the reply would mean every
fact arrived a turn late.

Facts are stamped with the turn they were established on, and a fact stamped
later than the branch it is being read on is dropped. That is what stops a fork
taken at message 4 from quietly knowing something the parent branch only decided
at message 12 — which would not read as a storage bug, it would read as the
model hallucinating.

### `full` — the recall ceiling

Everything, every turn. Nothing can remember more, and nothing that re-sends the
whole conversation on every turn is cheap: its input grows linearly and its
cumulative cost therefore grows quadratically. It is a real option, not a straw
man, and the numbers below are mostly a story about where it stops being the
right answer.

## The numbers

`claude-haiku-4-5-20251001`, $1.00 / $5.00 per million in/out.
`scenarios/requirements-gathering.json`: 15 turns. Five checkable facts planted
in the first five (name, port 8477, "must stay on Postgres 14", "we ruled out
Kubernetes", deadline March 14), nine turns of unrelated tangents on top, and a
final message asking for all five back. Recall is substring matching on that
last reply, out of 5.

```bash
npm run scenario -- --all --window=10
```

**Window 10:**

| | recall | conversation | overhead | **all-in** | overhead calls |
| --- | :---: | ---: | ---: | ---: | ---: |
| sliding window | 0/5 | $0.02598 | — | **$0.02598** | 0 |
| rolling summary | 5/5 | $0.02541 | $0.00521 | **$0.03061** | 2 |
| extracted facts | 5/5 | $0.02885 | $0.00929 | **$0.03814** | 15 |
| full history | 5/5 | $0.02828 | — | **$0.02828** | 0 |

**Window 5** — the same fifteen turns, a tighter crop:

| | recall | conversation | overhead | **all-in** | overhead calls |
| --- | :---: | ---: | ---: | ---: | ---: |
| sliding window | 0/5 | $0.02094 | — | **$0.02094** | 0 |
| rolling summary | 5/5 | $0.02099 | $0.01299 | **$0.03399** | 6 |
| extracted facts | 5/5 | $0.02028 | $0.00906 | **$0.02934** | 15 |
| full history | 5/5 | $0.02828 | — | **$0.02828** | 0 |

### The verdict

**At fifteen turns, sending everything is the cheapest thing that works.** Full
history scores 5/5 for $0.02828, and at window 10 both of the clever strategies
cost more than that to reach the same score. This is the result the exercise is
for: a fifteen-turn conversation on a 200K-context model is nowhere near needing
context management, and the machinery you would build for one is pure overhead
until it does.

**Sliding window is the floor and it is not close to sufficient.** 0/5 at
$0.02598 — and worth watching what 0/5 actually looked like. It did not say "I
don't know". It said *"I appreciate the test, but I'm not going to do this… let's
start fresh"*, and then asked to be told the requirements again. A model that
cannot see a fact does not report a gap; it reasons confidently from the hole.

**Facts does not automatically win, and at window 10 it loses outright.** It is
the most expensive of the four — $0.03814, 47% above the floor. The reason is
structural rather than incidental: **facts extracts on every user message, where
summarization folds once every `window / 2` turns.** Fifteen calls against two.
The per-call bill is much smaller (~550 tokens against ~1,600) but fifteen small
calls beat two large ones, and a wide window is precisely the case where the
verbatim messages already remember most of what you would extract.

**Its case is the narrow window, and there it is the best strategy that works.**
At window 5, facts is $0.02934 against summarization's $0.03399 — and
summarization at that window costs **more than sending the entire conversation
every turn**, which is the same trap Day 9 found at window 5 and the reason the
default window is 10. The mechanism is visible in the block sizes: the facts
block plateaus at 119 tokens while the summary block grows monotonically to 324
and keeps going. A summary accretes; a capped fact store does not.

**And the ordering is a function of length, not a property of the strategies.**
Full history's input climbs every turn (83, 200, … 2,597) while the others
plateau. At window 5, by turn 13 facts' marginal cost per turn ($0.00215–0.00274,
overhead included) is already *below* full history's ($0.00295–0.00338), and the
$0.001 cumulative gap is closing at roughly $0.0007 a turn — so the curves cross
at around **turn 17**, two turns past where this scenario stops. Run a
fifty-turn conversation and the table inverts completely.

The honest summary: pick `full` until it hurts, pick `facts` with a narrow
window when it starts to, and pick `summary` when what matters is narrative
rather than values. `sliding` is for when you have measured that nothing said
more than N turns ago will ever be asked about again.

## Branching

Branching is a **storage** change, not a fifth strategy. It changes what "the
history" means, not how a history becomes a payload, so it composes with all
four and no strategy needs to know it exists.

Messages gain `id` and `parentId`; the record gains
`branches: { id, name, headId, forkedFromMessageId, parentBranchId, strategy, strategyState }`
and an `activeBranchId`. A branch's history is the path from its head back to
the root, reversed. The flat array every earlier version wrote is the degenerate
case — one chain, one branch — which is why those files still load, migrated in
memory with the old `summary`/`summarizedThrough` moved into
`main.strategyState.summary` and nothing rewritten on disk until the next save.

**Each branch owns its own `strategyState`**, deep-copied from its parent at fork
time and keyed by strategy id. Two consequences, both deliberate:

- Sharing one map would let a fact established down one branch appear on the
  other. That does not present as a storage bug — it presents as the model
  stating something nobody on that branch ever said.
- Keying by strategy id means switching strategy mid-conversation **parks** the
  old state rather than discarding it. Switch back and the summary is exactly
  where you left it. The transcript marks the switch, because the turns before
  and after it were answered from different context and otherwise look like one
  conversation behaving inconsistently.

`main` and the active branch cannot be deleted — deleting the one every other
branch forked from would orphan them, and deleting the one you are talking to
would leave the next turn nowhere to go. Deleting any other prunes the messages
only it could reach.

## The UI

The right-hand column is strategy-aware and asks the strategy what to draw:
`summary` keeps the panel that renders the digest's five sections; `facts` shows
a live key-value table grouped by namespace, flashing the rows that moved this
turn with an inline *"was: …"* underneath; `sliding` and `full` show a short
placeholder naming what is *not* riding along and what that costs. The sentence
above it names the zones of the actual payload, and the dashed boundary in the
transcript holds whatever the strategy put in the system prompt — which turns
"the old turns are gone" into "the old turns are *this*".

Per-turn counters attribute the block inside the input figure rather than adding
to it (`512 in (98 facts)`) — it is not extra tokens on top of the request, it
*is* part of the request. The strategy's own calls get their own stat, outside
the conversation's totals.

**Compare** runs all four against the stored branch and tables reply, input,
overhead, cost and recall; give it a comma-separated list of facts to check for
and it scores them. It is strictly read-only: four payloads are built and thrown
away, nothing is appended, no state is written back.

## Routes

| Route | What it does |
| --- | --- |
| `GET /strategies` | The registry: id, label and description for each |
| `POST /chat` | `{ message, sessionId, strategy?, branchId?, contextMessages?, maxTokens? }` → `{ reply, meta }` |
| `POST /reset` | Clears one conversation |
| `GET /conversations` | Sidebar summaries, newest first |
| `GET /conversations/:id` | `?branchId=` → `{ messages, branches, activeBranchId, strategy, panel }` |
| `GET /conversations/:id/usage` | Per-turn counts and running totals for one branch |
| `GET /conversations/:id/branches` | Every branch and which one is active |
| `POST /conversations/:id/branches` | `{ fromMessageId, name }` → a new branch |
| `POST /conversations/:id/branches/:branchId/activate` | Switch branches |
| `DELETE /conversations/:id/branches/:branchId` | Refuses `main` and the active one |
| `POST /conversations/:id/replay` | `{ question, strategies?, expect?, branchId?, contextMessages? }` → one answer per strategy |
| `DELETE /conversations/:id` | Deletes it and evicts the cached agent |
| `GET /pricing.js` | The server's pricing module, served to the browser |

`strategy` is validated against the registry and persisted per branch; omitted,
it means "whatever this branch was last spoken to with", so switching branches
does not silently switch how the conversation is managed. `contextMessages`
(2–100, default 10) counts **exchanges**; what it means is the strategy's
business. The JSON body limit is 5 MB, not Express's 100 KB.

`summarizeEvery` is gone: the fold size is now half the window, full stop. It
was a knob on the `Agent` for something that was never the `Agent`'s business,
and the strategy that owns folding derives it.

`/replay` is strictly read-only. Each arm reports its own failure rather than
throwing, since an over-long full history is an interesting outcome and
shouldn't take the other three answers down with it.

## The scenario harness

```
npm run scenario -- --strategy=facts --window=10
npm run scenario -- --all
npm run scenario -- --all --fake      # offline, no key needed
```

Per-turn input, output, overhead (tokens and calls), cumulative cost and a
one-line note on what the strategy did; `--all` adds the comparison table.
`--json` dumps the raw numbers, `--verbose` shows per-turn tables for every arm.

Offline it runs against `FakeProvider`, which now recognises all three system
prompts this app sends — the persona's, the summarizer's and the extractor's —
and answers each in the right shape. Asked a question, it reads its own context
back rather than reasoning about it. That still measures the thing the four
strategies actually differ on (did the fact reach the payload at all?) but it is
an **upper bound** on recall, never a prediction of it. Every number in this
README comes from a keyed run.
