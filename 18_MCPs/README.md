# Day 18 — scheduled agents

https://github.com/user-attachments/assets/80823cc9-f8fb-4d48-aca4-5700f8a8a44c


A periodic task per chat, backed by a scheduler MCP server with SQLite.

| project | port | role |
| --- | --- | --- |
| [`imdb_mcp_server`](imdb_mcp_server) | 3001 | OMDb tools; `random_movie` picks from 500 films by the clock |
| [`scheduler_mcp_server`](scheduler_mcp_server) | 3002 | schedules, runs and records in SQLite |
| [`first-agent`](first-agent) | 3000 | chat app; **scheduled agents** |

Each chat of a scheduled agent is one task (on/off, interval, prompt). A 15 s ticker
claims due runs; each run starts fresh (persona + prompt + allowlisted tools, no
history) and posts one message. Data lives in SQLite, so counts survive restarts.

## Run it

```bash
cd imdb_mcp_server && npm install && cp .env.example .env && npm start   # OMDB_API_KEY
cd scheduler_mcp_server && npm install && npm start
cd first-agent && npm install && npm start                               # ANTHROPIC_API_KEY
```

Pick **Movie picker**, set the prompt to *"Call random_movie, record it (key = imdbId,
label = 'Title (Year)'), then call aggregate and reply in one line: Invoked N times ·
K unique films · last: Title (Year)."*, interval 15, tick Enabled.

Tests: `npm test` in each project. Spec: [`PROMPT.md`](PROMPT.md).
