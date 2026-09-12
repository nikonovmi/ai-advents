# Day 7 — Context Persistence (incremental change to the existing `first-agent` project)

This is an update to the existing project, not a rewrite. Keep the current structure, naming conventions, and code style. Do not restructure anything not listed below.

Goal: conversation history survives a server restart, and the user can switch between multiple saved conversations.

## NEW FILES

```
src/store/
  conversationStore.js   — the storage abstraction (base class)
  jsonFileStore.js       — JSON file implementation
  memoryStore.js         — in-memory implementation for tests
data/conversations/      — created at runtime, gitignored
```

Mirror the `src/llm/` provider pattern exactly: an abstract base class defining the contract, concrete implementations behind it, injected into the Agent. `agent.js` must not contain the string `fs`, `path`, or any filename.

## `src/store/conversationStore.js` — the abstraction

Export an abstract class `ConversationStore` whose methods all throw `Not implemented`:

- `async load(sessionId)` → `{ id, title, createdAt, updatedAt, messages }` or `null` if absent
- `async save(sessionId, messages)` → persists, returns the saved record
- `async clear(sessionId)` → deletes the conversation
- `async listSessions()` → array of `{ id, title, updatedAt, messageCount }`, sorted by `updatedAt` descending

`messages` is the same provider-neutral `{ role, content }` array already used by `LlmProvider` — the two abstractions share that shape.

Also export `isValidSessionId(id)`: true only for a canonical UUID v4 string.

## `src/store/jsonFileStore.js`

- `class JsonFileStore extends ConversationStore`, constructor takes `{ dir }`.
- Default dir resolved from the module, NOT the cwd: `path.join(import.meta.dirname, "..", "..", "data", "conversations")`. Running `npm start` from any directory must behave identically.
- `mkdir({ recursive: true })` on first use.
- One file per conversation: `<sessionId>.json`, shaped:

```json
{
  "id": "9f2c...",
  "title": "Debugging the retry logic",
  "createdAt": "2026-09-12T10:04:11.902Z",
  "updatedAt": "2026-09-12T10:19:44.310Z",
  "messages": [{ "role": "user", "content": "..." }]
}
```

- **Path safety (required):** every method validates `sessionId` with `isValidSessionId` and throws before touching the filesystem if it fails. The id arrives from the client, so an unvalidated id is an arbitrary file read/write. Never concatenate a raw id into a path.
- **Atomic writes (required):** write to `<sessionId>.json.tmp` in the same directory, then `rename()`. A crash mid-write must leave the previous file intact, never a truncated one.
- `title` is derived on first save from the first user message, trimmed to 40 chars with an ellipsis if cut. It is preserved on subsequent saves, not recomputed. `createdAt` is set once; `updatedAt` on every save.
- `load()` returns `null` for a missing file. A corrupt/unparseable file must not crash the server — log a warning and treat it as missing.
- `listSessions()` reads the directory, parses each file, skips corrupt ones, returns the summary objects sorted newest-first.

## `src/store/memoryStore.js`

`class MemoryStore extends ConversationStore` backed by a `Map`. Same contract, no filesystem. Used by tests and as a fallback if the data directory is unwritable.

## CHANGES TO `src/agent.js`

- Constructor gains `store` and `sessionId` in its options object. Throw if either is missing, matching how `provider` is already validated.
- Add a static factory, since hydration is async and a constructor can't be:
  `static async load({ provider, store, sessionId, ...options })` — constructs the Agent, calls `store.load(sessionId)`, populates `#history` from the result (empty array if `null`), returns the instance.
- In `run()`, after the assistant turn is appended and history trimmed, `await this.store.save(this.sessionId, this.#history)`. A store failure must not lose the reply: catch, log the error, and still return the result to the caller.
- `reset()` becomes `async` and also calls `await this.store.clear(this.sessionId)`.
- Everything else — retry logic, `#history` privacy, the `{ text, meta }` return shape — stays as it is.

Note the interaction with `historyLimit`: trimming happens before saving, so the file holds the trimmed history. That is intended — the file is the agent's memory, not an audit log.

## CHANGES TO `src/server.js`

- Construct one `JsonFileStore` at startup alongside the existing provider, and share both across agents.
- The existing `Map<sessionId, Agent>` becomes a **cache in front of the store**, not the source of truth. On a cache miss, `await Agent.load({ provider, store, sessionId, ... })` instead of constructing a blank Agent. This single change is what makes restart-and-continue work.
- Validate `sessionId` with `isValidSessionId` on every route that accepts one; 400 on failure.

New endpoints:
- `GET /conversations` → `store.listSessions()`
- `GET /conversations/:id` → `{ messages }` from `store.load()`, so the frontend can repaint a transcript; 404 if absent
- `DELETE /conversations/:id` → clears the store and evicts the agent from the cache
- Keep `POST /chat` and `POST /reset` as they are, aside from the validation above.

## CHANGES TO `public/index.html`

- **`sessionId` moves to `localStorage`.** Read it on load; generate with `crypto.randomUUID()` and store it only if absent. This is the change that makes the demo work at all — a per-load random id would look like amnesia even with persistence working correctly.
- On page load, after resolving the id, `GET /conversations/:id` and repaint the existing transcript into the message list before accepting input.
- Add a conversation sidebar: title plus a relative timestamp ("2m ago"), newest first, active one highlighted. Clicking a row loads that transcript and switches the stored `sessionId`. A small × per row calls `DELETE` and refreshes the list.
- "New conversation" now generates a fresh id, stores it, clears the view, and refreshes the sidebar. It no longer calls `/reset`.
- Refresh the sidebar after each reply so titles appear as conversations start.
- On narrow screens the sidebar should collapse or stack rather than squeezing the chat column.

## OTHER

- Add `data/` to `.gitignore`.
- Update `README.md`: a short section on persistence — where conversations are stored, the one-file-per-conversation layout, and why the store is an abstraction (`MemoryStore` swaps in for tests with no disk access).

## FINALLY

Restart the server and verify by hand:
1. Start a conversation, tell the agent a fact, confirm it responds.
2. Stop the server with Ctrl+C and start it again.
3. Reload the browser and ask the agent to recall the fact — it must answer correctly.
4. Create a second conversation, then switch back to the first via the sidebar and confirm both transcripts are intact and separate.
