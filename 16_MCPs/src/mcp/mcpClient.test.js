import assert from "node:assert/strict";
import test from "node:test";

import express from "express";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

import { mcpRoutes } from "../mcpRoutes.js";
import { MemoryMcpAuthStore } from "../store/mcpAuthStore.js";
import { McpClient } from "./mcpClient.js";

/**
 * **The MCP seam, with the SDK stubbed out.**
 *
 * The stub transport and stub client stand where the SDK's would. The one
 * piece of the SDK's behaviour worth imitating is what it does on a 401 it
 * cannot refresh: hand the authorization URL to the provider, then throw
 * `UnauthorizedError`. Everything else is ours.
 */

const AUTH_URL = "https://mcp.example.test/authorize?client_id=abc";

/** A fake world: what the "server" will say, and a log of who asked what. */
function world({ authorized = false, pages = [[{ name: "search", description: "Find pages", inputSchema: { type: "object" } }]] } = {}) {
  const state = { authorized, pages, calls: [], transports: [] };

  const createTransport = ({ kind, url, authProvider }) => {
    const transport = {
      kind,
      url,
      authProvider,
      async finishAuth(code) {
        state.calls.push(["finishAuth", code]);
        await authProvider.saveTokens({ access_token: "at-" + code, token_type: "Bearer" });
        state.authorized = true;
      },
    };
    state.transports.push(transport);
    return transport;
  };

  const createClient = () => ({
    async connect(transport) {
      state.calls.push(["connect", transport.kind]);
      if (!state.authorized) {
        // What the SDK does: mint a state, build the URL, hand it over, throw.
        const oauthState = await transport.authProvider.state();
        await transport.authProvider.redirectToAuthorization(new URL(`${AUTH_URL}&state=${oauthState}`));
        throw new UnauthorizedError();
      }
    },
    getServerVersion: () => ({ name: "Stub MCP", version: "9.9.9" }),
    async listTools(params) {
      state.calls.push(["listTools", params?.cursor ?? null]);
      if (!state.authorized) {
        throw new UnauthorizedError();
      }
      const index = params?.cursor ? Number(params.cursor) : 0;
      const next = index + 1 < state.pages.length ? String(index + 1) : undefined;
      return { tools: state.pages[index], nextCursor: next };
    },
    async close() {
      state.calls.push(["close"]);
    },
  });

  return { state, createClient, createTransport };
}

function clientIn(w, store = new MemoryMcpAuthStore()) {
  return {
    store,
    mcp: new McpClient({
      authStore: store,
      url: "https://mcp.example.test/mcp",
      createClient: w.createClient,
      createTransport: w.createTransport,
    }),
  };
}

test("connect succeeds with stored tokens and lists tools", async () => {
  const w = world({ authorized: true });
  const { mcp } = clientIn(w);

  const result = await mcp.connect();
  assert.deepEqual(result, { ok: true, serverInfo: { name: "Stub MCP", version: "9.9.9" } });
  assert.equal(mcp.connected, true);
  assert.equal(w.state.transports[0].kind, "streamable");
  assert.equal(w.state.transports[0].url.href, "https://mcp.example.test/mcp");

  const tools = await mcp.listTools();
  assert.deepEqual(tools, [{ name: "search", description: "Find pages", inputSchema: { type: "object" } }]);
  assert.equal((await mcp.status()).toolCount, 1);
});

test("a 401 comes back as the captured authorization URL, not an error", async () => {
  const w = world({ authorized: false });
  const { mcp, store } = clientIn(w);

  const result = await mcp.connect();
  const { state } = await store.load("notion");
  assert.deepEqual(result, { ok: false, authUrl: `${AUTH_URL}&state=${state}` });
  assert.equal(mcp.connected, false);
  // A 401 is an answer: no fallback to SSE asking the same question again.
  assert.deepEqual(
    w.state.calls.filter(([name]) => name === "connect"),
    [["connect", "streamable"]]
  );
});

test("a transport failure falls back to SSE", async () => {
  const w = world({ authorized: true });
  const createClient = () => {
    const client = w.createClient();
    const connect = client.connect;
    client.connect = async (transport) => {
      if (transport.kind === "streamable") throw new Error("405 Method Not Allowed");
      return connect(transport);
    };
    return client;
  };
  const mcp = new McpClient({
    authStore: new MemoryMcpAuthStore(),
    url: "https://mcp.example.test/mcp",
    createClient,
    createTransport: w.createTransport,
  });

  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal((await mcp.connect()).ok, true);
  } finally {
    console.warn = warn;
  }
  assert.equal(w.state.transports[1].kind, "sse");
  assert.equal(w.state.transports[1].url.href, "https://mcp.example.test/sse");
});

/** The routes on a real socket, torn down when the test ends. */
async function serve(t, mcp) {
  const app = express();
  app.use(express.json());
  app.use(mcpRoutes({ mcp }));
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
  const error = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = error;
  });
}

test("the callback calls finishAuth with the code, then reconnects", async (t) => {
  const w = world({ authorized: false });
  const { mcp, store } = clientIn(w);
  const http = await serve(t, mcp);

  const connect = await (await http.post("/mcp/connect")).json();
  assert.equal(connect.ok, false);
  const state = new URL(connect.authUrl).searchParams.get("state");
  assert.equal(state, (await store.load("notion")).state);

  const res = await http.get(`/mcp/oauth/callback?code=c1&state=${state}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /connected/i);

  const names = w.state.calls.map(([name, arg]) => `${name}:${arg ?? ""}`);
  assert.deepEqual(names, ["connect:streamable", "close:", "finishAuth:c1", "connect:streamable"]);
  // finishAuth ran on the transport the login started on.
  assert.equal(w.state.transports.length, 2);

  const status = await (await http.get("/mcp/status")).json();
  assert.deepEqual(status, {
    connected: true,
    server: "notion",
    toolCount: null,
    serverInfo: { name: "Stub MCP", version: "9.9.9" },
    authorized: true,
  });
  // The login is over: its state and verifier are gone, the tokens stay.
  const record = await store.load("notion");
  assert.equal(record.state, undefined);
  assert.equal(record.tokens.access_token, "at-c1");

  const tools = await (await http.get("/mcp/tools")).json();
  assert.deepEqual(tools, { ok: true, tools: [{ name: "search", description: "Find pages", inputSchema: { type: "object" } }] });
});

test("a callback with the wrong state never reaches finishAuth", async (t) => {
  quietly(t);
  const w = world({ authorized: false });
  const { mcp } = clientIn(w);
  const http = await serve(t, mcp);
  await http.post("/mcp/connect");

  const res = await http.get("/mcp/oauth/callback?code=c1&state=forged");
  assert.equal(res.status, 400);
  assert.ok(!w.state.calls.some(([name]) => name === "finishAuth"));
  assert.equal(mcp.connected, false);
});

test("?error= on the callback is a page, not a crash", async (t) => {
  const w = world({ authorized: false });
  const { mcp } = clientIn(w);
  const http = await serve(t, mcp);

  const res = await http.get("/mcp/oauth/callback?error=access_denied&error_description=%3Cb%3Enope%3C%2Fb%3E");
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /&lt;b&gt;nope&lt;\/b&gt;/);
  assert.equal(w.state.calls.length, 0);
});

test("/mcp/tools without tokens is needs-auth, not a 500", async (t) => {
  const w = world({ authorized: false });
  const { mcp } = clientIn(w);
  const http = await serve(t, mcp);

  const res = await http.get("/mcp/tools");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.authUrl, /^https:\/\/mcp\.example\.test\/authorize/);
});

test("pagination merges every page", async () => {
  const w = world({
    authorized: true,
    pages: [[{ name: "a" }, { name: "b" }], [{ name: "c" }], [{ name: "d" }]],
  });
  const { mcp } = clientIn(w);
  await mcp.connect();

  const tools = await mcp.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["a", "b", "c", "d"]);
  assert.deepEqual(
    w.state.calls.filter(([name]) => name === "listTools"),
    [["listTools", null], ["listTools", "1"], ["listTools", "2"]]
  );
});

test("a token that dies mid-session goes back to needs-auth", async () => {
  const w = world({ authorized: true });
  const { mcp } = clientIn(w);
  await mcp.connect();

  w.state.authorized = false;
  await assert.rejects(mcp.listTools(), UnauthorizedError);
  assert.equal(mcp.connected, false);
});

test("disconnect closes the client and wipes the store", async (t) => {
  const w = world({ authorized: true });
  const { mcp, store } = clientIn(w);
  const http = await serve(t, mcp);
  await store.update("notion", (record) => {
    record.tokens = { access_token: "secret", token_type: "Bearer" };
    record.clientInformation = { client_id: "abc" };
  });
  await mcp.connect();

  assert.deepEqual(await (await http.post("/mcp/disconnect")).json(), { ok: true });
  assert.equal(mcp.connected, false);
  assert.ok(w.state.calls.some(([name]) => name === "close"));
  assert.deepEqual(await store.load("notion"), { server: "notion", updatedAt: null });
  assert.equal((await mcp.status()).authorized, false);
});
