# first-agent

A minimal chat app: an Express server, a plain-HTML chat UI, and a reusable
`Agent` class sitting behind a provider-neutral LLM abstraction.

It reports real token usage and cost for every turn and for the conversation as
a whole, it shows what breaks when history is cropped to a small window, and it
compresses everything that falls outside that window into a running summary
rather than dropping it — then measures whether that was worth paying for.


https://github.com/user-attachments/assets/c9091763-f0a8-4818-ac17-c34e262338a1


## Install

Requires Node 20.11+ (native `fetch`, and `node --test` for the test suite).

```bash
npm install
npm test
```

The tests cover the two window-boundary rules and the compression flow. They
use stub providers, so they need no API key and make no network calls.

## API key

```bash
cp .env.example .env
```

Then put your key in `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Get one at https://console.anthropic.com/settings/keys. The key is read only on
the server, only in `src/llm/anthropic.js`, and is never sent to the browser.

If a request comes back saying the key *"is not scoped to a workspace"*, the key
is identity-linked and also needs a workspace id:

```
ANTHROPIC_WORKSPACE_ID=wrkspc_...
```

Workspace-scoped keys can leave that blank.

Without a key the server starts anyway and falls back to `FakeProvider`, which
returns canned replies with no network calls — handy for poking at the UI.

## Run

```bash
npm start
```

Then open **http://localhost:3000**.

Enter sends a message, Shift+Enter adds a newline, and **New conversation**
starts a fresh thread — the old one stays in the sidebar, where you can switch
back to it or delete it with the ×.

Three controls sit next to the composer. **Window (exchanges)** (2–100,
default 10) is the high-water mark: verbatim exchanges accumulate until there
are that many, then the oldest half is folded into the summary. It is one dial,
not two — the fold size is always half of it. **Compress** turns compression off
entirely, which reverts the app to plain cropping, and **Max tokens** caps the
reply, where setting it to 30 is the quickest way to see a truncated one.

Note that the window also sets how often you pay for compression: the summarizer
runs once every `window / 2` turns, so a small window is an expensive one.

Above the transcript, a strip of totals and a cumulative-cost chart update after
every turn. The right-hand column is everything about *what is being sent*: the
sentence naming the three zones, the **Summary** panel with the exact text
currently being injected into the system prompt, and **Compare**, which asks one
question three ways at once — see [Compression experiments](#compression-experiments).

## Layout

```
src/
  llm/
    provider.js    the abstraction (LlmProvider + LlmError)
    anthropic.js   AnthropicProvider + FakeProvider
    pricing.js     the price table, estimateCost, formatCost, formatTokens
  store/
    conversationStore.js  the abstraction (ConversationStore + isValidSessionId)
    jsonFileStore.js      JsonFileStore — one JSON file per conversation
    memoryStore.js        MemoryStore — the same contract, backed by a Map
  agent.js         the Agent class, the personas, and the window boundary rules
  agent.test.js    the boundary rules and the compression flow, under `node --test`
  summarizer.js    the Summarizer — folds dropped messages into a running summary
  server.js        Express routes and session bookkeeping
public/
  index.html       the chat UI
data/
  conversations/   saved conversations (created at runtime, gitignored)
```

## The provider abstraction

`Agent` and `Summarizer` depend on exactly two methods:

```js
async complete({ system, messages, temperature, maxTokens, model })
// → { text, model, stopReason, usage: { inputTokens, outputTokens } }

async countTokens({ system, messages, model })  // → { inputTokens }
```

`model` is optional and overrides the provider's default for that one call. A
model id is a neutral string — it already comes back in every result and it is
the key into the price table — so naming one here crosses no boundary. It is
what lets `Summarizer` send compression to a cheaper model than the
conversation itself.

`messages` is a plain `{ role, content }[]`, deliberately not any vendor's wire
format, and the result is plain text plus a model name, a stop reason and a
token count. Raw HTTP responses, content blocks, headers and credentials all
stop at that boundary — so `agent.js` contains no URL, no key, no `fetch`, and
no vendor name at all.

The neutral spellings matter: Anthropic returns `stop_reason` and
`usage.input_tokens`, and `anthropic.js` is the only file that has ever heard
of them. Above that line they are `stopReason` and `usage.inputTokens`, which
is what makes them a *contract* rather than a leak of one vendor's JSON.

The provider is **injected** through the constructor; the Agent never builds one:

```js
const agent = new Agent({ provider, systemPrompt: personas.pirate });
```

That means swapping vendors is a one-line change at the composition root
(`src/server.js`) and *zero* changes to `agent.js`:

```js
const provider = new FakeProvider();               // offline, no key
// const provider = new OpenAiProvider({ apiKey }); // a different vendor
// const provider = new AnthropicProvider({ apiKey });
```

Any new provider only has to extend `LlmProvider`, translate the neutral input
into its own request format, and translate the response back to `{ text, model }`.
Failures are normalised to `LlmError` with a `status`, which is how the Agent
knows to retry a 429 or a 5xx (three attempts, 500/1000/2000 ms backoff) without
knowing who produced the error.

Session state lives in `server.js` in a `Map<sessionId, Agent>` — the Agent
itself has no idea that sessions or HTTP requests exist.

## Persistence

Conversations survive a restart. They live in `data/conversations/`, one file
per conversation, named after its session id:

```
data/conversations/9f2c1b04-….json
```

```json
{
  "id": "9f2c1b04-…",
  "title": "Debugging the retry logic",
  "createdAt": "2026-09-12T10:04:11.902Z",
  "updatedAt": "2026-09-12T10:19:44.310Z",
  "usage": {
    "totalInputTokens": 1941,
    "totalOutputTokens": 437,
    "totalCostUsd": 0.004126,
    "turnCount": 15,
    "summarizerInputTokens": 1738,
    "summarizerOutputTokens": 212,
    "summarizerCostUsd": 0.002798
  },
  "summary": "## Facts about the user\n- Name: Priya Raghunathan\n…",
  "summarizedThrough": 20,
  "summaryUpdatedAt": "2026-09-12T10:17:02.118Z",
  "messages": [
    { "role": "user", "content": "…", "tokens": { "request": 40 } },
    {
      "role": "assistant",
      "content": "…",
      "tokens": { "request": 40, "sent": 122, "input": 122, "output": 64, "total": 186 },
      "cost": { "input": 0.000122, "output": 0.00032, "total": 0.000442 },
      "model": "claude-haiku-4-5-20251001",
      "ms": 1612,
      "stopReason": "end_turn",
      "compression": {
        "enabled": true, "summaryTokens": 133, "summarizedMessages": 20,
        "compressedThisTurn": false, "foldedMessages": 0,
        "summarizerTokens": 0, "summarizerCost": null, "summarizerMs": null
      }
    }
  ]
}
```

The whole conversation is written, never the cropped view — cropping is what
the model sees, the file is what the agent knows. Cumulative totals live on the
record, so they survive a restart: reload the page after `npm start` and the
turn count and running cost carry on from where they were.

So does the summary. `summary` and `summarizedThrough` are on the record for the
same reason the messages are: a summary that had to be recomputed after every
restart would be a summary you paid for twice. The summarizer's tokens are
tracked in their own three `usage` fields rather than added to the conversation
totals — a saving whose cost has been quietly folded into the thing it is being
compared against is not a measurement.

Conversations written before any of this existed still load. A missing `usage`
key reads back as zeros, missing summarizer fields read back as zeros, an absent
`summary` reads back as a conversation that has never been compressed, and
messages with no `tokens` field simply show no counter — rather than failing the
file.

The directory is resolved relative to the module, not the working directory, so
`npm start` behaves the same from anywhere. Writes go to a `.tmp` file and are
then `rename()`d into place, so a crash mid-write leaves the previous file
intact rather than a truncated one. The title is derived from the first user
message and never recomputed afterwards.

The browser keeps its session id in `localStorage`, so reloading the page picks
up where you left off instead of looking like amnesia.

### Why the store is an abstraction

`ConversationStore` is the same idea as `LlmProvider`, one layer over: an
abstract class defining the contract, concrete implementations behind it,
injected into the Agent. The two even share the `{ role, content }[]` shape.

```js
async load(sessionId)          // → { id, title, createdAt, updatedAt, usage, messages } | null
async save(sessionId, messages, usage)
async clear(sessionId)
async listSessions()           // → summaries, newest first, each with totalCostUsd
```

`agent.js` therefore contains no filename, no directory, and no `fs` import —
it asks a store to remember things and does not care how. Swapping storage is a
one-line change at the composition root:

```js
const store = new JsonFileStore();  // on disk
// const store = new MemoryStore(); // in memory — tests, no disk access
```

`MemoryStore` is what tests use, and what the server falls back to if the data
directory turns out to be unwritable.

Because hydration is async and a constructor cannot be, resuming goes through a
static factory:

```js
const agent = await Agent.load({ provider, store, sessionId });
```

The `Map<sessionId, Agent>` in `server.js` is now a **cache in front of the
store**, not the source of truth — a cache miss loads from disk instead of
handing back a blank agent. That single change is what makes restart-and-continue
work.

### Path safety

Session ids come from the client, so an unvalidated one is an arbitrary file
read or write. Every route and every store method runs the id through
`isValidSessionId()` — canonical UUID v4 only — and refuses before touching the
filesystem. A raw id is never concatenated into a path.

## Tokens and cost

Every number in this app is a **real count from the API**, never an estimate
from character counts. There are two sources, and the app uses both:

- The Messages response carries a `usage` object with `input_tokens` and
  `output_tokens`. That is what you were actually billed for, and it is what
  the per-message counters and the running totals are built from.
- `POST /v1/messages/count_tokens` takes the same body shape and returns
  `{ input_tokens }` without running the model. It is free and unbilled, so
  the agent calls it twice before every turn: once for the new user message on
  its own, and once for the whole cropped payload including the system prompt.
  That is the difference between *"what did I just type"* and *"what is about
  to go on the wire"*.

Measuring is never allowed to cost you a reply. If `countTokens()` fails, the
agent logs it, sets those two fields to `null`, and carries on with the turn.

`src/llm/pricing.js` holds the price table and the formatters:

```js
PRICING["claude-haiku-4-5-20251001"]
// { inputPerMillion: 1.00, outputPerMillion: 5.00, contextWindow: 200000, maxOutput: 64000 }

estimateCost({ model, inputTokens, outputTokens }) // → { inputCost, outputCost, totalCost }
formatCost(0.0023)   // "$0.0023"   — four decimals under a cent, two above
formatTokens(8432)   // "8,432"     — separators under 10K, "12.4K" / "1.2M" above
```

`formatCost` refuses to round a per-turn cost to `$0.00`, which is what two
decimal places would print for every single turn of this app — precisely the
number the whole exercise is about. An unknown model id is not an error: the
costs come back `null` and the UI shows token counts with no price rather than
crashing or inventing one. That path is live, not theoretical — the offline
`FakeProvider` reports `fake-provider`, which has no published price.

The browser imports that same module from `GET /pricing.js`, so a number in the
UI is formatted by exactly the code that priced it on the server.

## The three-zone payload

Every request is assembled from exactly three parts:

1. **The system prompt** — the persona, with the running summary appended under
   its own header.
2. **The window** — the last `contextMessages` exchanges, verbatim.
3. **The new user message.**

Everything older than zone 2 exists only as the summary in zone 1, and the two
meet exactly — there is no third state. Nothing is ever deleted from `#history`
or from disk; the crop applies only to what is sent.

### The window

`contextMessages` (default **10**) is the high-water mark for zone 2, counted in
**exchanges** — a user message and every reply that came after it. Verbatim
exchanges pile up until there are that many, and then the oldest half is folded
into the summary, so in practice the payload oscillates between five and ten
exchanges.

With compression switched off it degrades to the previous version's plain
sliding window: the last `contextMessages` exchanges, and everything older
simply gone.

Counting exchanges rather than messages outright is what keeps the window
stable. If it counted messages, a model that answered in several parts could
push the user's own question out of the very request meant to answer it; a
window of 10 would sometimes mean ten exchanges and sometimes four.

Two boundary rules are then enforced rather than assumed, because both failures
are silent until they aren't:

```js
export function windowStart(history, contextMessages) {
  const turns = Math.max(1, Math.floor(contextMessages));
  let start = 0;
  let seen = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "user") continue;
    if (++seen === turns) { start = i; break; }
  }

  while (start > 0 && history[start].role !== "user") start--;
  // …plus a forward skip for a history that opens on an assistant turn.
  return start;
}
```

1. **The window must open on a user message.** The Messages API rejects a
   `messages` array whose first entry has `role: "assistant"`. Any crop that
   counts messages instead of turns lands on one about half the time, so this
   is an intermittent 400 that depends on nothing but the parity of the
   conversation. `agent.test.js` checks every window size against a history of
   10 and a history of 11 for exactly that reason, and checks that `foldTo`
   only ever lands the summary's edge on a user message.
2. **A turn pair is never split.** A question whose answer is outside the
   window, or an answer whose question is, is worse context than neither: the
   model reads half an exchange as a whole one. Both rules come out of the same
   move — walk the boundary back to the user message that opens the turn it
   landed inside.

`droppedCount` is that index — everything before it is stored and unsent, and it
is reported in messages, not exchanges, because messages are what the transcript
shows. With compression on it is exactly `summarizedThrough`, which is the
property worth asserting: `agent.test.js` checks the two are equal on every turn
of a run.

### Compressing what falls out

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
stored message is either folded in or on the wire. There is never a turn where
a message is in neither.

That failure mode is easy to build by accident. Crop to a sliding window and
summarise the overflow "every N messages", and between compressions the
messages that have left the window but not yet reached the summary are invisible
— and they are the *most recent* of the dropped ones, the ones most likely to
still matter. Measured on an earlier build of this exact app, with a window of 5
and a batch of 10, it sawtoothed up to **8 invisible messages** before every
compression.

The fold size is half the window unless `summarizeEvery` overrides it. Half is
what makes the scheme self-pacing: fold less and the summarizer runs almost
every turn, fold more and the verbatim region collapses to nothing right after
each one. Halving means the region oscillates between half the window and all of
it, and the summarizer runs once per half-window of conversation.

**That coupling has a price, and it is the main thing to understand about
tuning this.** The summarizer runs every `contextMessages / 2` turns, so halving
the window doubles how often you pay for compression. At a window of 5 it runs
every other turn and costs more than sending the entire history would — see
[Honest net cost](#3-honest-net-cost). The default is **10**.

`#summarizedThrough` is also what makes compression **incremental** (the
summarizer only ever sees the previous summary plus the exchanges being folded
now, never the whole conversation) and **idempotent** (a turn that does not move
the edge changes nothing). It is snapped to a user message both when it moves
and when it is loaded from disk, which is what keeps the two boundary rules true
for free: the payload always opens on a user turn, and no exchange is ever cut
in half.

With `compressionEnabled` off, none of this applies: the agent falls back to the
previous version's sliding window, so the comparison between the two is a
comparison of designs rather than of two settings of one design.

The summary goes in the **system prompt**, not in the messages array:

```
<conversation_summary>
Summary of earlier parts of this conversation, which are no longer shown in full:
## Facts about the user
- Name: Priya Raghunathan
- Runs deploy pipeline for kestrel-api service
...
</conversation_summary>
```

Injected as an assistant message, a third-person digest ("the user's name is
Priya") would read to the model as something it had said out loud, and it would
answer in that register. As part of the system prompt it reads as briefing
material, which is what it is. When there is no summary the block is omitted
entirely — never an empty header, which only invites the model to invent what
belongs under it.

The output is **structured, not prose**. `Summarizer` asks for five fixed
sections — facts about the user, decisions made, preferences and constraints,
open questions, discarded/superseded — and instructs the model to keep names,
numbers, paths, versions and port numbers exactly as stated, dropping narrative
before dropping a specific value. A free-form paragraph is precisely the shape
that keeps "we discussed configuration" and loses "port 8477", and the port
number is the only part a recall test ever asks about.

Two rules keep it from doing damage:

- **Summarization failure is non-fatal.** If the summarizer throws, the previous
  summary is kept and `#summarizedThrough` does *not* advance — which under this
  scheme means the exchanges that failed to fold simply stay verbatim and the
  model can still see them, with the fold retried next turn. The turn is
  answered either way. A failed compression must never cost a user their message.
- **Summarization runs before the main call**, so the turn is answered with a
  summary that already includes everything folded in this turn. The added
  latency is real and is reported separately as `summarizerMs`.

### What the UI shows

The chat column is left to be a chat; the column beside it holds the whole
answer to "what is actually being sent". It opens with the three zones named in
a sentence — *"Sending: a summary of 20 earlier messages + 7 exchanges verbatim.
Full history is stored but not sent. Once 10 exchanges have piled up the oldest
5 are folded in, so every stored message is either in the summary or on the wire
— never in neither."*

Under that, the persistent **Summary** panel shows the exact injected text
without scrolling, in small muted type with the section headers picked out as
labels — reference material, styled to read as secondary to the conversation.
Its header line carries the live stats (`Summary · 145 tokens · covers 20
messages · updated 2 turns ago`), it scrolls inside its own box so a long
summary can never push the chat off screen, it flashes on the turn compression
runs, and it remembers whether you collapsed it. **Compare** sits at the foot of
the same column. On a narrow screen the whole column moves below the chat rather
than squeezing the message column.

Back in the transcript, a collapsible block sits at the boundary and holds the
same summary text, so the point where the verbatim messages stop is also the
point where you can read what replaced them. The bubbles above it are dimmed.
Only the three live controls — the window, the compression toggle and the output
ceiling — stay next to the composer, since those are things you reach for
mid-conversation.

The turn where compression ran is flagged in the transcript with the
summarizer's own bill attached, and the per-turn counter names the summary's
share of the input (`480 in (133 summary)`). The totals strip keeps
**Summarizer** as its own stat, deliberately outside the conversation totals:
folding compression's cost into the thing it is being compared against would be
marking your own homework.

## Token experiments

All three runs are against `claude-haiku-4-5-20251001` at $1.00 / $5.00 per
million input / output tokens. Every figure below is measured, not estimated.

### 1. Short conversation — three turns, nothing forgotten

Window 5. A trip-planning conversation.

| Turn | request | sent | input | output | cost | dropped |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 26 | 65 | 65 | 116 | $0.0006 | 0 |
| 2 | 17 | 194 | 194 | 112 | $0.0008 | 0 |
| 3 | 14 | 316 | 316 | 129 | $0.0010 | 0 |

Three turns cost **$0.0024** in total, and nothing has been dropped — three
user messages fit inside a window of five with room to spare.

`sent` still climbs steeply, 65 → 194 → 316, because each turn re-sends
everything before it. That growth is the thing a window exists to stop, and
here the window has not started stopping it yet.

Note also how small `request` is next to `sent`. On turn 3 the user typed 14
tokens and the app sent 316. You are almost never paying for what you typed.

### 2. Long conversation — fifteen turns, and the forgetting

Window 5. Turn 1 plants a fact, turns 2–9 and 11–14 are unrelated trivia, and
turns 10 and 15 ask for the fact back.

> **Turn 1 —** *"my dog is called Barnaby, he is a whippet, and he is nine years old"*
> → **"Got it! Barnaby is your 9-year-old whippet. I've got that noted for our conversation."**

> **Turn 10 —** *"What is my dog called, and what breed is he?"*
> → **"I don't have any information about your dog. […] What's your dog's name and breed?"**

> **Turn 15 —** *"Remind me how old my dog is."*
> → **"I don't have any information about you or your dog."**

It is not being coy. Turn 1 fell out of the window the moment turn 6 arrived —
the sixth user message pushed the first one past the edge. By turn 10 the fact
is on disk, in the transcript, visible on screen, and simply not in the
request. "I've got that noted" was true when it was said and stopped being true
five turns later.

The token shape is the other half of the story:

| Turn | 1 | 3 | 5 | 6 | 8 | 10 | 12 | 15 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sent | 79 | 140 | 210 | 172 | 183 | 185 | 212 | 254 |
| stored | 2 | 6 | 10 | 12 | 16 | 20 | 24 | 30 |
| dropped | 0 | 0 | 0 | 2 | 6 | 10 | 14 | 20 |

`stored` and `dropped` climb without limit. `sent` does not. It rises freely
to 210 while the window is still filling, drops back to 172 the moment
cropping starts at turn 6, and after that just wobbles between about 170 and
265 depending on how long the last few messages happened to be. Fifteen turns
cost **$0.0049** — 2,800 input tokens and 424 output.

### 3. Window 5 vs window 50 — the actual trade-off

The same fifteen prompts, replayed with `contextMessages` at 50.

| | window 5 | window 50 |
| --- | ---: | ---: |
| `sent` on turn 1 | 79 | 79 |
| `sent` on turn 15 | 254 | 573 |
| input tokens, total | 2,800 | 4,717 |
| output tokens, total | 424 | 338 |
| **total cost** | **$0.0049** | **$0.0064** |
| cost per turn | $0.00033 | $0.00043 |
| messages dropped | 20 | 0 |
| *"What is my dog called?"* (turn 10) | **wrong** | **"Your dog is called Barnaby, and he's a whippet."** |
| *"How old is my dog?"* (turn 15) | **wrong** | **"Barnaby is 9 years old."** |

At window 50 nothing is ever dropped in a fifteen-turn conversation, so `sent`
climbs monotonically — 79, 122, 143, 179, 213, 241, 271, 310, 333, 370, 401,
447, 505, 530, 573 — and the model answers both recall questions correctly.

**That is the trade-off, priced.** 1.7× the input tokens for a memory that
works. The bill only rises 1.3×, because output tokens are unaffected by the
window and cost five times as much per token as input ones — so on a chatty
workload the window is a smaller lever on cost than the token counts alone
suggest.

The shapes matter more than the totals, and it is why the chart is in the UI.
With a fixed window, per-turn input tokens plateau, so cumulative cost is
roughly **linear** — turn 100 costs about what turn 10 did. Without one, each
turn re-sends every turn before it, so per-turn input grows linearly and
cumulative cost is **quadratic**. At fifteen turns that gap is a seventh of a
cent. It is not a seventh of a cent at turn 500.

### 4. Truncation

Set **Max tokens** to 30 and ask for something long:

```
turn 1 | req 19  sent 58  in 58  out 30 | stop max_tokens
"# Depth-First Search (DFS)  DFS explores a graph by going as deep as
 possible along each branch before backtracking."
```

`stopReason` comes back `max_tokens`, `meta.truncated` is true, and the UI puts
a warning on that message. The warning says the part that is easy to miss: the
cut-off reply is **saved to history exactly as it arrived**. Nothing repairs
it. On the next turn the model reads its own unfinished sentence as something
it meant to say — asking it to "carry on" produces a fresh start rather than a
continuation, because as far as it can tell that is where it chose to stop.

### Reproducing these

```bash
npm start
```

Open http://localhost:3000, untick **Compress**, set **Window** to 5, and paste
the turn-1 fact.
Ask for it back ten turns later. Then set it to 50 and do it again.

## Compression experiments

Same model, same prices: `claude-haiku-4-5-20251001` at $1.00 / $5.00 per
million input / output tokens. Every figure below is measured.

The script is one conversation, run several ways. Turns 1–3 plant three specific
things — a **name** (Priya Raghunathan), a **number** (kestrel-api listens on
port 8477) and a **preference** (never suggest Kubernetes, we are on bare EC2).
Turns 4–16 are unrelated computer-science trivia: mutexes, bloom filters, CAP,
TCP slow start. Turn 17 asks for all three facts back at once.

Window **10** (the default), `maxTokens` **300**. By turn 17 there are 34 stored
messages, 20 of them folded into the summary.

### 1. Recall — the quality comparison

> **Turn 17 —** *"what is my name, what port does kestrel-api listen on, and is
> there any technology I asked you never to suggest?"*

| | facts recalled | answer |
| --- | :---: | --- |
| **compression off** (crop only) | **0 / 3** | *"I don't have that information. You never told me your name. You never mentioned kestrel-api or any port. You never asked me to avoid suggesting any technology."* |
| **compression on** | **3 / 3** | *"Your name is Priya Raghunathan. kestrel-api listens on port 8477. Yes—you asked me not to suggest Kubernetes."* |
| **full history** | **3 / 3** | *"1. **Priya Raghunathan** 2. port **8477** 3. Yes—**Kubernetes**."* |

Three for three, from a summary standing in for twenty messages the model could
not see. Compression ran **twice** over the seventeen turns, folding five
exchanges each time, for 2,007 summarizer tokens and $0.00295 in total.

What it produced — 145 tokens on the wire:

```
## Facts about the user
- Name: Priya Raghunathan
- Runs deploy pipeline for kestrel-api service
- Team uses bare EC2 infrastructure

## Decisions made
- Bare EC2 deployment (not Kubernetes) — settled decision

## Preferences and constraints
- kestrel-api listens on port 8477
- Quarterly error budget: 43 minutes
- No Kubernetes suggestions

## Open questions
- none

## Discarded / superseded
- none
```

Every specific survived: the spelling of the name, the port, the number of
minutes. That is what the structured sections and the "keep values verbatim"
instruction are for. Note that the model filed the port under *preferences* and
the EC2 decision under *facts*, which is wrong-ish and does not matter at all —
recall does not care which bucket a fact sits in.

**No message was ever invisible.** On every one of the seventeen turns,
`droppedCount` equalled `summarizedThrough` exactly: each stored message was
either in the summary or on the wire. An earlier build of this app, which
cropped to a window and summarised the overflow in batches, had up to eight
messages in neither zone in the run-up to each compression.

### 2. Token comparison — `POST /conversations/:id/replay`

The same question, put to the same stored conversation three ways in parallel,
read-only:

| | messages sent | input | output | cost | answer |
| --- | ---: | ---: | ---: | ---: | :---: |
| **full** | 35 | 1,407 | 39 | $0.00160 | ✅ |
| **cropped** | 19 | 713 | 65 | $0.00104 | ❌ |
| **compressed** | 19 | 858 | 39 | $0.00105 | ✅ |

Full history is the baseline, cropped is the floor, and compressed sits between
them: **145 tokens above the floor, 549 below the ceiling.** The summary buys
back what 16 dropped messages knew for the price of about four lines of text.

The two costs at the bottom being a hair apart is a coincidence worth pointing
at: the cropped run spent 65 output tokens explaining that it did not know,
against 39 for actually answering, and output costs five times as much per token
as input. On this turn, not knowing cost as much as knowing.

### 3. Honest net cost

All seventeen turns, every way, with the summarizer's own bill kept separate:

| | window | conversation | summarizer | **all-in** | recall |
| --- | ---: | ---: | ---: | ---: | :---: |
| full history | — | $0.01716 | — | **$0.01716** | 3 / 3 |
| cropped | 10 | $0.01494 | — | **$0.01494** | 0 / 3 |
| **compressed** | **10** | $0.01359 | $0.00295 | **$0.01654** | **3 / 3** |
| compressed | 5 | $0.01127 | $0.00937 | **$0.02064** | 3 / 3 |
| cropped | 5 | $0.01043 | — | **$0.01043** | 0 / 3 |

**Say it plainly: compared with cropping alone, compression costs more, not
less.** $0.01654 against $0.01494 is **1.11×**. Cropping's floor is the cheapest
thing you can send and still be having a conversation, and nothing that adds a
summary to it will ever go below it. Anyone selling summarisation as a saving
over a sliding window is selling you a number that does not exist. What the
extra 11% bought here is three facts out of three instead of none.

Against **full history** it is 4% cheaper at seventeen turns — $0.01654 against
$0.01716 — with the summarizer included and with the same three-out-of-three
recall. That margin is thin here and grows without limit, because full history's
per-turn input climbs every turn (81, 156, … 1,240 and still going) while the
compressed payload oscillates between five and ten exchanges forever.

**The trap is the last two rows.** At a window of 5 the fold size is 2, so the
summarizer runs every other turn: 5,669 summarizer tokens instead of 2,007, and
an all-in cost of $0.02064 — **more expensive than sending the entire history
every single turn**, for no better recall. Because the fold size is half the
window, the window is also the compression cadence, and shrinking it to save on
the main call spends far more on the summarizer than it saves. That is why the
default is 10 and the minimum is 2.

The other end has its own trap, less costly: at a window of 20 this
seventeen-turn conversation never reaches the mark at all, so compression never
runs and you have paid for a summarizer that did nothing — $0.01770, which is
full history with extra steps.

So the honest summary of all of it:

- **vs. cropping:** compression costs 11% more and recalls facts that cropping
  loses outright. It is a quality purchase, not a saving.
- **vs. full history:** compression costs 4% less at seventeen turns and
  proportionally less at every turn after, at no measured cost in recall.
- **the window is the cost dial.** Halving it doubles how often the summarizer
  runs. Below about 8 exchanges, compression costs more than not compressing.
- **the summarizer is not free:** 2,007 tokens and $0.00295 over the run, plus
  1.2–1.4s of latency on the two turns it ran. All of it is reported separately,
  in `meta.tokens.compression`, in `usage.summarizer*`, and in its own stat in
  the UI, so it cannot quietly disappear into the comparison it is part of.

### Reproducing the compression runs

```bash
npm start
```

Open http://localhost:3000, leave **Window** at 10, and untick **Compress**.
Plant three specific facts in the first three turns, chat about anything for a
dozen more, then ask for the facts back. Tick **Compress**, start a **New
conversation**, and do exactly the same thing — the summary panel fills in on
the turn the window first reaches 10, and flashes when it does.

Then open **Compare** at the foot of the right-hand column, paste the recall
question, and read the three answers and their token counts against each other.

## Routes

| Route | What it does |
| --- | --- |
| `POST /chat` | `{ message, sessionId, contextMessages?, maxTokens? }` → `{ reply, meta }` |
| `POST /reset` | Clears one conversation, in memory and in the store |
| `GET /conversations` | Summaries for the sidebar, newest first, each with `totalCostUsd` |
| `GET /conversations/:id` | `{ messages, summary, summarizedThrough, summaryUpdatedAt }`, for repainting a transcript and its summary panel |
| `GET /conversations/:id/usage` | Per-turn counts and running totals, for the chart |
| `POST /conversations/:id/replay` | `{ question, contextMessages? }` → the same answer three ways, with tokens and cost for each |
| `DELETE /conversations/:id` | Deletes it and evicts the cached agent |
| `GET /pricing.js` | The server's own pricing module, served to the browser |

`contextMessages` (2–100, default 10) counts **exchanges**, not messages
outright, and is a high-water mark rather than a sliding window. It,
`compressionEnabled` (boolean, default true) and `maxTokens` (1–8192, default
1024) are live controls in the UI, validated per request. `summarizeEvery`
(1–100) is an optional override for the fold size and is *not* a UI control:
omitted, it is half the window, which is what the browser always sends. The JSON body limit is **5 MB**, not Express's
default 100 KB — a long pasted message is exactly the input worth putting a
token count on, and the default would reject it before the agent ever saw it.

`/replay` is strictly read-only: it loads the stored record, builds three
payloads from it and throws them away. No message is appended, no summary is
written, and the conversation's usage totals are untouched — the three
completions it pays for belong to the experiment, not to the conversation. Each
arm reports its own failure rather than throwing, because an over-long full
history is an interesting outcome and should not take the other two answers down
with it.
