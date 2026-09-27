Day 18: scheduled agents. A periodic task per chat, backed by a scheduler MCP
server with SQLite.

CONCEPT
- A new agent kind, "scheduled". Each chat of a scheduled agent IS one periodic
  task, configured in the right panel (on/off, interval, prompt).
- Every run starts from a fresh context: persona + the chat's prompt + tools.
  The chat history is never sent to the model.
- Every run posts one assistant message into the chat. The chat is a read-only
  feed: no composer, no user messages, no fork.
- Scheduled agents skip the task lifecycle (planning/execution/validation),
  extraction and the memory layers entirely. They reuse the LlmProvider and the
  Day 17 tool loop.

PART 1: NEW SERVER (sibling project ../scheduler_mcp_server)
- Node + ES modules, @modelcontextprotocol/sdk, zod, Express, better-sqlite3.
  Streamable HTTP at http://127.0.0.1:3002/mcp, localhost only, log the URL on
  start.
- DB file at data/scheduler.db (path configurable). Add a .gitignore excluding
  node_modules, .env and data/. Add a README.
- Tables:
  - schedules: id, conversationId (unique), prompt, intervalSeconds,
    enabled, nextRunAt, createdAt, updatedAt
  - runs: id, scheduleId, status (running|ok|error), claimedAt, finishedAt,
    output, error, tokens
  - records: id, scheduleId, key, label, data (JSON), createdAt
- Tools for app code (first-agent will hide them from the model):
  - create_schedule, get_schedule (by conversationId), update_schedule,
    delete_schedule (cascades runs + records), list_schedules
  - claim_due_runs { now? }: in ONE transaction, pick enabled schedules with
    nextRunAt <= now and no run in status "running", insert a run, and set
    nextRunAt = now + intervalSeconds. Return the claimed runs with their
    schedule. A "running" run older than 5 min counts as stale: mark it error
    and let it be claimed again.
  - finish_run { runId, ok, output?, error?, tokens? }
  - list_runs { scheduleId, limit }
  - run_now { scheduleId }: sets nextRunAt = now, so the next tick claims it.
- Tools for the model:
  - record { scheduleId, key, label, data? }: stores one result.
  - aggregate { scheduleId } → { invocations, uniqueKeys, mostRepeated:
    { label, count }, first: { label, at }, last: { label, at } }. Computed in
    SQL, no raw rows returned.
- Tests (node:test, temp DB file): claim is atomic and never double-claims;
  disabled schedules aren't claimed; interval math; stale-claim release;
  aggregate numbers; data survives closing and reopening the DB; delete
  cascades.

PART 2: imdb_mcp_server CHANGES
- Replace the curated random list with src/top500.js: 500 IMDb ids of
  well-known, highly rated films.
- random_movie takes no input. n is derived from the current time:
  n = hash(Date.now()) % 500, using a multiplicative hash (e.g. Math.imul with
  2654435761, taken unsigned). A plain Date.now() % 500 would repeat, because
  the 15 s tick is a multiple of 500 ms. Fetch that film via the get_movie
  logic and return { n, pickedAt, ...movie }.
- Add scripts/validate-top500.js (manual, NOT run by npm test or on start): it
  checks every id against OMDb and reports bad ones. It uses ~500 of the 1,000
  daily calls, so say so in its header.
- Update the tests: inject the clock, and check n is in range and spreads across
  consecutive 15 s timestamps.

PART 3: first-agent
- Registry (src/mcp/servers.js): add { id:"scheduler", name:"Scheduler",
  url: SCHEDULER_MCP_URL || "http://127.0.0.1:3002/mcp", auth:"none" }.
- src/agents.js: add kind: "chat" (the default for existing agents) or
  "scheduled". Add a "Movie picker" agent: kind "scheduled", mcpServers
  ["omdb","scheduler"], a short persona. It has NO task prompt; that lives
  per chat.
- Tool exposure: the model sees only an allowlist per scheduled agent
  (omdb random_movie/get_movie/search_movies, scheduler record/aggregate).
  scheduleId is removed from the schemas the model sees and injected by the
  app at call time, so a run can only write to its own schedule.
- src/scheduler/ticker.js: a plain-code setInterval every 15 s
  (SCHEDULER_TICK_MS, default 15000) that calls claim_due_runs directly, with
  no LLM. For each claimed run, it runs the ScheduledRunner and then calls
  finish_run. The ticker starts with the server. If the scheduler server is
  down, log once and skip the tick. The clock and clients are injected for
  tests.
- src/scheduler/runner.js: builds [system: persona + "scheduleId context is
  handled for you", user: the chat's prompt], runs the tool loop (max 5
  rounds), then appends ONE assistant message to the conversation with
  toolCalls (as in Day 17) and run metadata { runId, durationMs, tokens }.
  Usage goes into the conversation's usage as usual. It must not go through
  ContextStrategy, the task lifecycle or extraction.
- Conversation lifecycle for scheduled agents: creating a chat also calls
  create_schedule (enabled: false, intervalSeconds: 60, prompt: ""). Deleting
  the chat also calls delete_schedule. POST /chat to a scheduled conversation
  returns 400 with a reason, and fork is disabled for it.
- Routes: GET/PUT /conversations/:id/schedule ({ enabled, intervalSeconds
  (min 15), prompt }), POST /conversations/:id/schedule/run-now,
  GET /conversations/:id/runs. All of them call the scheduler tools from code.

PART 4: UI
- In a scheduled agent's chat: hide the composer, the stage strip and the
  fork buttons. The transcript polls every 5 s while the chat is open, so new
  runs appear live.
- The right panel replaces the memory layers with a Schedule section:
  - an enabled toggle
  - an interval input in seconds (min 15; note that runs land on the 15 s tick)
  - a prompt textarea, with Save and Run now buttons
  - a next-run countdown
  - the last 10 runs (status, time, duration, tokens, error)
  - a small aggregate readout
- Each run message shows its toolCalls rows like Day 17.

TESTS (first-agent, offline)
- Ticker with a fake clock + stub clients: claims → runs → finish_run; a
  failure calls finish_run with ok:false and doesn't stop the ticker; server
  down → the tick is skipped.
- Runner: the payload contains only persona + prompt (no history); scheduleId
  is injected into record/aggregate calls; hidden tools never reach the model;
  exactly one message is appended per run.
- Routes: schedule GET/PUT validation; POST /chat to a scheduled chat → 400;
  deleting a chat deletes its schedule.
- The existing tests stay green.

DONE WHEN
Start imdb_mcp_server (3001), scheduler_mcp_server (3002) and first-agent (3000).
Create a Movie picker chat and set its prompt to: "Call random_movie, record it
(key = imdbId, label = 'Title (Year)'), then call aggregate and reply in one
line: Invoked N times · K unique films · last: Title (Year)." Set the interval
to 15 s and enable it. A new line appears in the chat about every 15 s with
growing counts. After restarting first-agent the counts continue from where they
were. Disable it and the runs stop. Run all three test suites, then start the
servers.

