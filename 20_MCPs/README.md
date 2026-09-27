# Day 20 — MCP orchestration

https://github.com/user-attachments/assets/be711d68-1255-40fb-ac61-d11645b58893

A Pipeline chat takes a **goal**. A planner turns it into steps across every connected
MCP server (OMDb, scheduler, Notion); you accept the proposal; the runner executes it,
once or every N seconds, always on the same accepted plan. A failed run leaves a repair
proposal that nothing applies until you accept it.

| project | port | role |
| --- | --- | --- |
| [`imdb_mcp_server`](imdb_mcp_server) | 3001 | OMDb tools |
| [`scheduler_mcp_server`](scheduler_mcp_server) | 3002 | pipelines, runs and records in SQLite |
| [`first-agent`](first-agent) | 3000 | chat app with the Pipeline agent and its planner |

## Run it

```bash
cd imdb_mcp_server && npm install && cp .env.example .env && npm start   # OMDB_API_KEY
cd scheduler_mcp_server && npm install && npm start
cd first-agent && npm install && npm start                               # ANTHROPIC_API_KEY
```

Open http://localhost:3000, connect Notion, pick **Pipeline**, write a goal,
**Generate plan**, **Accept**, **Run**.

Tests: `npm test` in each project. Planner eval (real API, servers running):
`npm run eval:planner` in `first-agent`. Spec: [`PROMPT.md`](PROMPT.md).
