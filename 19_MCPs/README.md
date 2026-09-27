# Day 19 — composable pipelines

A pipeline per chat: ordered steps, each feeding the next, run once or every N seconds.

| project | port | role |
| --- | --- | --- |
| [`imdb_mcp_server`](imdb_mcp_server) | 3001 | OMDb tools; `random_movie` picks from 500 films by the clock |
| [`scheduler_mcp_server`](scheduler_mcp_server) | 3002 | pipelines, runs, run steps and records in SQLite |
| [`first-agent`](first-agent) | 3000 | chat app; **Pipeline** agent |

A step is a **tool** (an MCP call made by code, no LLM) or a **prompt** (an LLM call
from a fresh context). Data moves via `{{prev}}`, `{{steps.N}}`, `{{now}}`. The first
failing step stops the run. Click a step in a run's strip to see its exact input/output.

## Run it

```bash
cd imdb_mcp_server && npm install && cp .env.example .env && npm start   # OMDB_API_KEY
cd scheduler_mcp_server && npm install && npm start
cd first-agent && npm install && npm start                               # ANTHROPIC_API_KEY
```

Connect Notion, pick **Pipeline**, add the steps from
[`first-agent/README.md`](first-agent/README.md#pipelines), Save, Run.

Tests: `npm test` in each project. Spec: [`PROMPT.md`](PROMPT.md).
