# first-agent

A minimal chat app: an Express server, a plain-HTML chat UI, and a reusable
`Agent` class sitting behind a provider-neutral LLM abstraction.


https://github.com/user-attachments/assets/58c02d23-5d1e-447e-aced-4757de728ebd


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

## Layout

```
src/
  llm/
    provider.js    the abstraction (LlmProvider + LlmError)
    anthropic.js   AnthropicProvider + FakeProvider
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

`Agent` depends on exactly one thing:

```js
async complete({ system, messages, temperature, maxTokens }) // → { text, model }
```

`messages` is a plain `{ role, content }[]`, deliberately not any vendor's wire
format, and the result is plain text plus a model name. Raw HTTP responses,
content blocks, headers and credentials all stop at that boundary — so `agent.js`
contains no URL, no key, no `fetch`, and no vendor name at all.

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
  "messages": [{ "role": "user", "content": "…" }]
}
```

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
async load(sessionId)          // → { id, title, createdAt, updatedAt, messages } | null
async save(sessionId, messages)
async clear(sessionId)
async listSessions()           // → summaries, newest first
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

## Routes

| Route | What it does |
| --- | --- |
| `POST /chat` | `{ message, sessionId }` → `{ reply, meta }` |
| `POST /reset` | Clears one conversation, in memory and in the store |
| `GET /conversations` | Summaries for the sidebar, newest first |
| `GET /conversations/:id` | `{ messages }`, for repainting a transcript |
| `DELETE /conversations/:id` | Deletes it and evicts the cached agent |
