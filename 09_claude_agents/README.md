# first-agent

A minimal chat app: an Express server, a plain-HTML chat UI, and a reusable
`Agent` class sitting behind a provider-neutral LLM abstraction.

It reports real token usage and cost for every turn and for the conversation as
a whole, and it shows what breaks when history is cropped to a small window.


https://github.com/user-attachments/assets/c9091763-f0a8-4818-ac17-c34e262338a1


## Install

Requires Node 18+ (native `fetch`).

```bash
npm install
```

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

Two controls sit next to the composer. **User msgs** (1–100) is how many recent
user messages get sent to the model, replies included; **Max tokens** caps the
reply, and setting it to 30 is the quickest way to see a truncated one. Above the transcript, a strip of
totals and a cumulative-cost chart update after every turn.

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
  agent.js         the Agent class and the personas
  server.js        Express routes and session bookkeeping
public/
  index.html       the chat UI
data/
  conversations/   saved conversations (created at runtime, gitignored)
```

## The provider abstraction

`Agent` depends on exactly two methods:

```js
async complete({ system, messages, temperature, maxTokens })
// → { text, model, stopReason, usage: { inputTokens, outputTokens } }

async countTokens({ system, messages })  // → { inputTokens }
```

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
    "turnCount": 15
  },
  "messages": [
    { "role": "user", "content": "…", "tokens": { "request": 40 } },
    {
      "role": "assistant",
      "content": "…",
      "tokens": { "request": 40, "sent": 122, "input": 122, "output": 64, "total": 186 },
      "cost": { "input": 0.000122, "output": 0.00032, "total": 0.000442 },
      "model": "claude-haiku-4-5-20251001",
      "ms": 1612,
      "stopReason": "end_turn"
    }
  ]
}
```

The whole conversation is written, never the cropped view — cropping is what
the model sees, the file is what the agent knows. Cumulative totals live on the
record, so they survive a restart: reload the page after `npm start` and the
turn count and running cost carry on from where they were.

Conversations written before any of this existed still load. A missing `usage`
key reads back as zeros and messages with no `tokens` field simply show no
counter, rather than failing the file.

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

## The context window

`contextMessages` (default **5**) is how many of the most recent **user**
messages are sent to the model, along with every reply that came after them. A
window of 5 is five exchanges — typically nine or ten messages on the wire.

Counting user turns rather than messages outright is what keeps the window
stable. If it counted messages, a model that answered in several parts could
push the user's own question out of the very request meant to answer it; a
window of 5 would sometimes mean five exchanges and sometimes two.

The crop applies **only to what is sent**. Nothing is ever deleted from
`#history` or from disk:

```js
#windowStart() {
  const window = Math.max(1, Math.floor(this.contextMessages));
  let seen = 0;
  for (let i = this.#history.length - 1; i >= 0; i--) {
    if (this.#history[i].role !== "user") continue;
    if (++seen === window) return i;
  }
  return 0;
}
```

`droppedCount` is that index — everything before it is stored and unsent. It is
reported in messages, not user turns, because messages are what the transcript
shows.

That is the whole point, and it is the behaviour that replaced the old
`historyLimit` (which really did throw messages away). The agent's memory on
disk is complete; its *view* is a sliding window. A conversation with 30 stored
messages and a window of 5 has 20 messages that it has written down and cannot
see.

The UI makes that legible rather than theoretical: a banner above the input
states the window size and the live dropped count, a dashed divider labelled
`⟵ outside the model's context` sits at the boundary in the transcript, and the
bubbles above it are dimmed. The **User msgs** input next to the composer
changes it live, so you can watch the divider move without sending anything.

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

Open http://localhost:3000, set **User msgs** to 5, and paste the turn-1 fact.
Ask for it back ten turns later. Then set it to 50 and do it again.

## Routes

| Route | What it does |
| --- | --- |
| `POST /chat` | `{ message, sessionId, contextMessages?, maxTokens? }` → `{ reply, meta }` |
| `POST /reset` | Clears one conversation, in memory and in the store |
| `GET /conversations` | Summaries for the sidebar, newest first, each with `totalCostUsd` |
| `GET /conversations/:id` | `{ messages }`, for repainting a transcript |
| `GET /conversations/:id/usage` | Per-turn counts and running totals, for the chart |
| `DELETE /conversations/:id` | Deletes it and evicts the cached agent |
| `GET /pricing.js` | The server's own pricing module, served to the browser |

`contextMessages` (1–100, default 5) counts **user** messages, not messages
outright. It and `maxTokens` (1–8192, default 1024) are live controls in the
UI, validated per request. The JSON body limit is **5 MB**,
not Express's default 100 KB — a long pasted message is exactly the input worth
putting a token count on, and the default would reject it before the agent ever
saw it.
