import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../store/memoryStore.js";
import { fakeOllama } from "../testing/ollamaFake.js";
import { createHostedApp } from "./app.js";
import { decodeWord, identityOf, userDirName } from "./identity.js";
import { QueueError, RequestQueue } from "./queue.js";
import { RateLimiter } from "./rateLimit.js";
import { rateLimitOf } from "./config.js";

/**
 * **Day 30: the hosted server, offline.** Ollama is a fake `fetch` that answers
 * each JSON-schema call by its schema (route, submit_answer, clarification),
 * and can hold a call until the test lets it go; retrieval and rerank are
 * fakes; each user's chats are a MemoryStore.
 */

const CHUNKS = [
  { score: 0.8, source: "kb/cmp.html", section: "iOS", title: "CMP 1.8", chunk_id: "cmp:3", text: "Compose Multiplatform for iOS is stable as of version 1.8.0. Teams can now ship shared UI to production." },
];
const ROUTE_SEARCH = { intent: "search", standalone_question: "Is Compose Multiplatform for iOS stable?", queries: ["Compose Multiplatform iOS stable"], reply: "", memory_patch: [] };
const GOOD_ANSWER = {
  status: "answered",
  answer: "Compose Multiplatform for iOS is stable since 1.8.0 [c1].",
  citations: [{ id: "c1", chunk_id: "cmp:3", quote: "Compose Multiplatform for iOS is stable as of version 1.8.0." }],
  clarifying_question: "",
};
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const kind = (body) => {
  const props = body.format?.properties ?? {};
  if ("intent" in props) return "route";
  if ("citations" in props) return "answer";
  if ("clarifying_question" in props) return "clarify";
  return "text";
};

/**
 * A fake Ollama that always has an answer, and `hold()`s every /api/chat call
 * until `release()` while held — honouring the request's abort signal, as a
 * real HTTP call does.
 */
function scriptedOllama() {
  const inner = fakeOllama(
    Array.from({ length: 500 }, () => (body) => {
      const k = kind(body);
      return k === "route" ? JSON.stringify(ROUTE_SEARCH) : k === "answer" ? JSON.stringify(GOOD_ANSWER) : k === "clarify" ? JSON.stringify({ clarifying_question: "Which one?" }) : "OK";
    }),
    { installed: ["qwen3.5:9b"], loaded: ["qwen3.5:9b"] },
  );
  let gate = null;
  const waiting = [];
  const aborted = [];
  const fetch = async (url, init = {}) => {
    if (new URL(url).pathname === "/api/chat" && gate) {
      await new Promise((resolve, reject) => {
        const entry = { resolve };
        waiting.push(entry);
        init.signal?.addEventListener("abort", () => (aborted.push(Date.now()), reject(init.signal.reason ?? new Error("aborted"))), { once: true });
        gate.then(resolve);
      });
    }
    return inner.fetch(url, init);
  };
  return {
    fetch,
    aborted,
    chats: inner.chats,
    calls: inner.calls,
    hold() {
      let open;
      gate = new Promise((resolve) => (open = resolve));
      gate.open = open;
    },
    release() {
      gate?.open();
      gate = null;
    },
    /** Resolves once `n` /api/chat calls are being held. */
    async held(n = 1) {
      while (waiting.length < n) await new Promise((r) => setTimeout(r, 5));
    },
  };
}

async function serve(t, { env = {}, ollama = scriptedOllama() } = {}) {
  const stores = new Map();
  const hosted = createHostedApp({
    env: { HOSTED_DATA_DIR: "/nonexistent", ...env },
    fetch: ollama.fetch,
    storeFor: (user) => {
      if (!stores.has(user.login)) stores.set(user.login, new MemoryStore());
      return stores.get(user.login);
    },
    ragDeps: { search: async () => CHUNKS.map((c) => ({ ...c })), rerankScores: async (_q, p) => p.map(() => 0.9), ready: () => true, rerankerReady: () => true },
    log: () => {},
  });
  const server = hosted.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { body, user, headers = {}, signal } = {}) => {
    const res = await fetch(base + url, {
      method,
      signal,
      headers: { "content-type": "application/json", ...(user ? { "Tailscale-User-Login": user, "Tailscale-User-Name": user.split("@")[0] } : {}), ...headers },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON (the page, a script, an NDJSON stream)
    }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  return { hosted, ollama, stores, call, base };
}

// ---- what is mounted --------------------------------------------------------------

test("hosted: only the page, the user's Knowledge chats, /api/* and /health are mounted; everything else is 404", async (t) => {
  const { call } = await serve(t);
  const page = await call("GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.text, /<html data-hosted="1"/);
  for (const url of ["/markdown.js", "/pricing.js", "/vendor/marked.js", "/vendor/purify.js"]) assert.equal((await call("GET", url)).status, 200, url);
  assert.equal((await call("GET", "/health")).status, 200);
  assert.equal((await call("GET", "/api/me")).status, 200);
  assert.equal((await call("GET", "/conversations")).status, 200);
  assert.equal((await call("GET", `/conversations/${A}`)).status, 200);

  const excluded = [
    ["GET", "/rag-report"],
    ["GET", "/rag-report.html"],
    ["GET", "/rag-report/data"],
    ["GET", "/rag/status"],
    ["POST", "/rag/compare"],
    ["PUT", `/conversations/${A}/rag`],
    ["PUT", `/conversations/${A}/llm`],
    ["GET", `/conversations/${A}/usage`],
    ["POST", `/conversations/${A}/fork`],
    ["GET", `/conversations/${A}/pipeline`],
    ["POST", `/conversations/${A}/pipeline/run`],
    ["POST", `/conversations/${A}/pipeline/plan`],
    ["GET", `/conversations/${A}/runs`],
    ["POST", `/conversations/${A}/memory/finish-task`],
    ["GET", "/mcp/servers"],
    ["POST", "/mcp/notion/connect"],
    ["GET", "/mcp/oauth/callback"],
    ["GET", "/local/status"],
    ["GET", "/agents"],
    ["GET", "/profiles"],
    ["GET", "/projects"],
    ["POST", "/reset"],
    ["GET", "/index.html"],
    ["GET", "/vendor/anything.js"],
  ];
  for (const [method, url] of excluded) {
    const res = await call(method, url, { body: method === "GET" ? undefined : {} });
    assert.equal(res.status, 404, `${method} ${url}`);
  }
});

test("hosted: the chat's model, RAG and rerank are fixed, whatever the request says; qwen at num_ctx 8192, v1, output ≤ 1024", async (t) => {
  const { call, ollama, stores } = await serve(t);
  const res = await call("POST", "/chat", { body: { message: "Is CMP for iOS stable?", sessionId: A, agent: "first-agent", ragMode: "plain", rerank: false, llm: "claude" } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.meta.rag.mode, "rag");
  assert.equal(res.body.meta.rag.label, "rag+rerank");
  assert.equal(res.body.meta.rag.status, "answered");
  assert.equal(res.body.meta.provider, "local");
  for (const body of ollama.chats()) {
    assert.equal(body.model, "qwen3.5:9b");
    assert.equal(body.options.num_ctx, 8192);
    assert.ok(body.options.num_predict <= 1024);
    assert.equal(body.keep_alive, "60m");
  }
  const record = await stores.get("local").load(A);
  assert.equal(record.agentId, "knowledge");
  assert.equal(record.llm, "local:qwen3.5:9b");
});

test("hosted: a routed (chat) reply names qwen, never a Claude model", async (t) => {
  const inner = fakeOllama(
    Array.from({ length: 5 }, () => (body) => (kind(body) === "route" ? JSON.stringify({ intent: "chat", standalone_question: "", queries: [], reply: "Hi! Ask me about Kotlin.", memory_patch: [] }) : "OK")),
    { installed: ["qwen3.5:9b"] },
  );
  const { call } = await serve(t, { ollama: { fetch: inner.fetch, chats: inner.chats } });
  const res = await call("POST", "/chat", { body: { message: "hello", sessionId: A } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.meta.stopReason, "routed");
  assert.doesNotMatch(JSON.stringify(res.body), /claude/i);
  assert.equal(res.body.meta.model, "qwen3.5:9b");
});

test("hosted page: the Model switch can't be unhidden, and the Knowledge panel starts collapsed", async (t) => {
  const { call } = await serve(t);
  const page = (await call("GET", "/")).text;
  // The app's own rule that shows the switch, and the hosted one that must outrank it.
  assert.match(page, /body\[data-local="1"\]:not\(\[data-kind="scheduled"\]\) \.local-only \{ display: flex !important; \}/);
  assert.match(page, /html:root\[data-hosted\] body \.local-only,/);
  assert.match(page, /document\.body\.dataset\.local = !HOSTED && agentIsLocal\(\)/);
  assert.match(page, /let openByDefault = !HOSTED;/);
});

// ---- no MCP, no Claude ---------------------------------------------------------

test("hosted: no MCP client and no Anthropic code is loaded by the hosted server's module graph", () => {
  const script = `
    import { registerHooks } from "node:module";
    const seen = [];
    registerHooks({ resolve(specifier, context, next) { const r = next(specifier, context); seen.push(r.url); return r; } });
    const { createHostedApp } = await import("./src/hosted/app.js");
    createHostedApp({ env: {}, log: () => {} });
    console.log(JSON.stringify(seen));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: path.join(import.meta.dirname, "..", ".."), encoding: "utf8" });
  const seen = JSON.parse(out.trim().split("\n").at(-1));
  assert.ok(seen.some((u) => u.endsWith("/src/hosted/app.js")));
  assert.deepEqual(seen.filter((u) => /\/src\/mcp\/|@modelcontextprotocol|\/src\/llm\/anthropic\.js|\/src\/scheduler\/|\/src\/pipeline\//.test(u)), []);
});

test("hosted: ANTHROPIC_API_KEY is ignored and Claude is never called; nothing goes to a non-local host", async (t) => {
  const realFetch = globalThis.fetch;
  const remote = [];
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) remote.push(url.href);
    return realFetch(input, init);
  };
  t.after(() => (globalThis.fetch = realFetch));
  const { hosted, call } = await serve(t, { env: { ANTHROPIC_API_KEY: "sk-ant-test" } });
  assert.equal(hosted.llms.claudeAvailable, false);
  assert.equal((await call("POST", "/chat", { body: { message: "Is CMP for iOS stable?", sessionId: A } })).status, 200);
  assert.equal((await call("POST", "/api/ask", { body: { question: "Is CMP for iOS stable?" } })).status, 200);
  assert.equal(hosted.claude.calls, 0);
  assert.deepEqual(remote, []);
});

// ---- identity -----------------------------------------------------------------

test("identity: the Tailscale headers, decoded; no header is the user `local`", () => {
  const req = (headers) => ({ get: (name) => headers[name.toLowerCase()] });
  assert.deepEqual(identityOf(req({})), { login: "local", name: "local", pic: null, tailnet: false });
  const alice = identityOf(req({ "tailscale-user-login": "Alice@Example.com", "tailscale-user-name": "=?utf-8?q?Ren=C3=A9e_Alice?=", "tailscale-user-profile-pic": "https://x/p.png" }));
  assert.deepEqual(alice, { login: "alice@example.com", name: "Renée Alice", pic: "https://x/p.png", tailnet: true });
  assert.equal(decodeWord("=?utf-8?b?UmVuw6ll?="), "Renée");
  assert.equal(decodeWord("plain"), "plain");
  assert.notEqual(userDirName("a@b"), userDirName("a_b"));
  assert.doesNotMatch(userDirName("../../etc"), /\.\.|\//);
});

test("identity: conversations are scoped to the login — another user can neither list, read nor delete them", async (t) => {
  const { call, stores } = await serve(t);
  const me = await call("GET", "/api/me", { user: "alice@github" });
  assert.equal(me.body.user.login, "alice@github");
  assert.equal(me.body.user.name, "alice");
  assert.equal((await call("GET", "/api/me")).body.user.login, "local");

  assert.equal((await call("POST", "/chat", { user: "alice@github", body: { message: "Is CMP for iOS stable?", sessionId: A } })).status, 200);
  assert.deepEqual((await call("GET", "/conversations", { user: "alice@github" })).body.map((c) => c.id), [A]);
  assert.deepEqual((await call("GET", "/conversations", { user: "bob@github" })).body, []);
  assert.deepEqual((await call("GET", "/conversations")).body, [], "local sees nothing of alice's");
  const peek = await call("GET", `/conversations/${A}`, { user: "bob@github" });
  assert.equal(peek.status, 200);
  assert.deepEqual(peek.body.messages, []);
  assert.equal((await call("DELETE", `/conversations/${A}`, { user: "bob@github" })).status, 200);
  assert.equal((await call("DELETE", `/conversations/${A}/task-memory`, { user: "bob@github" })).body.saved, false);
  assert.equal((await stores.get("alice@github").load(A)).messages.length, 2, "alice's chat is untouched");
  assert.equal((await call("GET", `/conversations/${A}`, { user: "alice@github" })).body.messages.length, 2);

  const created = await call("POST", "/conversations", { user: "bob@github" });
  assert.equal(created.status, 201);
  assert.deepEqual((await call("GET", "/conversations", { user: "bob@github" })).body.map((c) => c.id), [created.body.id]);
  assert.equal((await call("DELETE", `/conversations/${created.body.id}`, { user: "bob@github" })).status, 200);
  assert.deepEqual((await call("GET", "/conversations", { user: "bob@github" })).body, []);
});

// ---- the queue ---------------------------------------------------------------------

/** A job the test finishes by hand. */
function deferredJob(log, name) {
  let done;
  const job = (signal) =>
    new Promise((resolve, reject) => {
      log.push(`start ${name}`);
      done = () => resolve(name);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  return { job, finish: () => done() };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("queue: one at a time, the rest in FIFO order, positions updated as it moves", async () => {
  const q = new RequestQueue({ concurrency: 1, max: 3 });
  const log = [];
  const jobs = ["a", "b", "c"].map((n) => deferredJob(log, n));
  const updates = { b: [], c: [] };
  const ta = q.enqueue(jobs[0].job);
  const tb = q.enqueue(jobs[1].job, { onUpdate: (u) => updates.b.push(u.type === "queued" ? u.position : u.type) });
  const tc = q.enqueue(jobs[2].job, { onUpdate: (u) => updates.c.push(u.type === "queued" ? u.position : u.type) });
  assert.deepEqual([ta.position, tb.position, tc.position], [0, 1, 2]);
  assert.deepEqual([q.running, q.depth], [1, 2]);
  jobs[0].finish();
  assert.equal((await ta.promise).value, "a");
  await tick();
  jobs[1].finish();
  await tb.promise;
  await tick();
  jobs[2].finish();
  await tc.promise;
  assert.deepEqual(log, ["start a", "start b", "start c"]);
  assert.deepEqual(updates.b, [1, "started"]);
  assert.deepEqual(updates.c, [2, 1, "started"]);
});

test("queue: past the max it refuses with 429 and a Retry-After estimate", () => {
  const q = new RequestQueue({ concurrency: 1, max: 2 });
  const log = [];
  for (const n of ["a", "b", "c"]) q.enqueue(deferredJob(log, n).job);
  assert.throws(() => q.enqueue(deferredJob(log, "d").job), (err) => err instanceof QueueError && err.status === 429 && err.code === "busy" && err.retryAfterS >= 5 && /busy/.test(err.message));
});

test("queue: a waiting request whose client leaves is removed, never runs, and those behind it move up", async () => {
  const q = new RequestQueue({ concurrency: 1, max: 5 });
  const log = [];
  const a = deferredJob(log, "a");
  const gone = new AbortController();
  const positions = [];
  q.enqueue(a.job);
  const tb = q.enqueue(deferredJob(log, "b").job, { signal: gone.signal });
  const tc = q.enqueue(deferredJob(log, "c").job, { onUpdate: (u) => positions.push(u.position ?? u.type) });
  gone.abort();
  await assert.rejects(tb.promise, (err) => err.status === 499);
  assert.equal(q.depth, 1);
  assert.deepEqual(positions, [2, 1]);
  a.finish();
  await tick();
  assert.deepEqual(log, ["start a", "start c"]);
  assert.equal(q.running, 1);
  void tc;
});

test("queue: a request that runs past its timeout fails with 504, its job is aborted, and the next one starts", async () => {
  const q = new RequestQueue({ concurrency: 1, max: 5, timeoutMs: 30 });
  const log = [];
  let aborted = null;
  const slow = (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => ((aborted = signal.reason), reject(signal.reason))));
  const next = deferredJob(log, "next");
  const t1 = q.enqueue(slow);
  const t2 = q.enqueue(next.job);
  await assert.rejects(t1.promise, (err) => err.status === 504 && err.code === "timeout" && /didn't finish within/.test(err.message));
  assert.equal(aborted?.code, "timeout");
  await tick();
  assert.deepEqual(log, ["start next"]);
  next.finish();
  assert.equal((await t2.promise).value, "next");
});

test("queue: a request's own deadline can only be shorter than the queue's", async () => {
  const q = new RequestQueue({ concurrency: 1, max: 5, timeoutMs: 60_000 });
  const t1 = q.enqueue((signal) => new Promise((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason))), { timeoutMs: 20 });
  await assert.rejects(t1.promise, (err) => err.status === 504);
});

test("queue: one per key, and draining rejects the waiting ones with 503 and waits for the running one", async () => {
  const q = new RequestQueue({ concurrency: 1, max: 5 });
  const log = [];
  const a = deferredJob(log, "a");
  const ta = q.enqueue(a.job, { key: "u:1" });
  const tb = q.enqueue(deferredJob(log, "b").job, { key: "u:2" });
  assert.equal(q.has("u:1"), true);
  assert.equal(q.has("u:2"), true);
  assert.equal(q.has("u:3"), false);
  let drained = false;
  const draining = q.drain().then(() => (drained = true));
  await assert.rejects(tb.promise, (err) => err.status === 503);
  assert.throws(() => q.enqueue(deferredJob(log, "c").job), (err) => err.status === 503);
  await tick();
  assert.equal(drained, false, "the running one is still going");
  a.finish();
  await ta.promise;
  await draining;
  assert.equal(drained, true);
  assert.deepEqual(log, ["start a"]);
});

// ---- the limits over HTTP ------------------------------------------------------------

test("limits: a full queue is a 429 'server busy' with Retry-After; waiting clients see their position; one message per chat at a time", async (t) => {
  const ollama = scriptedOllama();
  const { call, base, hosted } = await serve(t, { env: { HOSTED_QUEUE_MAX: "1" }, ollama });
  ollama.hold();
  const running = call("POST", "/api/ask", { user: "u1@x", body: { question: "Is CMP for iOS stable?" } });
  await ollama.held(1);
  // The second waits: its stream says so.
  const waiting = fetch(base + "/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/x-ndjson", "Tailscale-User-Login": "u2@x" },
    body: JSON.stringify({ message: "Is CMP for iOS stable?", sessionId: A }),
  });
  while (hosted.queue.depth < 1) await tick();
  const sameChat = await call("POST", "/chat", { user: "u2@x", body: { message: "And Android?", sessionId: A } });
  assert.equal(sameChat.status, 409);
  assert.match(sameChat.body.error, /still waiting/);

  const busy = await call("POST", "/api/ask", { user: "u3@x", body: { question: "Is CMP for iOS stable?" } });
  assert.equal(busy.status, 429);
  assert.match(busy.body.error, /busy/);
  assert.ok(Number(busy.headers.get("retry-after")) >= 5);

  ollama.release();
  assert.equal((await running).status, 200);
  const stream = await waiting;
  assert.match(stream.headers.get("content-type"), /ndjson/);
  const events = (await stream.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.type), ["queued", "started", "done"]);
  assert.equal(events[0].position, 1);
  assert.equal(events.at(-1).body.meta.rag.status, "answered");
});

test("limits: a client that leaves the queue is removed and doesn't block the next one", async (t) => {
  const ollama = scriptedOllama();
  const { call, hosted } = await serve(t, { ollama });
  ollama.hold();
  const running = call("POST", "/api/ask", { user: "u1@x", body: { question: "q1" } });
  await ollama.held(1);
  const gone = new AbortController();
  const left = call("POST", "/api/ask", { user: "u2@x", body: { question: "q2" }, signal: gone.signal }).catch((err) => err.name);
  while (hosted.queue.depth < 1) await tick();
  gone.abort();
  assert.equal(await left, "AbortError");
  while (hosted.queue.depth > 0) await tick();
  ollama.release();
  assert.equal((await running).status, 200);
  const next = await call("POST", "/api/ask", { user: "u3@x", body: { question: "q3" } });
  assert.equal(next.status, 200);
});

test("limits: a chat whose client leaves while it runs still finishes and is saved", async (t) => {
  const ollama = scriptedOllama();
  const { call, stores, hosted } = await serve(t, { ollama });
  ollama.hold();
  const gone = new AbortController();
  const left = call("POST", "/chat", { user: "p@x", body: { message: "Is CMP for iOS stable?", sessionId: B }, signal: gone.signal }).catch((err) => err.name);
  await ollama.held(1);
  gone.abort();
  assert.equal(await left, "AbortError");
  ollama.release();
  while (hosted.queue.running) await tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await stores.get("p@x").load(B)).messages.length, 2, "the answer is in the chat when it is reopened");
  assert.equal((await call("GET", "/health")).status, 200, "the server is fine");
});

test("limits: the rate limit is per user, with Retry-After, and only admitted messages count", async (t) => {
  const { call } = await serve(t, { env: { HOSTED_RATE_LIMIT: "2/10m", HOSTED_MAX_MESSAGE_CHARS: "50" } });
  // Refused for size: not counted.
  assert.equal((await call("POST", "/api/ask", { user: "r@x", body: { question: "x".repeat(51) } })).status, 413);
  assert.equal((await call("POST", "/api/ask", { user: "r@x", body: { question: "q1" } })).status, 200);
  assert.equal((await call("POST", "/chat", { user: "r@x", body: { message: "q2", sessionId: A } })).status, 200);
  const third = await call("POST", "/api/ask", { user: "r@x", body: { question: "q3" } });
  assert.equal(third.status, 429);
  assert.match(third.body.error, /You've sent 2 messages in the last 10 min/);
  const retry = Number(third.headers.get("retry-after"));
  assert.ok(retry > 590 && retry <= 600, String(retry));
  assert.equal(third.body.retryAfter, retry);
  assert.equal((await call("POST", "/api/ask", { user: "other@x", body: { question: "q1" } })).status, 200, "another user is not limited");

  const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  let now = 0;
  limiter.record("u");
  now = 400;
  limiter.record("u");
  assert.deepEqual(limiter.check("u").ok, false);
  assert.equal(limiter.check("u").retryAfterS, 1);
  now = 1001;
  assert.equal(limiter.check("u").ok, true);
  assert.deepEqual(rateLimitOf("10/10m"), { limit: 10, windowMs: 600_000 });
  assert.deepEqual(rateLimitOf("3/30s"), { limit: 3, windowMs: 30_000 });
  assert.throws(() => rateLimitOf("ten"));
});

test("limits: a message over the size limit is a readable 413, on both routes", async (t) => {
  const { call, ollama } = await serve(t, { env: { HOSTED_MAX_MESSAGE_CHARS: "100" } });
  const chat = await call("POST", "/chat", { body: { message: "x".repeat(101), sessionId: A } });
  assert.equal(chat.status, 413);
  assert.match(chat.body.error, /101 characters long; this server takes at most 100/);
  const ask = await call("POST", "/api/ask", { body: { question: "y".repeat(101) } });
  assert.equal(ask.status, 413);
  const huge = await call("POST", "/api/ask", { body: { question: "z".repeat(100_000) } });
  assert.equal(huge.status, 413, "a body past the JSON limit is a 413 too");
  assert.equal(ollama.chats().length, 0);
});

test("limits: a timeout fails cleanly with 504, the model call is aborted, and the next request works", async (t) => {
  const ollama = scriptedOllama();
  const { call } = await serve(t, { env: { HOSTED_REQUEST_TIMEOUT_MS: "1000" }, ollama });
  ollama.hold();
  const slow = await call("POST", "/api/ask", { body: { question: "Is CMP for iOS stable?" } });
  assert.equal(slow.status, 504);
  assert.match(slow.body.error, /didn't finish within 1 s/);
  ollama.release();
  const next = await call("POST", "/api/ask", { body: { question: "Is CMP for iOS stable?" } });
  assert.equal(next.status, 200);
  assert.equal(next.body.status, "answered");
  // A client deadline (X-Request-Timeout-Ms) can only shorten it.
  ollama.hold();
  const started = Date.now();
  const abortsBefore = ollama.aborted.length;
  const short = await call("POST", "/api/ask", { body: { question: "q" }, headers: { "x-request-timeout-ms": "50" } });
  assert.equal(short.status, 504);
  assert.ok(Date.now() - started < 900);
  // The held model call was aborted by the request's deadline, not by the Ollama client's own 1 s timeout.
  while (ollama.aborted.length === abortsBefore) await tick();
  assert.ok(ollama.aborted.at(-1) - started < 900, "the model call was aborted with the request");
  ollama.release();
});

// ---- the API -------------------------------------------------------------------------

test("api: /api/ask answers with status, answer, citations, sources, clarifying_question and timings", async (t) => {
  const { call } = await serve(t);
  const res = await call("POST", "/api/ask", { body: { question: "Is CMP for iOS stable?" } });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).slice(0, 6), ["status", "answer", "citations", "sources", "clarifying_question", "timings"]);
  assert.equal(res.body.status, "answered");
  assert.deepEqual(res.body.citations[0], { id: "c1", chunk_id: "cmp:3", quote: GOOD_ANSWER.citations[0].quote, source: "kb/cmp.html", section: "iOS" });
  assert.equal(res.body.sources[0].chunk_id, "cmp:3");
  assert.equal(res.body.clarifying_question, null);
  for (const key of ["queueMs", "retrieveMs", "rerankMs", "answerMs", "totalMs"]) assert.equal(typeof res.body.timings[key], "number", key);
  assert.equal((await call("POST", "/api/ask", { body: {} })).status, 400);
});

test("health: Ollama, the model, the index, the reranker, the queue and uptime", async (t) => {
  const { call, hosted } = await serve(t);
  const before = (await call("GET", "/health")).body;
  assert.equal(before.status, "starting");
  assert.equal(before.ok, false);
  await hosted.warmUp();
  const h = (await call("GET", "/health")).body;
  assert.equal(h.ok, true);
  assert.equal(h.status, "ok");
  assert.equal(typeof h.uptimeS, "number");
  assert.equal(h.ollama.reachable, true);
  assert.equal(h.ollama.version, "0.40.2");
  assert.deepEqual({ name: h.model.name, loaded: h.model.loaded, numCtx: h.model.numCtx, promptVariant: h.model.promptVariant }, { name: "qwen3.5:9b", loaded: true, numCtx: 8192, promptVariant: "v1" });
  assert.deepEqual(h.index, { ok: true });
  assert.deepEqual(h.embeddings, { loaded: true });
  assert.deepEqual(h.reranker, { loaded: true });
  assert.deepEqual(h.queue, { depth: 0, running: 0, concurrency: 1, max: 5 });
  assert.deepEqual(h.limits, { concurrency: 1, queueMax: 5, rateLimit: 10, rateWindowS: 600, maxMessageChars: 2000, maxOutputTokens: 1024, requestTimeoutMs: 180000, historyTurns: 6, numCtx: 8192 });
  assert.equal(h.outboundBlocked, 0);
  assert.equal(h.warmup.done, true);
  assert.equal(h.warmup.error, null);
});

test("health: Ollama down is a 200 that says so", async (t) => {
  const down = { fetch: async () => { throw new TypeError("fetch failed"); }, chats: () => [] };
  const { call } = await serve(t, { ollama: down });
  const h = (await call("GET", "/health")).body;
  assert.equal(h.ollama.reachable, false);
  assert.match(h.ollama.error, /isn't reachable/);
  assert.equal(h.model.loaded, false);
  assert.equal(h.ok, false);
});
