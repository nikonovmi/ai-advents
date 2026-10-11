# scheduler_mcp_server

MCP server at `http://127.0.0.1:3002/mcp` (localhost only) that stores pipelines, runs
and records in SQLite. It runs nothing itself: first-agent's ticker claims due runs.

```bash
npm install
npm start      # PORT (3002), SCHEDULER_DB (data/scheduler.db)
npm test
```

A schedule is `{ goal, plan, proposal, mode: "once" | "interval", intervalSeconds, enabled }`.
`plan` is the accepted step list, the only thing a run executes. `proposal` is a plan
waiting to be accepted, or null. A schedule without a plan is never claimed. Older
databases are migrated on open.

## Tools

App-only (never offered to a model): `create_schedule`, `get_schedule`, `update_schedule`,
`delete_schedule`, `list_schedules`, `claim_due_runs`, `finish_run`, `get_run`, `list_runs`,
`run_now`, `release_runs`.

For plans and models (first-agent fills in `scheduleId`), both with an `outputSchema`:

| tool | does |
| --- | --- |
| `record { key, label, data? }` | store one result |
| `aggregate {}` | counts over the records: invocations, unique keys, most repeated, first, last |
