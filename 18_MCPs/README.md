# Day 17 — a local MCP server, and an agent that calls it


https://github.com/user-attachments/assets/4e906e3c-0944-41a9-853a-6710f7ca721f


Two sibling Node projects that talk to each other over MCP (streamable HTTP):

| project | port | role |
| --- | --- | --- |
| [`imdb_mcp_server`](imdb_mcp_server) | 3001 | MCP **server**: exposes OMDb (IMDb data) as tools |
| [`first-agent`](first-agent) | 3000 | chat app + MCP **client**: its agents can call those tools |

## imdb_mcp_server

A stateless MCP server at `http://127.0.0.1:3001/mcp` (localhost only) with three tools:
`search_movies`, `get_movie`, `random_movie`. It wraps the OMDb API, normalizes the
results (`"148 min"` → `148`, `"N/A"` → `null`) and turns every failure into
`isError: true` instead of a crash. The `OMDB_API_KEY` stays in its own `.env` and
never leaves the server.

## first-agent

The chat app from earlier days (layered memory, task lifecycle, Notion MCP via OAuth),
extended with:

- **An MCP registry** (`src/mcp/servers.js`): Notion (`oauth`) and OMDb (`none`), with
  per-server routes `/mcp/:server/{status,connect,tools,disconnect}` and one UI panel
  section per server.
- **Tool use**: agents opt in with `mcpServers: [...]` — the **Movie buff** agent uses
  `omdb`. Tools are offered to Claude as `omdb__get_movie` etc.; `Agent.run()` loops
  model → tool call → model (max 5 rounds) until it gets a text reply.
- **Clean history**: raw `tool_use`/`tool_result` blocks are never stored; the reply
  carries `toolCalls: [{ server, tool, input, ok, resultPreview, ms }]`, shown in the UI
  as collapsible `🔧 omdb.get_movie (230 ms)` rows.

## Run it

```bash
cd imdb_mcp_server && npm install && cp .env.example .env   # add OMDB_API_KEY
npm start                                                   # :3001

cd ../first-agent && npm install                            # ANTHROPIC_API_KEY in .env
npm start                                                   # http://localhost:3000
```

Pick **Movie buff** and ask: *"Is Inception longer than The Matrix, and which is rated
higher?"* — the agent searches, fetches both films, and answers from real data.

Direct check, no model: `npm run mcp:call -- omdb get_movie '{"title":"Inception"}'`
(from `first-agent`). Both projects have offline test suites: `npm test`.

See each project's own README for details, and [`PROMPT.md`](PROMPT.md) for the task spec.
