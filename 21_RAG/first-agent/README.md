# first-agent

A chat app with layered memory, a task lifecycle, MCP tools and planned pipelines.
Node + Express, vanilla front end, no build step.

```bash
npm install
echo 'ANTHROPIC_API_KEY=sk-ant-…' > .env    # omit for the offline FakeProvider
npm start                                   # http://localhost:3000
```

| script | does |
| --- | --- |
| `npm test` | offline tests: no key, no network |
| `npm run eval:planner [-- <goal id>]` | plans 8 goals with the real model; exit 1 on a wrong tool sequence |
| `npm run mcp:tools [-- omdb]` | list one MCP server's tools |
| `npm run mcp:call -- omdb get_movie '{"title":"Inception"}'` | call one MCP tool directly |
| `npm run lifecycle` / `scenario` / `compare` | memory and task-lifecycle demos |

## Agents

Defined in `src/agents.js`; each has its own chat list.

- **first-agent**, **pirate support**: plain chat with memory (short-term, digest,
  working task, long-term profile, project invariants) and the
  `planning → execution → validation → done` lifecycle.
- **Movie buff**: chat that calls the OMDb tools.
- **Pipeline** (`claude-sonnet-5`): each chat is one pipeline. Read-only feed of runs.

## Pipelines

1. **Goal → proposal.** *Generate plan* calls the planner (`src/pipeline/planner.js`)
   once, with `submit_plan` forced. It sees a catalog of the agent's `plannerTools`, as
   `server.tool` with description, inputSchema and outputSchema, plus which servers are down.
2. **Validation** (`src/pipeline/validatePlan.js`): tools exist, args match the
   inputSchema, and every `{{steps.N.path}}` exists in step N's output shape. An invalid
   plan gets one retry with its errors; still invalid → nothing stored.
3. **Accept → plan.** Runs (Run button, or every N ≥ 15 s) always execute the accepted
   plan; the planner is not called.
4. **Repair.** After a failed run the planner proposes a fix once; it waits for Accept.

Steps:

- `tool { server, tool, args }`: one MCP call made by code.
- `prompt { text, format: "text" | "json", outputSchema? }`: one model call from a
  fresh context, up to 4096 output tokens. A json step returns an object checked
  against its `outputSchema`.

Templates: `{{prev}}`, `{{steps.N.path}}`, `{{now}}`. `scheduler.record` / `aggregate`
always get the chat's own `scheduleId`. The first failing step stops the run; click a
step in a run's strip to see its exact input and output.

## MCP servers

| id | url | auth |
| --- | --- | --- |
| `notion` | `https://mcp.notion.com/mcp` | OAuth: press Connect in the panel; tokens in `data/mcp/notion.json` (git-ignored) |
| `omdb` | `http://127.0.0.1:3001/mcp` | none, [`../imdb_mcp_server`](../imdb_mcp_server) |
| `scheduler` | `http://127.0.0.1:3002/mcp` | none, [`../scheduler_mcp_server`](../scheduler_mcp_server) |

URLs can be overridden with `NOTION_MCP_URL`, `OMDB_MCP_URL`, `SCHEDULER_MCP_URL`.

## Pipeline routes

| route | does |
| --- | --- |
| `GET`/`PUT /conversations/:id/pipeline` | `{ goal, mode, intervalSeconds, enabled }`; GET also returns `plan`, `proposal` |
| `POST /conversations/:id/pipeline/plan` | `{ goal? }` → run the planner, store the proposal (422 with `errors` if invalid) |
| `POST /conversations/:id/pipeline/proposal` | `{ action: "accept" \| "discard" }` |
| `POST /conversations/:id/pipeline/run` | run the accepted plan now |
| `GET /conversations/:id/runs[/:runId]` | recent runs; one run's steps with input and output |
