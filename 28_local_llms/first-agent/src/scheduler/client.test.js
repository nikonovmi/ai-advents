import assert from "node:assert/strict";
import test from "node:test";

import { MAX_STEP_JSON_CHARS, SchedulerClient, SchedulerToolError, SchedulerUnavailableError } from "./client.js";

/** The client only unwraps: data, a tool error, or "not reachable". */

function clientAnswering(answer) {
  const calls = [];
  const mcp = {
    url: "http://127.0.0.1:3002/mcp",
    async callTool(name, args) {
      calls.push({ name, args });
      return answer(name, args);
    },
  };
  return { client: new SchedulerClient({ mcp }), calls };
}

test("structuredContent comes back as data, and lists are unwrapped", async () => {
  const { client, calls } = clientAnswering((name) =>
    name === "get_schedule" ? { structuredContent: { schedule: null } } : { structuredContent: { runs: [{ id: 1 }] } }
  );
  assert.equal(await client.getSchedule("c-1"), null);
  assert.deepEqual(await client.listRuns(4, 10), [{ id: 1 }]);
  assert.deepEqual(calls, [
    { name: "get_schedule", args: { conversationId: "c-1" } },
    { name: "list_runs", args: { scheduleId: 4, limit: 10 } },
  ]);
});

test("isError is a SchedulerToolError with the server's sentence", async () => {
  const { client } = clientAnswering(() => ({ isError: true, content: [{ type: "text", text: "No schedule with id 9." }] }));
  await assert.rejects(client.aggregate(9), (err) => err instanceof SchedulerToolError && err.message === "No schedule with id 9.");
});

test("a transport failure is SchedulerUnavailableError, naming the URL", async () => {
  const { client } = clientAnswering(() => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  });
  await assert.rejects(client.claimDueRuns({ now: 1 }), (err) => err instanceof SchedulerUnavailableError && /3002.*ECONNREFUSED/.test(err.message));
});

test("finish_run sends only the fields it has", async () => {
  const { client, calls } = clientAnswering(() => ({ structuredContent: { id: 3 } }));
  await client.finishRun({ runId: 3, ok: false, error: "boom", output: undefined, tokens: null });
  assert.deepEqual(calls[0].args, { runId: 3, ok: false, error: "boom" });
});

test("finish_run carries the steps, only the fields each has, with oversized JSON capped", async () => {
  const { client, calls } = clientAnswering(() => ({ structuredContent: { id: 4 } }));
  const huge = { text: "x".repeat(MAX_STEP_JSON_CHARS + 10) };
  await client.finishRun({
    runId: 4,
    ok: true,
    output: "done",
    steps: [
      { index: 1, kind: "tool", server: "omdb", tool: "search_movies", input: { query: "batman" }, output: huge, status: "ok", ms: 12, tokens: null },
      { index: 2, kind: "prompt", status: "skipped" },
    ],
  });
  const [first, second] = calls[0].args.steps;
  assert.deepEqual(first.input, { query: "batman" });
  assert.equal(first.output.truncated, true);
  assert.equal(first.output.chars, JSON.stringify(huge).length);
  assert.equal(first.output.preview.length, MAX_STEP_JSON_CHARS);
  assert.equal("tokens" in first, false);
  assert.deepEqual(second, { index: 2, kind: "prompt", status: "skipped" });
});
