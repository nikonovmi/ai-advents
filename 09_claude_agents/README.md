# first-agent

A minimal chat app: an Express server, a plain-HTML chat UI, and a reusable
`Agent` class behind a provider-neutral LLM abstraction. It reports real tokens
and cost per turn, and it compresses old messages into a running summary instead
of dropping them — then measures whether that was worth paying for.


https://github.com/user-attachments/assets/592fd24b-cec4-4d2e-92a4-5dbc664f42d7


## Run

Node 20.11+.

```bash
npm install
npm test                      # stub providers, no key, no network
echo 'ANTHROPIC_API_KEY=sk-ant-…' > .env
npm start                     # http://localhost:3000
```

Without a key the server falls back to `FakeProvider` — canned replies, no
network. If a request says the key *"is not scoped to a workspace"*, also set
`ANTHROPIC_WORKSPACE_ID`.

Three controls sit by the composer: **Window (exchanges)** (2–100, default 10),
**Compress**, and **Max tokens** (the reply cap — set it to 30 to see a
truncated reply saved to history mid-sentence).

## Layout

```
src/
  llm/
    provider.js    the abstraction (LlmProvider + LlmError)
    anthropic.js   AnthropicProvider + FakeProvider
    pricing.js     the price table, estimateCost, formatCost, formatTokens
  store/
    conversationStore.js  the abstraction (ConversationStore + isValidSessionId)
    jsonFileStore.js      one JSON file per conversation
    memoryStore.js        the same contract, backed by a Map
  agent.js         the Agent, the personas, the boundary rules
  agent.test.js    boundary rules and compression flow, under `node --test`
  summarizer.js    the Summarizer — folds old exchanges into a running summary
  server.js        Express routes and session bookkeeping
public/index.html  the chat UI
data/conversations/  saved conversations, one file each
```

Two abstractions, both injected into `Agent`, so it contains no URL, no key, no
`fetch` and no vendor name:

```js
async complete({ system, messages, temperature, maxTokens, model })
// → { text, model, stopReason, usage: { inputTokens, outputTokens } }
async countTokens({ system, messages, model })  // → { inputTokens }

async load(sessionId) / save(sessionId, messages, usage, compression) / clear(sessionId)
```

Anthropic's `stop_reason` and `input_tokens` become `stopReason` and
`inputTokens` in `anthropic.js` and nowhere else. Failures normalise to
`LlmError` with a `status`, which is how the Agent knows to retry a 429 or 5xx
(three attempts, 500/1000/2000 ms).

Conversations are written atomically (`.tmp` then `rename()`) with the full
history, never the cropped view. Records written by earlier versions still load:
a missing `usage` key, missing summarizer fields and an absent `summary` all
read back as zeros and nulls rather than a parse failure. The browser imports
the server's own `pricing.js` from `GET /pricing.js`, so a number in the UI is
formatted by exactly the code that priced it.

## The three-zone payload

Every request is exactly three parts:

1. **System prompt** — the persona, with the running summary appended.
2. **Verbatim exchanges** — recent history, unmodified.
3. **The new user message.**

Everything older than zone 2 exists only as the summary in zone 1, and the two
meet exactly — there is no third state. Nothing is ever deleted from `#history`
or from disk; the crop applies only to what is sent.

Two boundary rules are enforced rather than assumed, because both fail silently:

1. **The payload must open on a user message.** The Messages API rejects a
   `messages` array whose first entry is an assistant turn. A crop that counts
   messages instead of exchanges lands on one about half the time — an
   intermittent 400 that depends on nothing but the parity of the conversation.
2. **A turn pair is never split.** A question whose answer is outside the
   payload, or an answer whose question is, is worse than neither: the model
   reads half an exchange as a whole one.

Both come out of the same move — snap the boundary back to the user message that
opens the turn it landed inside. `agent.test.js` checks every window size
against a history of 10 and of 11 for exactly that reason.

## Compressing what falls out

Compression is triggered by the **size of what is being sent**, not by the age
of what has been dropped — because nothing is ever dropped and left waiting.

`contextMessages` is a **high-water mark**. Verbatim exchanges accumulate until
there are that many, and then the oldest **half** of them is folded into the
summary in one go:

```
[u1 a1 u2 a2 u3 a3 u4 a4 u5 a5 u6]     6 exchanges — at the mark
 └──────── fold these 3 ────────┘
[summary][u4 a4 u5 a5 u6 a6]           and the reply lands here

…grows to u9…
[summary][u4 a4 u5 a5 u6 a6 u7 a7 u8 a8 u9]    at the mark again
          └──────── fold these 3 ────────┘
[summary'][u7 a7 u8 a8 u9 a9]
```

**The two edges touch, and that is the whole point.** `#summarizedThrough` is
both where the summary ends and where the verbatim messages begin, so every
stored message is either folded in or on the wire. There is never a turn where a
message is in neither.

That failure mode is easy to build by accident. Crop to a sliding window and
summarise the overflow "every N messages", and between compressions the messages
that have left the window but not yet reached the summary are invisible — and
they are the *most recent* of the dropped ones, the ones most likely to still
matter. Measured on an earlier build of this app, with a window of 5 and a batch
of 10, it sawtoothed up to **8 invisible messages** before every compression.

The fold size is half the window unless `summarizeEvery` overrides it. Half is
what makes the scheme self-pacing: fold less and the summarizer runs almost
every turn, fold more and the verbatim region collapses to nothing right after
each one. Halving means the region oscillates between half the window and all of
it, and the summarizer runs once per half-window of conversation.

**That coupling has a price, and it is the main thing to understand about tuning
this.** The summarizer runs every `contextMessages / 2` turns, so halving the
window doubles how often you pay for compression. At a window of 5 it runs every
other turn and costs more than sending the entire history would — see [the
numbers](#the-numbers). The default is **10**.

`#summarizedThrough` is also what makes compression **incremental** (the
summarizer only ever sees the previous summary plus the exchanges being folded
now, never the whole conversation) and **idempotent** (a turn that does not move
the edge changes nothing). It is snapped to a user message both when it moves
and when it is loaded from disk, which keeps the two boundary rules true for
free.

With `compressionEnabled` off none of this applies: the agent falls back to a
plain sliding window, so the comparison is between two designs rather than two
settings of one design.

The summary goes in the **system prompt**, not the messages array:

```
<conversation_summary>
Summary of earlier parts of this conversation, which are no longer shown in full:
## Facts about the user
- Name: Priya Raghunathan
…
</conversation_summary>
```

Injected as an assistant message, a third-person digest ("the user's name is
Priya") would read to the model as something it had said out loud, and it would
answer in that register. In the system prompt it reads as briefing material,
which is what it is. With no summary the block is omitted entirely — never an
empty header, which only invites the model to invent what belongs under it.

The output is **structured, not prose**. `Summarizer` asks for five fixed
sections — facts about the user, decisions made, preferences and constraints,
open questions, discarded/superseded — and instructs the model to keep names,
numbers, paths, versions and port numbers exactly as stated, dropping narrative
before dropping a specific value. A free-form paragraph is precisely the shape
that keeps "we discussed configuration" and loses "port 8477", and the port
number is the only part a recall test ever asks about.

Two rules keep it from doing damage:

- **Failure is non-fatal.** If the summarizer throws, the previous summary is
  kept and `#summarizedThrough` does *not* advance — which under this scheme
  means the exchanges that failed to fold simply stay verbatim and the model can
  still see them, with the fold retried next turn. The turn is answered either
  way. A failed compression must never cost a user their message.
- **It runs before the main call**, so the turn is answered with a summary that
  already includes everything folded this turn. The latency is real and is
  reported separately as `summarizerMs`.

The UI puts all of this in the right-hand column: the three zones named in a
sentence, the exact injected summary (with live stats, flashing on the turn it
changes), and **Compare**. Per-turn counters name the summary's share of the
input (`480 in (145 summary)`), and the summarizer keeps its own totals stat,
outside the conversation's — folding compression's cost into the thing it is
being compared against would be marking your own homework.

## The numbers

`claude-haiku-4-5-20251001`, $1.00 / $5.00 per million in/out. 17 turns: three
specific facts planted in turns 1–3 (a name, port 8477, "never suggest
Kubernetes"), 13 turns of unrelated trivia, then turn 17 asks for all three
back. Window 10.

**Recall.** Compression on: **3/3**. Off: **0/3** — *"You never told me your
name."* Full history: 3/3. On every one of the 17 turns `droppedCount` equalled
`summarizedThrough`, so no message was ever invisible.

**`POST /replay`** — the same question, three ways, against the same stored
conversation:

| | messages | input | output | cost | answer |
| --- | ---: | ---: | ---: | ---: | :---: |
| full | 35 | 1,407 | 39 | $0.00160 | ✅ |
| cropped | 19 | 713 | 65 | $0.00104 | ❌ |
| compressed | 19 | 858 | 39 | $0.00105 | ✅ |

145 tokens above the floor, 549 below the ceiling. (The bottom two costs match
because not knowing took 65 output tokens and knowing took 39.)

**Whole run, with the summarizer's bill kept separate:**

| | window | conversation | summarizer | **all-in** | recall |
| --- | ---: | ---: | ---: | ---: | :---: |
| full history | — | $0.01716 | — | **$0.01716** | 3/3 |
| cropped | 10 | $0.01494 | — | **$0.01494** | 0/3 |
| **compressed** | **10** | $0.01359 | $0.00295 | **$0.01654** | **3/3** |
| compressed | 5 | $0.01127 | $0.00937 | **$0.02064** | 3/3 |
| cropped | 5 | $0.01043 | — | **$0.01043** | 0/3 |

- **vs. cropping: compression costs 11% more, not less.** Cropping's floor is
  the cheapest thing you can send and still be having a conversation; nothing
  that adds a summary goes below it. What the 11% buys is 3/3 instead of 0/3.
- **vs. full history:** 4% cheaper at 17 turns, and the margin grows without
  limit — full history's input climbs every turn (81, 156, … 1,240) while the
  compressed payload oscillates forever.
- **The window is the cost dial.** At 5 the summarizer runs every other turn:
  5,669 tokens instead of 2,007 and **$0.02064 — dearer than sending the whole
  history every turn**, for no better recall. Below ~8 exchanges, compressing
  costs more than not compressing. At 20 this conversation never reaches the
  mark, so compression never runs at all.

## Routes

| Route | What it does |
| --- | --- |
| `POST /chat` | `{ message, sessionId, contextMessages?, maxTokens?, compressionEnabled?, summarizeEvery? }` → `{ reply, meta }` |
| `POST /reset` | Clears one conversation |
| `GET /conversations` | Sidebar summaries, newest first |
| `GET /conversations/:id` | `{ messages, summary, summarizedThrough, summaryUpdatedAt }` |
| `GET /conversations/:id/usage` | Per-turn counts and running totals |
| `POST /conversations/:id/replay` | `{ question, contextMessages? }` → the same answer three ways |
| `DELETE /conversations/:id` | Deletes it and evicts the cached agent |
| `GET /pricing.js` | The server's pricing module, served to the browser |

`contextMessages` (2–100, default 10) counts **exchanges** and is a high-water
mark. `summarizeEvery` (1–100) optionally overrides the fold size; omitted, it
is half the window, which is what the browser sends. The JSON body limit is
5 MB, not Express's 100 KB.

`/replay` is strictly read-only: it loads the record, builds three payloads and
throws them away. Nothing is appended, no summary is written, usage totals are
untouched — the three completions belong to the experiment, not the
conversation. Each arm reports its own failure rather than throwing, since an
over-long full history is an interesting outcome and shouldn't take the other
two answers down with it.
