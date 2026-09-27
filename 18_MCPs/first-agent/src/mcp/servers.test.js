import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { mcpRoutes } from "../mcpRoutes.js";
import { MemoryMcpAuthStore } from "../store/mcpAuthStore.js";
import { McpRegistry, OMDB_MCP_URL, SCHEDULER_MCP_URL, mcpServerDefinitions } from "./servers.js";
import { McpToolbox, prefixedName } from "./toolbox.js";

/**
 * **The registry, the per-server routes and the toolbox — for a server with no
 * login.** The SDK is stubbed the same way `mcpClient.test.js` stubs it; the
 * one new thing a stub has to do is be *down*, which a real local server
 * sometimes is.
 */

const OMDB = { id: "omdb", name: "OMDb", url: "http://127.0.0.1:3999/mcp", auth: "none" };
const NOTION = { id: "notion", name: "Notion", url: "https://mcp.example.test/mcp", auth: "oauth" };

const TOOLS = [
  { name: "search_movies", description: "Search", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "get_movie", description: "One movie", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
];

function refused() {
  return Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
}

/** A local server that can be up or down, and answers tools from `handlers`. */
function localWorld({ up = true, handlers = {} } = {}) {
  const state = { up, calls: [], transports: [] };
  const createTransport = (options) => {
    state.transports.push(options);
    return { ...options };
  };
  const createClient = () => ({
    async connect(transport) {
      state.calls.push(["connect", transport.kind]);
      if (!state.up) throw refused();
    },
    getServerVersion: () => ({ name: "omdb-mcp", version: "1.0.0" }),
    async listTools() {
      state.calls.push(["listTools"]);
      if (!state.up) throw refused();
      return { tools: TOOLS };
    },
    async callTool({ name, arguments: args }) {
      state.calls.push(["callTool", name, args]);
      if (!state.up) throw refused();
      const handler = handlers[name];
      if (!handler) return { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
      return handler(args);
    },
    async close() {
      state.calls.push(["close"]);
    },
  });
  return { state, createClient, createTransport };
}

function registryWith(w, servers = [OMDB]) {
  return new McpRegistry({ servers, authStore: new MemoryMcpAuthStore(), createClient: w.createClient, createTransport: w.createTransport });
}

async function serve(t, registry) {
  const app = express();
  app.use(express.json());
  app.use(mcpRoutes({ registry }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (path) => fetch(base + path),
    post: (path) => fetch(base + path, { method: "POST" }),
  };
}

function quietly(t) {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  t.after(() => {
    console.warn = warn;
    console.error = error;
  });
}

// ---- the registry ----------------------------------------------------------

test("the default registry has Notion (oauth), OMDb and Scheduler (none), with URL overrides", () => {
  const defaults = mcpServerDefinitions({});
  assert.deepEqual(
    defaults.map(({ id, name, auth }) => ({ id, name, auth })),
    [
      { id: "notion", name: "Notion", auth: "oauth" },
      { id: "omdb", name: "OMDb", auth: "none" },
      { id: "scheduler", name: "Scheduler", auth: "none" },
    ]
  );
  assert.equal(defaults[1].url, OMDB_MCP_URL);
  assert.equal(defaults[2].url, SCHEDULER_MCP_URL);
  assert.equal(SCHEDULER_MCP_URL, "http://127.0.0.1:3002/mcp");
  assert.equal(mcpServerDefinitions({ OMDB_MCP_URL: "http://127.0.0.1:4000/mcp" })[1].url, "http://127.0.0.1:4000/mcp");
  assert.equal(mcpServerDefinitions({ SCHEDULER_MCP_URL: "http://127.0.0.1:4002/mcp" })[2].url, "http://127.0.0.1:4002/mcp");
});

test("a registry refuses the same id twice", () => {
  assert.throws(() => new McpRegistry({ servers: [OMDB, OMDB] }), /registered twice/);
});

test("a server with auth none connects with no auth provider and no SSE fallback", async () => {
  const w = localWorld();
  const mcp = registryWith(w).get("omdb");
  assert.deepEqual(await mcp.connect(), { ok: true, serverInfo: { name: "omdb-mcp", version: "1.0.0" } });
  assert.equal(w.state.transports.length, 1);
  assert.equal(w.state.transports[0].kind, "streamable");
  assert.equal("authProvider" in w.state.transports[0], false);
  assert.equal((await mcp.status()).authorized, true);
});

// ---- routes ----------------------------------------------------------------

test("/mcp/servers lists every registered server, and an unknown id is a 404", async (t) => {
  const http = await serve(t, registryWith(localWorld(), [NOTION, OMDB]));
  assert.deepEqual(await (await http.get("/mcp/servers")).json(), {
    servers: [
      { id: "notion", name: "Notion", auth: "oauth" },
      { id: "omdb", name: "OMDb", auth: "none" },
    ],
  });
  assert.equal((await http.get("/mcp/nope/status")).status, 404);
  assert.equal((await http.post("/mcp/nope/connect")).status, 404);
});

test("auth none: connect, status, tools and disconnect — and never an authUrl", async (t) => {
  const w = localWorld();
  const http = await serve(t, registryWith(w));

  const connect = await (await http.post("/mcp/omdb/connect")).json();
  assert.deepEqual(connect, { ok: true, connected: true, serverInfo: { name: "omdb-mcp", version: "1.0.0" } });
  assert.equal("authUrl" in connect, false);

  const status = await (await http.get("/mcp/omdb/status")).json();
  assert.deepEqual(status, {
    connected: true,
    server: "omdb",
    toolCount: null,
    serverInfo: { name: "omdb-mcp", version: "1.0.0" },
    authorized: true,
    name: "OMDb",
    auth: "none",
  });

  const tools = await (await http.get("/mcp/omdb/tools")).json();
  assert.equal(tools.ok, true);
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["search_movies", "get_movie"]);

  assert.deepEqual(await (await http.post("/mcp/omdb/disconnect")).json(), { ok: true });
  assert.equal((await (await http.get("/mcp/omdb/status")).json()).connected, false);
});

test("a server that is down is connected:false with the reason, not a throw", async (t) => {
  quietly(t);
  const w = localWorld({ up: false });
  const http = await serve(t, registryWith(w));

  const res = await http.post("/mcp/omdb/connect");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.connected, false);
  assert.equal("authUrl" in body, false);
  assert.match(body.error, /Could not reach OMDb at http:\/\/127\.0\.0\.1:3999\/mcp: fetch failed \(ECONNREFUSED\)/);

  const status = await (await http.get("/mcp/omdb/status")).json();
  assert.equal(status.connected, false);
  assert.match(status.error, /ECONNREFUSED/);

  const tools = await (await http.get("/mcp/omdb/tools")).json();
  assert.equal(tools.ok, false);
  assert.equal(tools.connected, false);
  assert.deepEqual(tools.tools, []);

  // It comes back up: the next connect works and the error is gone.
  w.state.up = true;
  assert.equal((await (await http.post("/mcp/omdb/connect")).json()).ok, true);
  assert.equal("error" in (await (await http.get("/mcp/omdb/status")).json()), false);
});

// ---- the toolbox -----------------------------------------------------------

test("tools are prefixed with their server, and a call goes back to the right one", async () => {
  const w = localWorld({
    handlers: { get_movie: (args) => ({ content: [{ type: "text", text: JSON.stringify({ title: args.title, runtimeMinutes: 148 }) }] }) },
  });
  const toolbox = new McpToolbox({ registry: registryWith(w) });

  const { tools, unavailable } = await toolbox.toolsFor(["omdb"]);
  assert.deepEqual(unavailable, []);
  assert.deepEqual(tools.map((tool) => tool.name), ["omdb__search_movies", "omdb__get_movie"]);
  assert.equal(tools[1].inputSchema.properties.title.type, "string");

  const call = await toolbox.call("omdb__get_movie", { title: "Inception" });
  assert.equal(call.ok, true);
  assert.equal(call.server, "omdb");
  assert.equal(call.tool, "get_movie");
  assert.equal(JSON.parse(call.text).runtimeMinutes, 148);
  assert.deepEqual(w.state.calls.find(([name]) => name === "callTool"), ["callTool", "get_movie", { title: "Inception" }]);
});

test("a tool's isError and a dead server are both ok:false, never a throw", async () => {
  const w = localWorld({ handlers: { get_movie: () => ({ content: [{ type: "text", text: "OMDb: Movie not found!" }], isError: true }) } });
  const toolbox = new McpToolbox({ registry: registryWith(w) });
  await toolbox.toolsFor(["omdb"]);

  const notFound = await toolbox.call("omdb__get_movie", { title: "Nope" });
  assert.deepEqual([notFound.ok, notFound.text], [false, "OMDb: Movie not found!"]);

  w.state.up = false;
  const dead = await toolbox.call("omdb__get_movie", { title: "Nope" });
  assert.equal(dead.ok, false);
  assert.match(dead.text, /Tool call failed: fetch failed \(ECONNREFUSED\)/);
});

test("a server that is down is listed as unavailable, with no tools", async (t) => {
  quietly(t);
  const toolbox = new McpToolbox({ registry: registryWith(localWorld({ up: false })) });
  const { tools, unavailable } = await toolbox.toolsFor(["omdb", "ghost"]);
  assert.deepEqual(tools, []);
  assert.equal(unavailable[0].server, "omdb");
  assert.match(unavailable[0].error, /ECONNREFUSED/);
  assert.deepEqual(unavailable[1], { server: "ghost", error: "not a registered MCP server" });
});

test("prefixed names always satisfy the provider's tool-name rule", () => {
  assert.equal(prefixedName("omdb", "get_movie"), "omdb__get_movie");
  assert.match(prefixedName("my.server", "a tool/with:odd chars".repeat(5)), /^[a-zA-Z0-9_-]{1,64}$/);
});
