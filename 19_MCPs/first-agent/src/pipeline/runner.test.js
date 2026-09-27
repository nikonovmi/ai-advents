import assert from "node:assert/strict";
import test from "node:test";

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

import { agentFor } from "../agents.js";
import { FakeProvider } from "../llm/anthropic.js";
import { McpRegistry } from "../mcp/servers.js";
import { McpToolbox } from "../mcp/toolbox.js";
import { MemoryMcpAuthStore } from "../store/mcpAuthStore.js";
import { MemoryStore } from "../store/memoryStore.js";
import { PipelineRunner, SCOPE_NOTE } from "./runner.js";

/**
 * **One pipeline run, offline.** The three MCP servers are stub SDK clients
 * behind a real registry (Notion with OAuth, so "needs auth" is the real
 * path), and the model is a `FakeProvider` behind a spy that keeps every
 * payload it was sent — which is how "no history" and "step 2 saw step 1's
 * exact output" are checked, rather than assumed.
 */

const CONVERSATION = "66666666-6666-4666-8666-666666666666";
const SCHEDULE_ID = 9;
const T0 = Date.parse("2026-09-27T12:00:00.000Z");
const HISTORY = "An earlier run said: The Matrix (1999) is the best film.";

const SEARCH_RESULT = {
  query: "batman",
  totalResults: 2,
  results: [
    { title: "Batman Begins", year: "2005", imdbId: "tt0372784" },
    { title: "The Batman", year: "2022", imdbId: "tt1877830" },
  ],
};
const SUMMARY = "Batman Begins (2005) and The Batman (2022) came up. Both are Batman films. That is what was found.";
const NOTION_PAGE = { pages: [{ id: "page-1", url: "https://www.notion.so/page-1" }] };

const schema = (properties, required = []) => ({ type: "object", properties, required });
const SERVER_TOOLS = {
  omdb: [
    { name: "search_movies", inputSchema: schema({ query: { type: "string" } }, ["query"]) },
    { name: "get_movie", inputSchema: schema({ imdbId: { type: "string" } }) },
    { name: "random_movie", inputSchema: schema({}) },
  ],
  notion: [{ name: "notion-create-pages", inputSchema: schema({ pages: { type: "array" } }, ["pages"]) }],
  scheduler: [
    { name: "record", inputSchema: schema({ scheduleId: { type: "number" }, key: { type: "string" }, label: { type: "string" } }, ["scheduleId", "key", "label"]) },
    { name: "aggregate", inputSchema: schema({ scheduleId: { type: "number" } }, ["scheduleId"]) },
    { name: "delete_schedule", inputSchema: schema({ scheduleId: { type: "number" } }, ["scheduleId"]) },
  ],
};
const PORTS = { 3991: "omdb", 3992: "notion", 3993: "scheduler" };

/**
 * @param {{ answer?: (server: string, name: string, args: object) => object, notionAuthorized?: boolean }} [options]
 */
function stubServers({ answer, notionAuthorized = true } = {}) {
  const calls = [];
  const registry = new McpRegistry({
    servers: [
      { id: "omdb", name: "OMDb", url: "http://127.0.0.1:3991/mcp", auth: "none" },
      { id: "notion", name: "Notion", url: "http://127.0.0.1:3992/mcp", auth: "oauth" },
      { id: "scheduler", name: "Scheduler", url: "http://127.0.0.1:3993/mcp", auth: "none" },
    ],
    authStore: new MemoryMcpAuthStore(),
    createTransport: (options) => ({ ...options }),
    createClient: () => {
      let server;
      return {
        async connect(transport) {
          server = PORTS[transport.url.port];
          if (server === "notion" && !notionAuthorized) throw new UnauthorizedError("token expired");
        },
        getServerVersion: () => ({ name: server, version: "1.0.0" }),
        async listTools() {
          return { tools: SERVER_TOOLS[server].map((tool) => ({ description: tool.name, ...tool })) };
        },
        async callTool({ name, arguments: args }) {
          calls.push({ server, name, args: structuredClone(args) });
          const custom = answer?.(server, name, args);
          if (custom) return custom;
          if (name === "search_movies") return { content: [{ type: "text", text: JSON.stringify(SEARCH_RESULT) }], structuredContent: SEARCH_RESULT };
          // Notion answers in text only: the runner parses it.
          if (name === "notion-create-pages") return { content: [{ type: "text", text: JSON.stringify(NOTION_PAGE) }] };
          if (name === "get_movie") return { content: [{ type: "text", text: "Batman Begins (2005), 140 min" }] };
          return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }], structuredContent: { ok: true } };
        },
        async close() {},
      };
    },
  });
  return { registry, toolbox: new McpToolbox({ registry }), calls };
}

/** Every payload the model was sent, deep-copied as it was at the time. */
function spyOn(inner) {
  const payloads = [];
  return {
    payloads,
    provider: {
      async complete(params) {
        payloads.push(structuredClone({ system: params.system, messages: params.messages, tools: params.tools }));
        return inner.complete(params);
      },
    },
  };
}

/** A pipeline chat that already has history — which must never be sent. */
async function pipelineChat(store = new MemoryStore()) {
  await store.save(
    CONVERSATION,
    [{ role: "assistant", content: HISTORY, run: { runId: 1, durationMs: 900, tokens: 50, ok: true } }],
    { totalInputTokens: 100, totalOutputTokens: 10, totalCostUsd: 0, turnCount: 1 },
    { agentId: "pipeline" }
  );
  return store;
}

function runnerWith({ store, servers = stubServers(), inner = new FakeProvider({ delayMs: 0, reply: SUMMARY }) }) {
  const clock = { at: T0 };
  const spy = spyOn(inner);
  const appended = [];
  const runner = new PipelineRunner({
    provider: spy.provider,
    store,
    registry: servers.registry,
    toolbox: servers.toolbox,
    now: () => (clock.at += 100),
    onAppended: (id) => appended.push(id),
  });
  return { runner, payloads: spy.payloads, calls: servers.calls, appended, clock };
}

const claimed = (steps) => ({
  run: { id: 5, scheduleId: SCHEDULE_ID, status: "running" },
  schedule: { id: SCHEDULE_ID, conversationId: CONVERSATION, mode: "once", steps, intervalSeconds: 15, enabled: false },
});

const BATMAN = [
  { kind: "tool", server: "omdb", tool: "search_movies", args: { query: "batman" } },
  { kind: "prompt", text: "Summarize what you found in 3 sentences:\n{{prev}}" },
  {
    kind: "tool",
    server: "notion",
    tool: "notion-create-pages",
    args: { creation_mode: "draft", pages: [{ properties: { title: "Batman summary {{now}}" }, content: "{{prev}}" }] },
  },
];

test("tool → prompt → tool: each step gets exactly the previous step's output", async () => {
  const store = await pipelineChat();
  const { runner, payloads, calls } = runnerWith({ store });

  const outcome = await runner.run(claimed(BATMAN));
  assert.equal(outcome.ok, true, outcome.error);

  // Step 1 was called with its literal args, by code.
  assert.deepEqual(calls[0], { server: "omdb", name: "search_movies", args: { query: "batman" } });

  // Step 2's prompt carries step 1's output, exactly (structuredContent, as JSON).
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0].messages, [
    { role: "user", content: `Summarize what you found in 3 sentences:\n${JSON.stringify(SEARCH_RESULT)}` },
  ]);
  assert.equal(payloads[0].system, agentFor("pipeline").systemPrompt, "no tools, so no scope note");
  assert.equal(payloads[0].tools, undefined, "allowTools is off: no tools offered");

  // Step 3's args carry step 2's exact text, and {{now}} is the runner's clock.
  const notion = calls.find((call) => call.server === "notion");
  assert.equal(notion.name, "notion-create-pages");
  assert.equal(notion.args.creation_mode, "draft");
  assert.equal(notion.args.pages[0].content, SUMMARY);
  assert.match(notion.args.pages[0].properties.title, /^Batman summary 2026-09-27T12:00:0\d\.\d{3}Z$/);

  // What goes to finish_run: every step's resolved input and output.
  assert.deepEqual(
    outcome.steps.map(({ index, kind, server, tool, status }) => ({ index, kind, server, tool, status })),
    [
      { index: 1, kind: "tool", server: "omdb", tool: "search_movies", status: "ok" },
      { index: 2, kind: "prompt", server: undefined, tool: undefined, status: "ok" },
      { index: 3, kind: "tool", server: "notion", tool: "notion-create-pages", status: "ok" },
    ]
  );
  assert.deepEqual(outcome.steps[0].output, SEARCH_RESULT);
  assert.equal(outcome.steps[1].input, payloads[0].messages[0].content);
  assert.equal(outcome.steps[1].output, SUMMARY);
  assert.ok(outcome.steps[1].tokens > 0);
  assert.deepEqual(outcome.steps[2].input, notion.args);
  assert.deepEqual(outcome.steps[2].output, NOTION_PAGE, "a JSON text result is parsed");
  for (const step of outcome.steps) assert.equal(typeof step.ms, "number");
});

test("one message per run: the last output as text, and the step strip", async () => {
  const store = await pipelineChat();
  const { runner, appended } = runnerWith({ store });
  const outcome = await runner.run(claimed(BATMAN));

  const record = await store.load(CONVERSATION);
  assert.equal(record.messages.length, 2);
  const message = record.messages.at(-1);
  assert.equal(message.role, "assistant");
  assert.equal(message.content, "```json\n" + JSON.stringify(NOTION_PAGE, null, 2) + "\n```");
  assert.equal(outcome.output, message.content);
  assert.deepEqual(
    message.steps.map(({ index, kind, label, status }) => `${index} ${kind} ${label} ${status}`),
    ["1 tool search_movies ok", "2 prompt prompt ok", "3 tool notion-create-pages ok"]
  );
  assert.ok(message.steps.every((step) => typeof step.ms === "number"));
  assert.equal(message.run.runId, 5);
  assert.equal(message.run.ok, true);
  assert.equal(message.tokens.total, outcome.tokens);
  assert.deepEqual(appended, [CONVERSATION]);
  assert.equal(record.usage.turnCount, 2);

  // A pipeline that ends on a prompt posts the text itself.
  const store2 = await pipelineChat();
  const { runner: runner2 } = runnerWith({ store: store2 });
  await runner2.run(claimed(BATMAN.slice(0, 2)));
  assert.equal((await store2.load(CONVERSATION)).messages.at(-1).content, SUMMARY);
});

test("fail fast: a failing step stops the run, the rest are skipped, one message says where", async () => {
  const store = await pipelineChat();
  const servers = stubServers({
    answer: (server, name) => (name === "search_movies" ? { isError: true, content: [{ type: "text", text: "OMDb: Movie not found!" }] } : null),
  });
  const { runner, payloads, calls } = runnerWith({ store, servers });

  const outcome = await runner.run(claimed(BATMAN));
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /Step 1 \(search_movies\): OMDb: Movie not found!/);
  assert.deepEqual(outcome.steps.map((step) => step.status), ["error", "skipped", "skipped"]);
  assert.deepEqual(outcome.steps[0].input, { query: "batman" }, "the input it failed with is kept");
  assert.equal(payloads.length, 0, "the model was never called");
  assert.equal(calls.filter((call) => call.server === "notion").length, 0);

  const record = await store.load(CONVERSATION);
  assert.equal(record.messages.length, 2);
  const message = record.messages.at(-1);
  assert.equal(message.content, "⚠️ Run #5 failed at step 1 (search_movies): OMDb: Movie not found!");
  assert.equal(message.run.ok, false);
  assert.deepEqual(message.steps.map((step) => step.status), ["error", "skipped", "skipped"]);
  assert.equal(record.usage.turnCount, 1, "a failed run counts no turn");
});

test("fail fast on a template that points at nothing, and on a thrown call", async () => {
  const store = await pipelineChat();
  const { runner } = runnerWith({ store });
  const outcome = await runner.run(
    claimed([
      { kind: "tool", server: "omdb", tool: "search_movies", args: { query: "batman" } },
      { kind: "tool", server: "omdb", tool: "get_movie", args: { imdbId: "{{steps.1.results.7.imdbId}}" } },
      { kind: "prompt", text: "never" },
    ])
  );
  assert.deepEqual(outcome.steps.map((step) => step.status), ["ok", "error", "skipped"]);
  assert.match(outcome.steps[1].error, /steps\.1\.results has no "7"/);

  const throwing = stubServers({
    answer: () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    },
  });
  const { runner: runner2 } = runnerWith({ store: await pipelineChat(), servers: throwing });
  const down = await runner2.run(claimed(BATMAN));
  assert.deepEqual(down.steps.map((step) => step.status), ["error", "skipped", "skipped"]);
  assert.match(down.steps[0].error, /omdb\.search_movies could not be called: fetch failed \(ECONNREFUSED\)/);
});

test("Notion without a valid login fails its step with 'Reconnect Notion in the panel'", async () => {
  const store = await pipelineChat();
  const { runner } = runnerWith({ store, servers: stubServers({ notionAuthorized: false }) });
  const outcome = await runner.run(claimed(BATMAN));
  assert.deepEqual(outcome.steps.map((step) => step.status), ["ok", "ok", "error"]);
  assert.equal(outcome.steps[2].error, "Reconnect Notion in the panel.");
  assert.equal(outcome.steps[2].input.pages[0].content, SUMMARY, "the resolved input is still recorded");
  assert.match((await store.load(CONVERSATION)).messages.at(-1).content, /failed at step 3 \(notion-create-pages\): Reconnect Notion/);
});

test("no history in any prompt payload; allowTools offers only the allowlist, with the scope note", async () => {
  const store = await pipelineChat();
  const inner = new FakeProvider({
    delayMs: 0,
    reply: "plain answer",
    script: [
      { toolUse: [{ name: "omdb__get_movie", input: { imdbId: "tt0372784" } }] },
      { toolUse: [{ name: "scheduler__delete_schedule", input: {} }] },
      { text: "Batman Begins runs 140 minutes." },
    ],
  });
  const { runner, payloads, calls } = runnerWith({ store, inner });

  const outcome = await runner.run(
    claimed([
      { kind: "prompt", text: "Name one Batman film." },
      { kind: "prompt", text: "Look up the runtime of {{prev}}", allowTools: true },
      { kind: "prompt", text: "First said {{steps.1}}, then {{steps.2}}" },
    ])
  );
  assert.equal(outcome.ok, true, outcome.error);
  assert.ok(payloads.length >= 4);
  for (const payload of payloads) {
    assert.ok(!JSON.stringify(payload).includes("The Matrix"), "no chat history leaks into any payload");
  }
  // Each step starts from a fresh context: its own text is the first and only user turn it opens with.
  const firsts = payloads.filter((payload) => payload.messages.length === 1).map((payload) => payload.messages[0].content);
  assert.deepEqual(firsts, [
    "Name one Batman film.",
    "Look up the runtime of plain answer",
    "First said plain answer, then Batman Begins runs 140 minutes.",
  ]);

  const withTools = payloads.filter((payload) => payload.tools);
  assert.equal(withTools.length, 3, "only the allowTools step offered tools");
  assert.deepEqual(withTools[0].tools.map((tool) => tool.name).sort(), [
    "omdb__get_movie", "omdb__random_movie", "omdb__search_movies", "scheduler__aggregate", "scheduler__record",
  ]);
  assert.equal(withTools[0].system, `${agentFor("pipeline").systemPrompt}\n\n${SCOPE_NOTE}`);
  // The hidden tool the model named anyway was refused, never called.
  assert.equal(calls.some((call) => call.name === "delete_schedule"), false);
  assert.deepEqual(outcome.steps[1].toolCalls.map((call) => `${call.server}.${call.tool}:${call.ok}`), ["omdb.get_movie:true", "scheduler.delete_schedule:false"]);
});

test("a tool step on the scheduler's record/aggregate gets its own scheduleId", async () => {
  const store = await pipelineChat();
  const { runner, calls } = runnerWith({ store });
  await runner.run(claimed([{ kind: "tool", server: "scheduler", tool: "aggregate", args: {} }]));
  assert.deepEqual(calls, [{ server: "scheduler", name: "aggregate", args: { scheduleId: SCHEDULE_ID } }]);
});

test("no steps: one message saying so; a deleted chat: nothing written back", async () => {
  const store = await pipelineChat();
  const { runner, payloads } = runnerWith({ store });
  const outcome = await runner.run(claimed([]));
  assert.equal(outcome.ok, false);
  assert.match((await store.load(CONVERSATION)).messages.at(-1).content, /has no steps/);
  assert.equal(payloads.length, 0);

  const empty = new MemoryStore();
  const { runner: orphanRunner, calls } = runnerWith({ store: empty });
  const orphan = await orphanRunner.run(claimed(BATMAN));
  assert.equal(orphan.orphan, true);
  assert.equal(calls.length, 0);
  assert.equal(await empty.load(CONVERSATION), null);
});
