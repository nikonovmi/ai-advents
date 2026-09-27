Day 19: composable pipelines. Rework the scheduled agent so each chat is a
pipeline of steps, and each step's output feeds the next.

CONCEPT
- Rename the "Movie picker" agent to "Pipeline" (kind "scheduled" stays).
  Each chat is one pipeline, configured in the right panel.
- A pipeline is an ordered list of steps. Each step is one of:
  - tool: a fixed MCP call { server, tool, args }. Code calls it directly,
    with no LLM.
  - prompt: { text, allowTools? }. An LLM call with a fresh context
    (persona + this step's text). If allowTools is on, it runs the Day 17
    tool loop with the agent's allowlist.
- Data moves between steps by code only, via templates:
  - {{prev}} is the previous step's output, {{steps.N}} is the output of step
    N (1-based), and {{now}} is the ISO timestamp.
  - In tool args (JSON): if a string value is exactly one template, substitute
    the raw value (objects stay objects). Otherwise interpolate as a string
    (objects are JSON.stringify'd).
  - A tool step's output is structuredContent if present, else the text
    content (JSON.parse'd when it parses). A prompt step's output is the
    final text.
- Fail fast: a failed step (isError, an exception, or a template that refers to
  a missing step) stops the run. Later steps are marked skipped, and the run
  is marked error.
- Mode per chat: "once" (runs only via the Run button) or "interval" (every N
  seconds, min 15, on the Day 18 ticker). Still no chat history is ever sent
  to the model.

scheduler_mcp_server
- schedules: replace prompt with steps (JSON) and add mode ("once" |
  "interval"). Migrate existing rows: prompt → [{ kind:"prompt", text }],
  mode "interval".
- claim_due_runs claims interval schedules as before, plus any schedule with
  a pending run_now, regardless of mode. For mode "once", nextRunAt stays null
  after the run.
- A new table run_steps (id, runId, index, kind, server, tool, input JSON,
  output JSON, status ok|error|skipped, error, ms, tokens). finish_run
  accepts steps[] and stores them atomically with the run (this replaces the
  run_tool_calls idea; tool calls made inside a prompt step are nested in that
  step's row). get_run returns the run + steps.
- Validate steps on create/update: each step has a known kind and required
  fields, and templates only refer to earlier steps.

first-agent
- src/pipeline/templates.js: pure resolve(template, context) with the rules
  above.
- src/pipeline/runner.js: replaces the Day 18 single-prompt runner. It executes
  the steps in order through the MCP clients / LlmProvider, records each
  step's resolved input, output, status, ms and tokens, calls finish_run, and
  appends ONE assistant message to the chat: the last step's output as text,
  plus steps: [{ index, kind, label, status, ms }] for the UI strip.
- Tool steps can call any tool on a connected server (omdb, notion, scheduler).
  Prompt steps with allowTools use the agent's allowlist only.
- Notion saving: use whatever is easiest. Read the real create-page tool name
  and schema from listTools (don't guess). If it can create a page without a
  parent, do that; otherwise pick a default parent once (NOTION_PARENT_PAGE_ID
  in .env, or the first page returned by Notion's search) and document it. If
  Notion auth has expired, fail that step with "Reconnect Notion in the panel".
- Routes: GET/PUT /conversations/:id/pipeline ({ mode, intervalSeconds,
  enabled, steps }), POST /conversations/:id/pipeline/run, GET
  /conversations/:id/runs/:runId (the step details).

UI
- The right panel's Schedule section becomes a Pipeline editor:
  - a mode switch (Once / Every N s), the interval input and an enabled
    toggle (interval mode only), and a Run button (both modes)
  - an ordered list of step cards with add, remove and move up/down
  - a tool card: a server + tool dropdown (from /mcp/:server/tools), and an
    args JSON textarea prefilled with a skeleton from the tool's inputSchema
  - a prompt card: a textarea and an "allow tools" checkbox
  - a one-line hint listing {{prev}}, {{steps.N}} and {{now}}
  - Save validates, and shows server-side errors inline
- Run messages in the chat show a step strip ("1 search_movies ✓ 120 ms → 2
  prompt ✓ 1.4 s → 3 notion ✓ 800 ms"). Clicking a step loads get_run and
  shows its exact resolved input and output as plain, pretty-printed JSON.
  This is the proof of correct data transfer.

TESTS (offline)
- templates: whole-value vs interpolated substitution, nested paths, a
  missing step → error, {{now}} with an injected clock.
- runner with stub clients + FakeProvider: a 3-step tool → prompt → tool
  chain where step 2's prompt contains step 1's exact output and step 3's args
  contain step 2's exact text; fail-fast marks the rest skipped; no history
  in any prompt payload; one message per run.
- scheduler: steps validation, the migration from prompt, a once-mode schedule
  claimed only via run_now, run_steps stored atomically.
- All existing tests stay green in all three projects.

DONE WHEN
Start all three servers. Create a Pipeline chat with:
  1. tool omdb.search_movies { "query": "batman" }
  2. prompt "Summarize what you found in 3 sentences:\n{{prev}}"
  3. tool notion <create-page tool> with title "Batman summary {{now}}" and
     the content {{prev}}
Run it once: the chat shows the step strip with all steps ✓, and the
page appears in Notion with the summary. Switch to Every 15 s, enable it, and
see a new run (and Notion page) every tick. Then disable it. Run all test
suites, then start the servers.

