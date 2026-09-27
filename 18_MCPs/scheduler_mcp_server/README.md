# scheduler_mcp_server

MCP server (streamable HTTP, `http://127.0.0.1:3002/mcp`, localhost only) that stores
schedules, runs and records in SQLite. first-agent's ticker asks it what is due; it
runs nothing itself.

```bash
npm install
npm start      # PORT (3002), SCHEDULER_DB (data/scheduler.db)
npm test
```

## Tools

App-only (never offered to a model):

| tool | does |
| --- | --- |
| `create_schedule` / `get_schedule` / `update_schedule` / `delete_schedule` / `list_schedules` | CRUD; one schedule per `conversationId`; interval ≥ 15 s; delete cascades runs and records |
| `claim_due_runs { now?, graceMs? }` | one transaction: release runs `running` > 5 min, then claim every enabled schedule with `nextRunAt <= now + graceMs` and no open run; `nextRunAt = now + interval` |
| `finish_run { runId, ok, output?, error?, tokens? }` | close a run |
| `list_runs { scheduleId, limit? }` | newest first |
| `run_now { scheduleId }` | `nextRunAt = now` |
| `release_runs` | close all open runs (called once by a restarted ticker) |

For the model (first-agent injects `scheduleId`):

| tool | does |
| --- | --- |
| `record { scheduleId, key, label, data? }` | store one result |
| `aggregate { scheduleId }` | `{ invocations, uniqueKeys, mostRepeated, first, last }`, computed in SQL |

`graceMs` and `release_runs` are additions to the spec: without them a 15 s schedule
on a 15 s tick slips to 30 s on timer jitter, and a restart blocks a schedule for 5 min.
