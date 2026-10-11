import assert from "node:assert/strict";
import test from "node:test";

import { Agent, MAX_TOOL_ROUNDS, TOOL_ROUNDS_FALLBACK } from "./agent.js";
import { exchangeStarts, takeLastExchanges, windowStart } from "./context/boundaries.js";
import { FakeProvider } from "./llm/anthropic.js";
import { McpRegistry } from "./mcp/servers.js";
import { McpToolbox } from "./mcp/toolbox.js";
import { MemoryInvariantStore } from "./store/invariantStore.js";
import { MemoryMcpAuthStore } from "./store/mcpAuthStore.js";
import { MemoryStore } from "./store/memoryStore.js";
import { MemoryProfileStore } from "./store/profileStore.js";

/**
 * **The tool loop, offline.** The model is a scripted `FakeProvider`; the MCP
 * server is a stub SDK client behind a real registry and toolbox, so the only
 * thing not real is the network.
 */

const SESSION = "22222222-2222-4222-8222-222222222222";

const MOVIES = {
  tt1375666: { title: "Inception", year: "2010", runtimeMinutes: 148, imdbRating: 8.8, imdbId: "tt1375666" },
  tt0133093: { title: "The Matrix", year: "1999", runtimeMinutes: 136, imdbRating: 8.7, imdbId: "tt0133093" },
};
const byTitle = (title) => Object.values(MOVIES).find((movie) => movie.title.toLowerCase() === String(title).toLowerCase());
const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });

const HANDLERS = {
  search_movies: ({ query }) => {
    const hits = Object.values(MOVIES).filter((movie) => movie.title.toLowerCase().includes(String(query).toLowerCase()));
    return hits.length ? json({ results: hits.map(({ title, year, imdbId }) => ({ title, year, imdbId, type: "movie" })) }) : { content: [{ type: "text", text: "OMDb: Movie not found!" }], isError: true };
  },
  get_movie: ({ imdbId, title }) => {
    const movie = imdbId ? MOVIES[imdbId] : byTitle(title);
    return movie ? json(movie) : { content: [{ type: "text", text: "OMDb: Movie not found!" }], isError: true };
  },
};

function stubMcp({ up = true } = {}) {
  const calls = [];
  const registry = new McpRegistry({
    servers: [{ id: "omdb", name: "OMDb", url: "http://127.0.0.1:3999/mcp", auth: "none" }],
    authStore: new MemoryMcpAuthStore(),
    createTransport: (options) => ({ ...options }),
    createClient: () => ({
      async connect() {
        if (!up) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      },
      getServerVersion: () => ({ name: "omdb-mcp", version: "1.0.0" }),
      async listTools() {
        return {
          tools: [
            { name: "search_movies", description: "Search by title", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
            { name: "get_movie", description: "One title", inputSchema: { type: "object", properties: { imdbId: { type: "string" }, title: { type: "string" } } } },
          ],
        };
      },
      async callTool({ name, arguments: args }) {
        calls.push({ name, args });
        return HANDLERS[name](args);
      },
      async close() {},
    }),
  });
  return { toolbox: new McpToolbox({ registry }), calls };
}

function movieBuff({ script, toolbox, agentId = "movie-buff", store = new MemoryStore() }) {
  const provider = new FakeProvider({ delayMs: 0, script });
  const agent = new Agent({
    provider,
    store,
    sessionId: SESSION,
    agentId,
    toolbox,
    strategyOptions: { profileStore: new MemoryProfileStore(), invariantStore: new MemoryInvariantStore() },
  });
  return { agent, provider, store };
}

const U = (n) => ({ inputTokens: 100 * n, outputTokens: 10 * n });

test("a single tool call: tool_use → tool_result → final text", async () => {
  const { toolbox, calls } = stubMcp();
  const { agent, provider } = movieBuff({
    toolbox,
    script: [
      { toolUse: [{ name: "omdb__get_movie", input: { title: "Inception" } }], usage: U(1) },
      ({ messages }) => {
        const result = messages.at(-1).content[0];
        return { text: `Inception runs ${JSON.parse(result.content).runtimeMinutes} minutes.`, usage: U(2) };
      },
    ],
  });

  const { text, meta } = await agent.run("How long is Inception?");
  assert.equal(text, "Inception runs 148 minutes.");
  assert.deepEqual(calls, [{ name: "get_movie", args: { title: "Inception" } }]);

  // The tools went on the wire prefixed, and the second call carried the pair.
  assert.deepEqual(provider.toolCalls[0].tools.map((tool) => tool.name), ["omdb__search_movies", "omdb__get_movie"]);
  const [, assistant, user] = provider.toolCalls[1].messages;
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content[0].type, "tool_use");
  assert.equal(user.role, "user");
  assert.equal(user.content[0].type, "tool_result");
  assert.equal(user.content[0].toolUseId, assistant.content[0].id);
  assert.equal(user.content[0].isError, undefined);

  assert.equal(meta.toolRounds, 1);
  assert.equal(meta.toolCalls.length, 1);
  assert.equal(meta.toolCalls[0].server, "omdb");
  assert.equal(meta.toolCalls[0].tool, "get_movie");
});

test("a chained search → get_movie, and every round's tokens are summed", async () => {
  const { toolbox, calls } = stubMcp();
  const { agent, store } = movieBuff({
    toolbox,
    script: [
      { toolUse: [{ name: "omdb__search_movies", input: { query: "matrix" } }], usage: U(1) },
      ({ messages }) => {
        const { results } = JSON.parse(messages.at(-1).content[0].content);
        return { toolUse: [{ name: "omdb__get_movie", input: { imdbId: results[0].imdbId } }], usage: U(2) };
      },
      { text: "The Matrix is 136 minutes, rated 8.7.", usage: U(3) },
    ],
  });

  const { text, meta } = await agent.run("How long is The Matrix?");
  assert.equal(text, "The Matrix is 136 minutes, rated 8.7.");
  assert.deepEqual(calls.map((call) => call.name), ["search_movies", "get_movie"]);
  assert.deepEqual(calls[1].args, { imdbId: "tt0133093" });
  assert.equal(meta.toolRounds, 2);

  // 100+200+300 in, 10+20+30 out: three model calls, one turn.
  assert.equal(meta.tokens.input, 600);
  assert.equal(meta.tokens.output, 60);
  assert.equal(meta.tokens.total, 660);
  assert.equal(agent.usage.totalInputTokens, 600);
  assert.equal(agent.usage.totalOutputTokens, 60);

  const saved = (await store.load(SESSION)).messages.at(-1);
  assert.equal(saved.tokens.input, 600);
});

test("a tool that fails goes back to the model with is_error, and the model can recover", async () => {
  const { toolbox } = stubMcp();
  const { agent, provider } = movieBuff({
    toolbox,
    script: [
      { toolUse: [{ name: "omdb__get_movie", input: { title: "Incepshun" } }] },
      ({ messages }) => {
        const result = messages.at(-1).content[0];
        assert.equal(result.isError, true);
        assert.equal(result.content, "OMDb: Movie not found!");
        return { toolUse: [{ name: "omdb__search_movies", input: { query: "incep" } }] };
      },
      { text: "Did you mean Inception (2010)?" },
    ],
  });

  const { text, meta } = await agent.run("How long is Incepshun?");
  assert.equal(text, "Did you mean Inception (2010)?");
  assert.deepEqual(meta.toolCalls.map((call) => call.ok), [false, true]);
  assert.equal(meta.toolCalls[0].resultPreview, "OMDb: Movie not found!");
  assert.equal(provider.toolCalls.length, 3);
});

test("the loop stops after the round cap with a clear fallback", async () => {
  const { toolbox, calls } = stubMcp();
  const forever = () => ({ toolUse: [{ name: "omdb__search_movies", input: { query: "matrix" } }], usage: U(1) });
  const { agent, provider, store } = movieBuff({ toolbox, script: Array.from({ length: 20 }, () => forever) });

  const { text, meta } = await agent.run("Loop, please?");
  assert.equal(text, TOOL_ROUNDS_FALLBACK);
  assert.equal(calls.length, MAX_TOOL_ROUNDS);
  // The first call, then one after each round.
  assert.equal(provider.toolCalls.length, MAX_TOOL_ROUNDS + 1);
  assert.equal(meta.toolRounds, MAX_TOOL_ROUNDS);
  assert.equal(meta.toolRoundsExceeded, true);
  assert.equal(meta.tokens.input, 100 * (MAX_TOOL_ROUNDS + 1));

  const saved = (await store.load(SESSION)).messages.at(-1);
  assert.equal(saved.content, TOOL_ROUNDS_FALLBACK);
  assert.equal(saved.toolRoundsExceeded, true);
  assert.equal(saved.toolCalls.length, MAX_TOOL_ROUNDS);
});

test("toolCalls are saved on the reply; the record never holds tool blocks", async () => {
  const { toolbox } = stubMcp();
  const { agent, store } = movieBuff({
    toolbox,
    script: [
      { toolUse: [{ name: "omdb__get_movie", input: { title: "Inception" } }, { name: "omdb__get_movie", input: { title: "The Matrix" } }] },
      { text: "Inception is longer (148 vs 136 min) and rated higher (8.8 vs 8.7)." },
      { toolUse: [{ name: "omdb__get_movie", input: { imdbId: "tt0133093" } }] },
      { text: "The Matrix came out in 1999." },
    ],
  });

  await agent.run("Is Inception longer than The Matrix, and which is rated higher?");
  await agent.run("And when did The Matrix come out?");

  const { messages } = await store.load(SESSION);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  for (const message of messages) assert.equal(typeof message.content, "string");

  const first = messages[1];
  assert.equal(first.toolCalls.length, 2);
  for (const call of first.toolCalls) {
    assert.deepEqual(Object.keys(call).sort(), ["input", "ms", "ok", "resultPreview", "server", "tool"]);
    assert.equal(call.server, "omdb");
    assert.equal(call.tool, "get_movie");
    assert.equal(call.ok, true);
    assert.equal(typeof call.ms, "number");
  }
  assert.deepEqual(first.toolCalls.map((call) => call.input), [{ title: "Inception" }, { title: "The Matrix" }]);
  assert.equal(JSON.parse(first.toolCalls[0].resultPreview).runtimeMinutes, 148);

  // The boundary rules hold on a history with tool turns in it.
  assert.deepEqual(exchangeStarts(messages), [0, 2]);
  assert.equal(windowStart(messages, 1), 2);
  const { messages: wire } = takeLastExchanges(messages, 1);
  assert.equal(wire[0].role, "user");
  assert.deepEqual(Object.keys(wire[1]), ["role", "content"]);
  assert.equal(typeof wire[1].content, "string");
});

test("the tool round trip does not reach the next turn's payload", async () => {
  const { toolbox } = stubMcp();
  const { agent, provider } = movieBuff({
    toolbox,
    script: [
      { toolUse: [{ name: "omdb__get_movie", input: { title: "Inception" } }] },
      { text: "148 minutes." },
      { text: "You're welcome." },
    ],
  });

  await agent.run("How long is Inception?");
  await agent.run("Thanks!");
  const next = provider.toolCalls[2].messages;
  assert.ok(next.every((message) => typeof message.content === "string"));
  assert.equal(next[0].role, "user");
  assert.equal(next.at(-1).content, "Thanks!");
});

test("an agent without mcpServers is sent no tools and never touches the toolbox", async () => {
  let touched = false;
  const toolbox = {
    async toolsFor() {
      touched = true;
      return { tools: [], unavailable: [] };
    },
    async call() {
      touched = true;
    },
  };
  const seen = [];
  const provider = new FakeProvider({ delayMs: 0 });
  const complete = provider.complete.bind(provider);
  provider.complete = (params) => {
    seen.push(params);
    return complete(params);
  };
  const agent = new Agent({
    provider,
    store: new MemoryStore(),
    sessionId: SESSION,
    agentId: "first-agent",
    toolbox,
    strategyOptions: { profileStore: new MemoryProfileStore(), invariantStore: new MemoryInvariantStore() },
  });

  const { meta } = await agent.run("hello");
  assert.equal(touched, false);
  assert.ok(seen.every((params) => !("tools" in params)));
  assert.deepEqual(meta.toolCalls, []);
  assert.equal("toolCalls" in agent.history().at(-1), false);
});

test("a server that is down still gets an answer, without tools, and says why", async (t) => {
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = warn;
  });
  const { toolbox } = stubMcp({ up: false });
  const { agent, provider } = movieBuff({ toolbox, script: [{ text: "unused" }] });

  const { text, meta } = await agent.run("How long is Inception?");
  assert.match(text, /fake reply/);
  assert.equal(provider.toolCalls.length, 0);
  assert.equal(meta.toolsUnavailable[0].server, "omdb");
  assert.match(meta.toolsUnavailable[0].error, /ECONNREFUSED/);
});

test("an empty conversation takes the agent a later request names; one with messages keeps its own", async () => {
  const { toolbox } = stubMcp();
  const provider = new FakeProvider({ delayMs: 0, script: [{ text: "Hi from the movie buff." }] });
  const store = new MemoryStore();
  const strategyOptions = { profileStore: new MemoryProfileStore(), invariantStore: new MemoryInvariantStore() };

  // What the page does on "switch agent": load the new chat's panel, naming no
  // agent, then send the first message naming one.
  const agent = await Agent.load({ provider, store, sessionId: SESSION, toolbox, strategyOptions });
  assert.equal(agent.agentId, "first-agent");
  assert.equal(agent.adoptAgent("movie-buff"), true);
  assert.equal(agent.agentId, "movie-buff");

  await agent.run("hello");
  assert.equal(provider.toolCalls.length, 1, "the movie buff was offered its tools");
  assert.equal((await store.load(SESSION)).agentId, "movie-buff");

  // Once something has been said, the record wins.
  assert.equal(agent.adoptAgent("first-agent"), false);
  assert.equal(agent.adoptAgent("no-such-agent"), false);
  assert.equal(agent.agentId, "movie-buff");
});
