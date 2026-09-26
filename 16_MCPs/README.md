# first-agent

A chat app with layered memory and an explicit task lifecycle. Node + Express,
vanilla front end, no build step.

```bash
npm install
echo 'ANTHROPIC_API_KEY=sk-ant-…' > .env    # omit for the offline FakeProvider
npm start                                   # http://localhost:3000
```

| script | does |
| --- | --- |
| `npm test` | 162 tests; stubs, no key, no network |
| `npm run lifecycle` | one task through every stage (`-- --fake` offline) |
| `npm run scenario` | recall: 5 planted facts over 15 turns, plus the bill |
| `npm run compare` | one message against several profiles or rule sets |
| `npm run mcp:tools` | connect to Notion's MCP with stored tokens, print its tools |
| `node scripts/migrate-conversations.js` | one-off: split legacy branched records |

---

## Architecture

Injected seams. Nothing above them knows about HTTP, vendors or files.

| | answers |
| --- | --- |
| `LlmProvider` | who the model is (`AnthropicProvider`, `FakeProvider`) |
| `ConversationStore` | where a conversation lives (`JsonFileStore`, `MemoryStore`) |
| `ContextStrategy` | what goes on the wire (`context/memory.js`) |
| `ProfileStore` / `InvariantStore` | what outlives the conversation |
| `McpClient` / `McpAuthStore` | which MCP server, and the login to it |

```
src/
  server.js              routes
  memoryRoutes.js        the memory and task routes
  mcpRoutes.js           the MCP routes: status, connect, callback, tools
  agent.js               one conversation: run() → one turn
  agents.js              the agent registry (persona per agent)
  summarizer.js          the digest fold
  context/
    strategy.js          the ContextStrategy contract
    index.js             createStrategy, DEFAULT_STRATEGY
    memory.js            the strategy: layers, extraction, panel
    taskState.js         STAGES, TRANSITIONS, guards
    invariants.js        project rules: authoring, refusals
    patch.js             ROUTES, key validation, op coercion
    boundaries.js        payload opens on a user message; pairs never split
    comparison.js        N-profile / N-project replay, read-only
  mcp/
    mcpClient.js         McpClient: connect, listTools (paged), close
    oauthProvider.js     the SDK's OAuthClientProvider, backed by the store
  store/
    conversationStore.js record shape, read-time migration, forkFrom
    jsonFileStore.js     data/conversations/<uuid>.json
    profileStore.js      data/memory/<user>.json
    invariantStore.js    data/invariants/<project>.json
    mcpAuthStore.js      data/mcp/<server>.json (git-ignored)
public/
  index.html             the whole UI
  markdown.js            marked + DOMPurify, tag allowlist
```

`Agent.run()` is five steps: read the history, let the strategy build the
payload, call the model, append the reply, let the strategy update its state. The
strategy's state is opaque to the Agent.

---

## State

| layer | holds | lives in | ends when |
| --- | --- | --- | --- |
| Short-term | recent exchanges verbatim | the record's `messages` | it falls past the floor |
| Digest | rolling summary of what scrolled past | `memory.digest` | never; rewritten at each fold |
| Working | the task in hand | `memory.working`, `memory.task` | the task reaches `done` |
| Long-term | what is known about the user | `data/memory/<user>.json` | explicit delete |
| Invariants | what the project may not do | `data/invariants/<project>.json` | explicit delete |

The extractor proposes a **key**; its namespace decides the layer
(`context/patch.js`):

| namespace | layer | notes |
| --- | --- | --- |
| `goal` | working | singular |
| `constraint`, `finding`, `open` | working | |
| `decision`, `agreement` | working | promotable to long-term |
| `profile`, `preference`, `rule` | long-term | |
| `invariant` | long-term | person-only; a model may not write one |

Two billed schedules, counted apart from the conversation's own tokens:
extraction on every user turn, the fold at the high-water mark.

### The record

```js
{ id, title, createdAt, updatedAt, usage, project, agentId, forkedFrom, memory, messages }
```

Read-time migration handles older shapes — flat arrays, and the branch map that
predates forks. Writes go to `.tmp` and are renamed.

### Task lifecycle

`planning → execution → validation → done`, plus `execution → planning` and
`validation → execution`. The stage is derived from an append-only transition
log, so it survives a restart with no model call. Each stage contributes an
instruction line to the prompt. Leaving `planning` freezes the goal and replaces
the planning messages with a written brief. Guards refuse an illegal edge with
`200 ok:false` and a reason.

---

## Agents and forking

An **agent** is an id, a name, a persona and optionally a model, defined in
`src/agents.js`. Each has its own chat list. A conversation records its `agentId`
and the record wins over the dropdown, so reopening a chat never repoints it.

A **fork** is a new conversation: new id, the transcript up to the forked
message, a deep copy of `memory`, and `forkedFrom` for provenance. There are no
branches.

---

## MCP

The app connects to [Notion's hosted MCP server](https://developers.notion.com/docs/mcp)
(`https://mcp.notion.com/mcp`, override with `NOTION_MCP_URL`) through the official
`@modelcontextprotocol/sdk` over streamable HTTP, falling back to SSE only if that
fails. Scope today is connect and list tools; nothing is wired into `Agent.run()`.

The OAuth flow, in four lines:

1. `POST /mcp/connect` gets a 401; the SDK discovers the auth server and registers
   `first-agent` as a public client (dynamic registration, no pre-issued id).
2. It builds a PKCE authorization URL, which our provider captures instead of opening.
3. The UI opens it in a popup; Notion redirects to `/mcp/oauth/callback?code&state`.
4. The route checks `state`, calls `transport.finishAuth(code)`, and reconnects.

Refresh is the SDK's, through the same provider. A 401 it cannot refresh its way out
of is "needs auth" again, never a 500.

Client registration, tokens, the PKCE verifier and `state` live in
`data/mcp/notion.json` — written `.tmp`+rename, mode `0600`, git-ignored, never
logged. Disconnect deletes the file.

`npm run mcp:tools` uses the same file: it prints `Connected to <name> <version>` and
a table of tools, or, with no tokens, the authorization URL and a pointer to the
Connect button (the callback is a route on the running app).

---

## HTTP

| route | does |
| --- | --- |
| `POST /chat` | one turn; `agent`, `profile`, `project`, window and ceiling |
| `GET /conversations` | the list; `?agent=` scopes it |
| `GET /conversations/:id` | transcript and panel |
| `POST /conversations/:id/fork` | split at a message |
| `GET /conversations/:id/usage` | per-turn and cumulative cost |
| `DELETE /conversations/:id` | delete it |
| `POST /reset` | clear a conversation in place |
| `GET /agents`, `/profiles`, `/projects` | the pickers, from their owners |
| `GET /profiles/:id` | one profile, as stored |
| `DELETE /profiles/:id`, `/projects/:id` | delete; the default id is emptied |
| `POST …/memory/transition` | one edge of the machine |
| `POST …/memory/brief` | `accept` (with edits) or `discard` |
| `POST …/memory/new-task` | a successor task, once `done` |
| `POST …/memory/ops` | forget, promote, profile edits, accept an invariant |
| `POST …/memory/invariants/propose` | prose in, proposal rows out; writes nothing |
| `POST …/memory/proposals/:proposalId` | `approve` (with edits) or `reject` |
| `POST …/memory/compare` | same message, N profiles or rule sets; read-only |
| `GET /mcp/status` | `{ connected, server, toolCount }` |
| `POST /mcp/connect` | connect with stored tokens, or `{ ok: false, authUrl }` |
| `GET /mcp/oauth/callback` | finish the login, reconnect; `?error=` is a page, not a crash |
| `GET /mcp/tools` | `{ tools: [{ name, description, inputSchema }] }`, every page |
| `POST /mcp/disconnect` | close and delete the stored login |

Memory routes read the record, hand the state to the strategy, write it back and
drop the cached `Agent`. A conversation nobody has spoken in is a valid state,
not a 404.

---

## UI

A list of chats on the left, the transcript in the middle, a panel on the right.
The agent is a dropdown in the title; the topbar holds the window, the token
ceiling and the profile and project pickers. Above the transcript: the cost curve
only. The panel shows what the next turn would be sent, then the running totals,
then the layers, the brief, proposals and the digest. A stage strip above the
composer renders one button per legal edge.

Replies render as Markdown via `marked`, sanitized by `DOMPurify` against an
explicit tag allowlist (`public/markdown.js`). User text is not rendered.

At the foot of the right panel, **MCP · Notion**: a status dot, Connect/Disconnect,
and a collapsible list of the server's tools. Descriptions are plain text.
