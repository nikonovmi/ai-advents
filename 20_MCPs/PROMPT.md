Day 20: MCP orchestration. The Pipeline agent plans its own steps from a goal.

CONCEPT
- A Pipeline chat gets a goal (prose). A planner call turns the goal into a
  plan in the Day 19 step format, choosing tools from ALL connected MCP
  servers (omdb, scheduler, notion). The Day 19 runner executes it unchanged.
- This mirrors the chat agent's lifecycle: planning produces a proposal (like
  the brief), you accept or discard it, and execution runs the accepted plan.
  The plan is frozen once accepted: interval runs reuse it, and the planner
  is NOT called on each tick.
- The manual step builder is removed from the UI.

MCP SERVERS: declare output shapes
- imdb_mcp_server and scheduler_mcp_server: add outputSchema to every tool
  that the planner can see, and make structuredContent match it. Check the
  current SDK docs for how outputSchema is registered. Update the tests.

PLANNER (first-agent, src/pipeline/planner.js)
- The catalog is built from the connected servers' listTools: name (namespaced
  server.tool), description, inputSchema, and outputSchema when present.
  Exclude app-only tools (claim_due_runs, schedule management, finish_run,
  get_run, etc.). The planner is told which registered servers are currently
  down.
- One LLM call (the agent's model) with a forced submit_plan tool, so the plan
  comes back structured. submit_plan input: { steps: [...], notes? }, where
  each step also carries a short "why" explaining the tool choice.
- Prompt steps gain format: "text" | "json". Planner rules (in the system
  prompt):
  - use tool steps for fetching and saving, and prompt steps only for judgment
    and wording
  - reference fields via {{steps.N.path}} only when that step's output shape
    is known (an outputSchema, or a json prompt step)
  - otherwise add a json prompt step that reshapes {{prev}}
  - never invent tools or servers
- The Day 19 validator runs on the plan, extended to check that tools exist in
  the catalog, args validate against the inputSchema (use ajv), and template
  paths exist in the referenced step's outputSchema where one is declared.
  If invalid, send the errors back to the planner for ONE retry; if it's still
  invalid, show the errors and store nothing.
- For tool steps that call scheduler.record/aggregate, the runner injects
  scheduleId (as for prompt steps in Day 18). The planner never sees
  scheduleId.
- Repair: when a run fails, call the planner once with the goal, the plan,
  the step outputs so far and the error, and store the result as a pending
  proposal (never auto-applied). Interval runs keep using the accepted plan,
  and the failure plus the proposal show in the panel.

scheduler_mcp_server
- schedules: add goal (text), plan (the accepted steps; this replaces steps)
  and proposal (JSON or null: { steps, notes, createdAt, reason:
  "generated"|"repair", errors? }). Migrate: existing steps → plan, goal "".
- claim_due_runs only claims schedules that have an accepted plan.

ROUTES
- PUT  /conversations/:id/pipeline: { goal, mode, intervalSeconds, enabled }
  (steps are no longer accepted from the UI).
- POST /conversations/:id/pipeline/plan: runs the planner and stores the
  proposal.
- POST /conversations/:id/pipeline/proposal: { action: "accept" | "discard" }.
  Accept moves proposal → plan.
- The run and run-details routes stay as in Day 19.

UI (right panel for Pipeline chats)
- A goal textarea with a Generate plan button (with a loading state).
- The proposal as a read-only step list: # · server.tool or "prompt (json)",
  the args/text templates, and the "why" line. Planner notes, validation
  errors, and for repairs the failing run's error, are shown too. Accept and
  Discard buttons.
- The accepted plan as the same read-only list, plus mode, interval, the
  enabled toggle, Run, and the run log.
- Delete the step-builder UI and its code.
- The Day 19 step strip in run messages stays.

TESTS (offline, FakeProvider scripted to call submit_plan)
- The catalog excludes app-only tools and down servers, and includes
  outputSchema.
- A valid plan is stored as the proposal; accept → plan; discard → cleared.
- An invalid plan (unknown tool, bad args, bad template path) → one retry with
  the errors in the prompt → a second failure stores nothing.
- Interval runs never call the planner.
- A failed run produces a repair proposal and leaves the plan untouched.
- scheduleId is injected into scheduler tool steps.
- The migration from Day 19 steps.
- All existing tests stay green in all three projects.

EVAL (real API, not part of npm test): npm run eval:planner
- 6-8 goals, each with the expected ordered tool sequence (prompt steps as
  "prompt"). It prints each generated plan and whether its tool sequence
  matches, and exits non-zero on a mismatch. Include single-server goals and
  the cross-server scenario below.

DONE WHEN
Start all three servers. Create a Pipeline chat with the goal:
  "Look up Inception, The Matrix and Heat. Pick the one with the highest IMDb
   rating, write a 3-sentence summary of it, save the summary to Notion, and
   record the winner in this chat's history."
Generate plan → the expected shape is omdb.get_movie ×3 → a json prompt step
(picks the winner and writes the summary) → a notion create-page step →
scheduler.record (key = the winner's imdbId). Accept and Run: every step ✓, the
Notion page exists, and the step details show each step's exact input and
output. Run npm run eval:planner and all test suites, then start the servers.

