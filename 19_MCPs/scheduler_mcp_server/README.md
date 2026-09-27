# scheduler_mcp_server

MCP server (`http://127.0.0.1:3002/mcp`, localhost only) that stores pipelines, runs
and run steps in SQLite. It runs nothing itself; first-agent's ticker claims due runs.

A schedule is `{ mode: "once" | "interval", steps, intervalSeconds, enabled }`; steps are
validated on save (`src/steps.js`), including templates that must point to earlier
steps. A Day 18 database is migrated on open (`prompt` → one prompt step).

```bash
npm install
npm start      # PORT (3002), SCHEDULER_DB (data/scheduler.db)
npm test
```

## Tools

App-only (never offered to a model):

| tool | does |
| --- | --- |
| `create_schedule` / `get_schedule` / `update_schedule` / `delete_schedule` / `list_schedules` | CRUD, one per conversation |
| `claim_due_runs { now?, graceMs? }` | atomically claim due interval schedules plus any pending `run_now` |
| `finish_run { runId, ok, …, steps? }` | close a run and store its steps in one transaction |
| `get_run { runId }` | `{ run, steps }` with each step's input and output |
| `list_runs` / `run_now` / `release_runs` | recent runs / request a run / close runs left open by a restart |

For the model (first-agent injects `scheduleId`):

| tool | does |
| --- | --- |
| `record { scheduleId, key, label, data? }` | store one result |
| `aggregate { scheduleId }` | counts over the records, in SQL |
