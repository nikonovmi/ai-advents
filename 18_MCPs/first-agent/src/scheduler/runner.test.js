import assert from "node:assert/strict";
import test from "node:test";

import { agentFor } from "../agents.js";
import { FakeProvider } from "../llm/anthropic.js";
import { LlmError } from "../llm/provider.js";
import { McpRegistry } from "../mcp/servers.js";
import { McpToolbox } from "../mcp/toolbox.js";
import { MemoryMcpAuthStore } from "../store/mcpAuthStore.js";
import { MemoryStore } from "../store/memoryStore.js";
import { SCOPE_NOTE, ScheduledRunner } from "./runner.js";

/**
 * **One scheduled run, offline.** A scripted `FakeProvider` is the model; the
 * two MCP servers are stub SDK clients behind a real registry and toolbox, so
 * the allowlist and the scheduleId injection are exercised on the real path.
 */

const CONVERSATION = "44444444-4444-4444-8444-444444444444";
const SCHEDULE_ID = 7;
const PROMPT = "Call random_movie, record it, then call aggregate and reply in one line.";
const T0 = Date.parse("2026-09-27T12:00:00.000Z");

const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const schema = (properties, required = []) => ({ type: "object", properties, required });

const SERVER_TOOLS = {
  omdb: [
    { name: "search_movies", inputSchema: schema({ query: { type: "string" } }, ["query"]) },
    { name: "get_movie", inputSchema: schema({ imdbId: { type: "string" } }) },
    { name: "random_movie", inputSchema: schema({}) },
  ],
  scheduler: [
    "create_schedule", "get_schedule", "update_schedule", "delete_schedule", "list_schedules",
    "claim_due_runs", "finish_run", "list_runs", "run_now", "release_runs",
  ].map((name) => ({ name, inputSchema: schema({ scheduleId: { type: "number" } }) })).concat([
    { name: "record", inputSchema: schema({ scheduleId: { type: "number" }, key: { type: "string" }, label: { type: "string" }, data: { type: "object" } }, ["scheduleId", "key", "label"]) },
    { name: "aggregate", inputSchema: schema({ scheduleId: { type: "number" } }, ["scheduleId"]) },
  ]),
};

const INCEPTION = { n: 42, pickedAt: new Date(T0).toISOString(), title: "Inception", year: "2010", imdbId: "tt1375666" };

function stubServers() {
  const calls = [];
  const registry = new McpRegistry({
    servers: [
      { id: "omdb", name: "OMDb", url: "http://127.0.0.1:3991/mcp", auth: "none" },
      { id: "scheduler", name: "Scheduler", url: "http://127.0.0.1:3992/mcp", auth: "none" },
    ],
    authStore: new MemoryMcpAuthStore(),
    createTransport: (options) => ({ ...options }),
    createClient: () => {
      let server;
      return {
        async connect(transport) {
          server = transport.url.port === "3991" ? "omdb" : "scheduler";
        },
        getServerVersion: () => ({ name: server, version: "1.0.0" }),
        async listTools() {
          return { tools: SERVER_TOOLS[server].map((tool) => ({ description: tool.name, ...tool })) };
        },
        async callTool({ name, arguments: args }) {
          calls.push({ server, name, args });
          if (name === "random_movie") return json(INCEPTION);
          if (name === "record") return json({ id: 1, ...args });
          if (name === "aggregate") return json({ invocations: 3, uniqueKeys: 2, last: { label: "Inception (2010)" } });
          return json({ ok: true });
        },
        async close() {},
      };
    },
  });
  return { toolbox: new McpToolbox({ registry }), calls };
}

/** A scheduled chat that already has history — which must never be sent. */
async function scheduledChat(store = new MemoryStore()) {
  await store.save(
    CONVERSATION,
    [
      { role: "assistant", content: "Invoked 1 times · 1 unique films · last: The Matrix (1999)", run: { runId: 1, durationMs: 900, tokens: 50, ok: true } },
      { role: "assistant", content: "Invoked 2 times · 2 unique films · last: Alien (1979)", run: { runId: 2, durationMs: 800, tokens: 50, ok: true } },
    ],
    { totalInputTokens: 100, totalOutputTokens: 10, totalCostUsd: 0, turnCount: 2 },
    { agentId: "movie-picker" }
  );
  return store;
}

const U = { inputTokens: 100, outputTokens: 10 };
const HAPPY_SCRIPT = [
  { toolUse: [{ name: "omdb__random_movie", input: {} }], usage: U },
  { toolUse: [{ name: "scheduler__record", input: { key: "tt1375666", label: "Inception (2010)" } }], usage: U },
  { toolUse: [{ name: "scheduler__aggregate", input: {} }], usage: U },
  { text: "Invoked 3 times · 2 unique films · last: Inception (2010)", usage: U },
];

function runnerWith({ script = HAPPY_SCRIPT, provider, store, toolbox, appended = [] } = {}) {
  const clock = { at: T0 };
  const fake = provider ?? new FakeProvider({ delayMs: 0, script });
  const runner = new ScheduledRunner({
    provider: fake,
    store,
    toolbox,
    now: () => (clock.at += 250),
    onAppended: (id) => appended.push(id),
  });
  return { runner, provider: fake };
}

const claimed = (prompt = PROMPT) => ({
  run: { id: 3, scheduleId: SCHEDULE_ID, status: "running" },
  schedule: { id: SCHEDULE_ID, conversationId: CONVERSATION, prompt, intervalSeconds: 15, enabled: true },
});

test("the payload is the persona and the prompt — no history", async () => {
  const store = await scheduledChat();
  const { toolbox } = stubServers();
  const { runner, provider } = runnerWith({ store, toolbox });

  await runner.run(claimed());
  const first = provider.toolCalls[0];
  assert.equal(first.system, `${agentFor("movie-picker").systemPrompt}\n\n${SCOPE_NOTE}`);
  assert.match(first.system, /scheduleId context is handled for you/);
  assert.deepEqual(first.messages, [{ role: "user", content: PROMPT }]);
  // Later rounds carry only this run's own tool exchange on top of it.
  for (const call of provider.toolCalls) {
    assert.deepEqual(call.messages[0], { role: "user", content: PROMPT });
    assert.ok(!JSON.stringify(call.messages).includes("The Matrix (1999)"), "no earlier run leaks in");
  }
});

test("only the allowlisted tools reach the model, without scheduleId in their schemas", async () => {
  const store = await scheduledChat();
  const { toolbox } = stubServers();
  const { runner, provider } = runnerWith({ store, toolbox });

  await runner.run(claimed());
  const offered = provider.toolCalls[0].tools;
  assert.deepEqual(offered.map((tool) => tool.name).sort(), [
    "omdb__get_movie", "omdb__random_movie", "omdb__search_movies", "scheduler__aggregate", "scheduler__record",
  ]);
  for (const tool of offered) {
    assert.equal("scheduleId" in (tool.inputSchema.properties ?? {}), false, tool.name);
    assert.equal((tool.inputSchema.required ?? []).includes("scheduleId"), false, tool.name);
  }
  // The rest of record's schema is intact.
  const record = offered.find((tool) => tool.name === "scheduler__record");
  assert.deepEqual(record.inputSchema.required, ["key", "label"]);
});

test("scheduleId is injected into record and aggregate, and a forged one is overruled", async () => {
  const store = await scheduledChat();
  const { toolbox, calls } = stubServers();
  const { runner } = runnerWith({
    store,
    toolbox,
    script: [
      { toolUse: [{ name: "scheduler__record", input: { key: "tt1375666", label: "Inception (2010)", scheduleId: 999 } }] },
      { toolUse: [{ name: "scheduler__aggregate", input: {} }] },
      { text: "done" },
    ],
  });

  await runner.run(claimed());
  const toScheduler = calls.filter((call) => call.server === "scheduler");
  assert.deepEqual(toScheduler, [
    { server: "scheduler", name: "record", args: { key: "tt1375666", label: "Inception (2010)", scheduleId: SCHEDULE_ID } },
    { server: "scheduler", name: "aggregate", args: { scheduleId: SCHEDULE_ID } },
  ]);
});

test("a hidden tool the model names anyway is refused and never called", async () => {
  const store = await scheduledChat();
  const { toolbox, calls } = stubServers();
  const { runner } = runnerWith({
    store,
    toolbox,
    script: [
      { toolUse: [{ name: "scheduler__delete_schedule", input: {} }] },
      ({ messages }) => {
        const result = messages.at(-1).content[0];
        assert.equal(result.isError, true);
        assert.match(result.content, /not available to this task/);
        return { text: "I could not do that." };
      },
    ],
  });

  const outcome = await runner.run(claimed());
  assert.equal(outcome.ok, true);
  assert.equal(calls.some((call) => call.name === "delete_schedule"), false);
});

test("exactly one message is appended per run, with toolCalls and run metadata", async () => {
  const store = await scheduledChat();
  const { toolbox } = stubServers();
  const appended = [];
  const { runner } = runnerWith({ store, toolbox, appended });

  const outcome = await runner.run(claimed());
  assert.deepEqual(outcome, { ok: true, output: "Invoked 3 times · 2 unique films · last: Inception (2010)", tokens: 440 });

  const record = await store.load(CONVERSATION);
  assert.equal(record.messages.length, 3);
  const message = record.messages.at(-1);
  assert.equal(message.role, "assistant");
  assert.equal(message.id, "m3");
  assert.equal(message.content, "Invoked 3 times · 2 unique films · last: Inception (2010)");
  assert.deepEqual(message.toolCalls.map((call) => `${call.server}.${call.tool}`), ["omdb.random_movie", "scheduler.record", "scheduler.aggregate"]);
  assert.ok(message.toolCalls.every((call) => call.ok));
  assert.equal(message.run.runId, 3);
  assert.equal(message.run.tokens, 440);
  assert.equal(message.run.ok, true);
  assert.equal(typeof message.run.durationMs, "number");
  assert.deepEqual(message.tokens, { input: 400, output: 40, total: 440 });

  // Usage accumulates on the conversation as usual; the cache is told.
  assert.equal(record.usage.totalInputTokens, 500);
  assert.equal(record.usage.totalOutputTokens, 50);
  assert.equal(record.usage.turnCount, 3);
  assert.deepEqual(appended, [CONVERSATION]);
  // Still the scheduled agent's chat.
  assert.equal(record.agentId, "movie-picker");
});

test("a failed model call still appends exactly one message, and reports ok:false", async () => {
  const store = await scheduledChat();
  const { toolbox } = stubServers();
  const provider = { complete: async () => { throw new LlmError("invalid x-api-key", 401); } };
  const { runner } = runnerWith({ store, toolbox, provider });

  const outcome = await runner.run(claimed());
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /invalid x-api-key/);
  const record = await store.load(CONVERSATION);
  assert.equal(record.messages.length, 3);
  assert.equal(record.messages.at(-1).run.ok, false);
  assert.match(record.messages.at(-1).content, /Run #3 failed: invalid x-api-key/);
  assert.equal(record.usage.turnCount, 2, "a failure bills nothing");
});

test("an empty prompt posts one message saying so, without calling the model", async () => {
  const store = await scheduledChat();
  const { toolbox } = stubServers();
  const provider = { complete: async () => assert.fail("the model must not be called") };
  const { runner } = runnerWith({ store, toolbox, provider });

  const outcome = await runner.run(claimed("   "));
  assert.equal(outcome.ok, false);
  const record = await store.load(CONVERSATION);
  assert.equal(record.messages.length, 3);
  assert.match(record.messages.at(-1).content, /No prompt is set/);
});

test("a deleted conversation is an orphan: nothing is written back", async () => {
  const store = new MemoryStore();
  const { toolbox } = stubServers();
  const { runner, provider } = runnerWith({ store, toolbox });
  const outcome = await runner.run(claimed());
  assert.equal(outcome.orphan, true);
  assert.equal(await store.load(CONVERSATION), null);
  assert.equal(provider.toolCalls.length, 0);
});
