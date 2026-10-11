import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import express from "express";

import { agentFor } from "../agents.js";
import { createLlms, localChoice } from "../llm/choice.js";
import { guardFetch } from "../llm/fetchGuard.js";
import { LlmProvider } from "../llm/provider.js";
import { answerQuestion } from "../rag/answer.js";
import { chatSettings, ragSettings } from "../rag/config.js";
import { answerKnowledgeMessage, knowledgeView } from "../rag/knowledgeTurn.js";
import { sharedReranker } from "../rag/reranker.js";
import { RetrievalError, sharedRetriever } from "../rag/retriever.js";
import { emptyMemory } from "../rag/taskMemory.js";
import { isValidSessionId } from "../store/conversationStore.js";
import { JsonFileStore } from "../store/jsonFileStore.js";
import { HOSTED_FIXED, hostedLocalEnv, hostedSettings } from "./config.js";
import { identity, userDirName } from "./identity.js";
import { QueueError, RequestQueue } from "./queue.js";
import { RateLimiter } from "./rateLimit.js";

/**
 * **The hosted service (Day 30): the Knowledge chat alone, as its own server.**
 *
 * Not the full app with things hidden: a separate Express app that mounts only
 *
 *   - `GET /` — the Knowledge chat page (`public/index.html` with `data-hosted`),
 *     plus the three scripts it imports (`/markdown.js`, `/pricing.js`, `/vendor/*`);
 *   - the user's own Knowledge chats: `GET /conversations`, `POST /conversations`,
 *     `GET` / `DELETE /conversations/:id`, `DELETE /conversations/:id/task-memory`,
 *     `POST /chat`;
 *   - `POST /api/ask` (one stateless question), `GET /api/me`, `GET /health`.
 *
 * Everything else is a 404 — `/rag-report`, Compare, `/rag/*`, the pipelines,
 * MCP and Notion OAuth, the other agents — because none of it is mounted. No
 * MCP client is created and nothing here imports one; there is no Claude
 * provider (a stub that refuses), and the model, RAG and rerank are fixed
 * (`HOSTED_FIXED`).
 *
 * Every message — a chat turn or an `/api/ask` — goes through one queue
 * (`queue.js`) and one per-user rate limit (`rateLimit.js`). A client that sends
 * `Accept: application/x-ndjson` gets the queue's progress as it happens
 * (`queued` with the position, `started`, then `done` or `error`); any other
 * client gets one JSON answer when it is done.
 *
 * Each user's chats are in their own directory (`HOSTED_DATA_DIR/<login>-<hash>`),
 * so a request can only ever load the asking user's conversations.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {typeof fetch} [options.fetch] - every Ollama call (hosted.js: the guarded one; tests: a fake Ollama)
 * @param {(user: { login: string }) => import("../store/conversationStore.js").ConversationStore} [options.storeFor] - tests: in-memory stores
 * @param {object} [options.ragDeps] - tests: `search`, `rerankScores`, `ready`, `rerankerReady`, `routeTurn`
 * @param {() => number} [options.outboundBlocked] - how many non-localhost requests the process's fetch guard refused
 * @param {(line: string) => void} [options.log]
 */
export function createHostedApp(options = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const settings = hostedSettings(env);
  const startedAt = Date.now();
  // The request a model call is made for, so the call can carry its abort signal.
  const requestContext = new AsyncLocalStorage();
  // Every Ollama call goes through the localhost-only guard and carries the
  // current request's signal: a request that times out (or whose client
  // leaves an /api/ask) stops its model call too, so the next one isn't stuck behind it.
  const modelFetch = guardFetch({
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    name: "hosted",
    log: (line) => console.warn(line),
    signal: () => requestContext.getStore()?.signal,
  }).fetch;

  // No Claude: whatever ANTHROPIC_API_KEY says, the only provider is Ollama.
  const claude = new NoClaude();
  const llms = createLlms({ claude, claudeAvailable: false, env: hostedLocalEnv(env, settings), fetch: modelFetch });
  const choice = localChoice(HOSTED_FIXED.model);
  const provider = llms.ragProviderFor(choice);
  const rag = ragSettings(env);
  const chat = chatSettings(env);

  // Retrieval and rerank, real (doc_index, loaded by the warm-up) or the tests' fakes,
  // wrapped so /health knows whether the index answered last time.
  const deps = options.ragDeps ?? {};
  const index = { ok: null, error: null };
  const realSearch = deps.search ?? ((question, o) => sharedRetriever().search(question, o));
  const search = async (question, o) => {
    try {
      const hits = await realSearch(question, o);
      Object.assign(index, { ok: true, error: null });
      return hits;
    } catch (err) {
      if (err instanceof RetrievalError) Object.assign(index, { ok: false, error: err.message });
      throw err;
    }
  };
  const rerankScores = deps.rerankScores ?? ((query, passages) => sharedReranker().score(query, passages));
  const embeddingsReady = deps.ready ?? (() => sharedRetriever().ready());
  const rerankerReady = deps.rerankerReady ?? (() => sharedReranker().ready());
  const fakes = { search, rerankScores, log };

  const queue = new RequestQueue({ concurrency: settings.concurrency, max: settings.queueMax, timeoutMs: settings.requestTimeoutMs });
  const limiter = new RateLimiter({ limit: settings.rateLimit, windowMs: settings.rateWindowMs });
  const stores = new Map();
  const storeFor =
    options.storeFor ??
    ((user) => {
      const dir = path.join(settings.dataDir, userDirName(user.login));
      if (!stores.has(dir)) stores.set(dir, new JsonFileStore({ dir }));
      return stores.get(dir);
    });
  const warmup = { done: false, ms: null, error: null };
  const knowledge = agentFor("knowledge");

  const app = express();
  app.disable("x-powered-by");
  app.use(identity());
  app.use(express.json({ limit: "64kb" }));

  // ---- the page ------------------------------------------------------------

  const PUBLIC_DIR = path.join(import.meta.dirname, "..", "..", "public");
  const NODE_MODULES = path.join(import.meta.dirname, "..", "..", "node_modules");
  // The same page as the full app's, told it is hosted: the server sets the flag, the page hides the rest.
  const page = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8").replace(/<html\b/, '<html data-hosted="1"');
  const SCRIPTS = {
    "/markdown.js": path.join(PUBLIC_DIR, "markdown.js"),
    "/pricing.js": path.join(import.meta.dirname, "..", "llm", "pricing.js"),
    "/vendor/marked.js": path.join(NODE_MODULES, "marked", "lib", "marked.esm.js"),
    "/vendor/purify.js": path.join(NODE_MODULES, "dompurify", "dist", "purify.es.mjs"),
  };
  app.get("/", (_req, res) => res.type("html").set("cache-control", "no-store").send(page));
  for (const [route, file] of Object.entries(SCRIPTS)) app.get(route, (_req, res) => res.type("application/javascript").sendFile(file));

  // ---- who, and how the server is ---------------------------------------------

  app.get("/api/me", (req, res) => {
    res.json({
      user: { login: req.user.login, name: req.user.name, pic: req.user.pic, tailnet: req.user.tailnet },
      agent: { id: knowledge.id, name: knowledge.name, tagline: `Kotlin & KMP articles · ${HOSTED_FIXED.model}, on this Mac`, kind: "knowledge", local: true },
      model: HOSTED_FIXED.model,
      limits: limitsOf(settings, chat),
    });
  });

  app.get("/health", async (_req, res) => {
    res.json(await health());
  });

  // ---- the user's own Knowledge chats ------------------------------------------

  app.get("/conversations", route(async (req, res) => {
    res.json(await storeFor(req.user).listSessions({ agentId: "knowledge" }));
  }));

  app.post("/conversations", route(async (req, res) => {
    const id = crypto.randomUUID();
    const saved = await storeFor(req.user).save(id, [], undefined, { agentId: "knowledge", ragMode: HOSTED_FIXED.mode, ragOptions: HOSTED_FIXED.ragOptions, llm: choice });
    res.status(201).json({ id, title: saved.title, updatedAt: saved.updatedAt, messageCount: 0, agentId: "knowledge" });
  }));

  app.get("/conversations/:id", route(async (req, res) => {
    const { id } = req.params;
    if (!isValidSessionId(id)) return res.status(400).json({ error: "Not a valid conversation id." });
    // Another user's id reads as a chat nobody has written in: it is not in this user's store.
    res.json(knowledgeView(await storeFor(req.user).load(id), HOSTED_FIXED.ragOptions));
  }));

  app.delete("/conversations/:id", route(async (req, res) => {
    const { id } = req.params;
    if (!isValidSessionId(id)) return res.status(400).json({ error: "Not a valid conversation id." });
    if (queue.has(turnKey(req.user, id))) return res.status(409).json({ error: "This chat is still waiting for an answer. Delete it once the answer is in." });
    await storeFor(req.user).clear(id);
    res.json({ ok: true });
  }));

  app.delete("/conversations/:id/task-memory", route(async (req, res) => {
    const { id } = req.params;
    if (!isValidSessionId(id)) return res.status(400).json({ error: "Not a valid conversation id." });
    if (queue.has(turnKey(req.user, id))) return res.status(409).json({ error: "This chat is still waiting for an answer. Reset its memory once the answer is in." });
    const store = storeFor(req.user);
    const record = await store.load(id);
    if (!record) return res.json({ taskMemory: emptyMemory(), saved: false });
    await store.save(id, record.messages, undefined, { taskMemory: emptyMemory() });
    res.json({ taskMemory: emptyMemory(), saved: true });
  }));

  app.post("/chat", route(async (req, res) => {
    const { message, sessionId } = req.body ?? {};
    if (!isValidSessionId(sessionId)) return res.status(400).json({ error: "A 'sessionId' in UUID v4 form is required." });
    const text = checkMessage(res, message, "message");
    if (text === null) return;
    const store = storeFor(req.user);
    await runQueued(req, res, {
      key: turnKey(req.user, sessionId),
      what: `chat ${sessionId.slice(0, 8)}`,
      // The chat's answer is saved even if the page was closed while it ran: it is there on the next visit.
      cancelRunning: false,
      job: async () => {
        const record = await store.load(sessionId);
        return answerKnowledgeMessage({
          store,
          sessionId,
          record,
          message: text,
          mode: HOSTED_FIXED.mode,
          ragOptions: HOSTED_FIXED.ragOptions,
          llm: choice,
          agent: "knowledge",
          llms,
          settings: rag,
          fakes,
          chat,
          historyMessages: chat.historyTurns,
          ...(deps.routeTurn ? { routeTurn: deps.routeTurn } : {}),
          log,
        });
      },
      summary: (out) => `${out.meta.route?.intent ?? "?"}${out.meta.rag?.status ? ` → ${out.meta.rag.status}` : ""}${out.meta.possible_truncation ? " · POSSIBLE TRUNCATION" : ""}`,
    });
  }));

  // ---- the API -----------------------------------------------------------------

  /**
   * One question, no conversation: retrieval, rerank and the citation
   * contract, exactly as a search turn of the chat, without the router or a
   * task memory. Nobody reads an answer whose client has gone, so leaving
   * cancels it even while it runs.
   */
  app.post("/api/ask", route(async (req, res) => {
    const text = checkMessage(res, req.body?.question, "question");
    if (text === null) return;
    await runQueued(req, res, {
      key: null,
      what: "ask",
      cancelRunning: true,
      job: async () => {
        const startedAt = Date.now();
        const r = await answerQuestion(text, { mode: "rag", ...HOSTED_FIXED.ragOptions, provider, ...rag, ...fakes });
        return {
          status: r.status,
          answer: r.answer,
          citations: (r.citations ?? []).map(({ id, chunk_id, quote, source, section }) => ({ id, chunk_id, quote, source, section })),
          sources: (r.sources ?? []).map(({ chunk_id, source, section, label }) => ({ chunk_id, source, section, label })),
          clarifying_question: r.status === "dont_know" ? (r.clarifyingQuestion ?? null) : null,
          timings: {
            retrieveMs: r.timings.retrieveMs,
            rerankMs: r.timings.rerankMs,
            answerMs: r.timings.llmMs + r.timings.clarifyMs,
            totalMs: Date.now() - startedAt,
          },
          model: r.model,
          ...(r.possible_truncation ? { possible_truncation: true } : {}),
        };
      },
      // The queue's own times go into the answer's timings.
      finish: (out, { waitedMs, runMs }) => ({ ...out, timings: { queueMs: waitedMs, ...out.timings, runMs } }),
      summary: (out) => `${out.status}${out.possible_truncation ? " · POSSIBLE TRUNCATION" : ""}`,
    });
  }));

  // ---- everything else ----------------------------------------------------------

  app.use((req, res) => res.status(404).json({ error: `Not found: ${req.method} ${req.path} is not part of the hosted service.` }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err?.type === "entity.too.large") return res.status(413).json({ error: `That request is too large. A message is at most ${settings.maxMessageChars} characters.` });
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "The request body is not valid JSON." });
    console.error(`[hosted] ${req.method} ${req.path}`, err);
    res.status(500).json({ error: "Something went wrong on the server." });
  });

  // ---- helpers ---------------------------------------------------------------------

  function route(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  }

  /** The trimmed text, or null after answering 400 / 413. */
  function checkMessage(res, value, name) {
    if (typeof value !== "string" || !value.trim()) {
      res.status(400).json({ error: `A non-empty '${name}' is required.` });
      return null;
    }
    if (value.length > settings.maxMessageChars) {
      res.status(413).json({
        error: `Your ${name} is ${value.length} characters long; this server takes at most ${settings.maxMessageChars}. Shorten it and send it again.`,
        limit: settings.maxMessageChars,
      });
      return null;
    }
    return value.trim();
  }

  /**
   * Admission (draining → 503, same chat busy → 409, rate limit → 429, queue
   * full → 429), then the job in the queue, then the answer — streamed as
   * progress events for a client that asked for NDJSON, one JSON body otherwise.
   */
  async function runQueued(req, res, { key, what, cancelRunning, job, finish = (out) => out, summary = () => "" }) {
    const user = req.user.login;
    const refuse = (status, error, retryAfterS) => {
      if (retryAfterS != null) res.set("retry-after", String(retryAfterS));
      log(`[hosted] ${user} ${what} → ${status} ${error.split(".")[0]}`);
      return res.status(status).json({ error, ...(retryAfterS != null ? { retryAfter: retryAfterS } : {}) });
    };
    if (queue.draining) return refuse(503, "The server is shutting down. Try again in a minute.");
    if (key && queue.has(key)) return refuse(409, "A message in this chat is still waiting for its answer. Send the next one once it's in.");
    const rate = limiter.check(user);
    if (!rate.ok) return refuse(429, rate.message, rate.retryAfterS);

    const stream = /application\/x-ndjson/.test(req.get("accept") ?? "");
    const gone = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) gone.abort();
    });
    // Events only once the stream's headers are out; what happened before (admission) is sent as the state it left.
    let open = false;
    const send = (event) => {
      if (open && !res.writableEnded && !res.destroyed) res.write(JSON.stringify(event) + "\n");
    };
    const deadline = deadlineOf(req);
    let ticket;
    try {
      ticket = queue.enqueue((signal) => requestContext.run({ signal }, job), {
        key,
        signal: gone.signal,
        cancelRunning,
        timeoutMs: deadline,
        onUpdate: (update) => {
          if (update.type === "started") log(`[hosted] ${user} ${what} started${update.waitedMs > 50 ? ` after ${(update.waitedMs / 1000).toFixed(1)} s in the queue` : ""}`);
          send(update.type === "queued" ? { type: "queued", position: update.position, ahead: update.position - 1 + queue.running } : { type: "started", waitedMs: update.waitedMs });
        },
      });
    } catch (err) {
      if (err instanceof QueueError) return refuse(err.status, err.message, err.retryAfterS);
      throw err;
    }
    limiter.record(user);
    if (ticket.position) log(`[hosted] ${user} ${what} queued at position ${ticket.position}`);
    if (stream) {
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
      res.flushHeaders();
      open = true;
      // The events emitted while the request was being admitted, before the headers went out.
      if (ticket.position) send({ type: "queued", position: ticket.position, ahead: ticket.position - 1 + queue.running });
      else send({ type: "started", waitedMs: 0 });
    }

    let outcome;
    try {
      outcome = await ticket.promise;
    } catch (err) {
      const { status, error } = failureOf(err);
      if (status === 499) return log(`[hosted] ${user} ${what} → left (${err.message})`);
      log(`[hosted] ${user} ${what} → ${status} ${error.split(".")[0]}`);
      if (res.destroyed) return;
      if (stream) {
        send({ type: "error", status, error });
        return res.end();
      }
      return res.status(status).json({ error });
    }
    const body = finish(outcome.value, outcome);
    log(`[hosted] ${user} ${what} → 200 in ${(outcome.runMs / 1000).toFixed(1)} s (waited ${(outcome.waitedMs / 1000).toFixed(1)} s) ${summary(outcome.value)}${res.destroyed ? " · the client had left (saved)" : ""}`);
    if (res.destroyed) return;
    if (stream) {
      send({ type: "done", status: 200, body });
      return res.end();
    }
    res.json(body);
  }

  /**
   * A request's own deadline, from `X-Request-Timeout-Ms`: it can only make
   * the request's timeout shorter than `HOSTED_REQUEST_TIMEOUT_MS`, never
   * longer (`load:local` uses it to check that a timeout fails cleanly).
   */
  function deadlineOf(req) {
    const raw = Number(req.get("x-request-timeout-ms"));
    return Number.isInteger(raw) && raw >= 1 ? Math.min(raw, settings.requestTimeoutMs) : settings.requestTimeoutMs;
  }

  function failureOf(err) {
    if (err instanceof QueueError) return { status: err.status, error: err.message };
    if (err instanceof RetrievalError) return { status: 503, error: err.message };
    // A local model's failure was written to be read (`ollama serve`, a timeout with the setting to raise).
    if (err?.local && typeof err.message === "string") return { status: 502, error: err.message.slice(0, 600) };
    console.error("[hosted]", err);
    return { status: 500, error: "Something went wrong while generating a reply." };
  }

  async function ollamaState() {
    const url = llms.settings.url;
    const get = async (p) => {
      const r = await modelFetch(url + p, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };
    try {
      const [version, ps] = await Promise.all([get("/api/version"), get("/api/ps")]);
      const loaded = (ps.models ?? []).find((m) => (m.name ?? m.model) === HOSTED_FIXED.model) ?? null;
      return {
        ollama: { reachable: true, version: version.version ?? null, url },
        loaded,
        all: (ps.models ?? []).map((m) => ({ name: m.name ?? m.model, sizeBytes: m.size ?? null, vramBytes: m.size_vram ?? null })),
      };
    } catch (err) {
      return { ollama: { reachable: false, version: null, url, error: `Ollama isn't reachable at ${url} (${err?.cause?.code ?? err?.message ?? "connection failed"}).` }, loaded: null, all: [] };
    }
  }

  /** `GET /health`. */
  async function health() {
    const { ollama, loaded, all } = await ollamaState();
    const ok = ollama.reachable && index.ok !== false && warmup.done && !warmup.error && !queue.draining;
    return {
      ok,
      status: queue.draining ? "draining" : !warmup.done ? "starting" : ok ? "ok" : "degraded",
      uptimeS: Math.round((Date.now() - startedAt) / 1000),
      startedAt: new Date(startedAt).toISOString(),
      ollama,
      model: {
        name: HOSTED_FIXED.model,
        loaded: Boolean(loaded),
        sizeBytes: loaded?.size ?? null,
        vramBytes: loaded?.size_vram ?? null,
        expiresAt: loaded?.expires_at ?? null,
        numCtx: HOSTED_FIXED.numCtx,
        promptVariant: HOSTED_FIXED.promptVariant,
        keepAlive: settings.keepAlive,
      },
      loadedModels: all,
      index: { ok: index.ok, ...(index.error ? { error: index.error } : {}) },
      embeddings: { loaded: embeddingsReady() },
      reranker: { loaded: rerankerReady() },
      queue: { depth: queue.depth, running: queue.running, concurrency: queue.concurrency, max: queue.max },
      // The embedding model and the reranker live in this process, not in Ollama.
      process: { rssBytes: process.memoryUsage().rss },
      limits: limitsOf(settings, chat),
      warmup: { ...warmup },
      outboundBlocked: options.outboundBlocked?.() ?? 0,
    };
  }

  /**
   * Load everything a first question needs before the server says it is
   * ready: the embedding model and the index (one search), the reranker (one
   * score), and qwen at the window every call will use (one 1-token reply), so
   * no later call reloads it.
   */
  async function warmUp() {
    const t0 = Date.now();
    try {
      await search("Kotlin Multiplatform", { k: 1, strategy: rag.strategy, collections: rag.collections });
      await rerankScores("Kotlin Multiplatform", ["Kotlin Multiplatform shares code between platforms."]);
      await provider.complete({ messages: [{ role: "user", content: "Reply with OK." }], maxTokens: 1, temperature: 0 });
      Object.assign(warmup, { done: true, ms: Date.now() - t0, error: null });
    } catch (err) {
      Object.assign(warmup, { done: true, ms: Date.now() - t0, error: String(err?.message ?? err).split("\n")[0] });
    }
    return { ...warmup };
  }

  return { app, queue, limiter, settings, llms, claude, health, warmUp };
}

/** A chat's queue key: one running or waiting message per user per conversation. */
const turnKey = (user, sessionId) => `${user.login}:${sessionId}`;

function limitsOf(s, chat) {
  return {
    concurrency: s.concurrency,
    queueMax: s.queueMax,
    rateLimit: s.rateLimit,
    rateWindowS: Math.round(s.rateWindowMs / 1000),
    maxMessageChars: s.maxMessageChars,
    maxOutputTokens: s.maxOutputTokens,
    requestTimeoutMs: s.requestTimeoutMs,
    historyTurns: chat.historyTurns,
    numCtx: HOSTED_FIXED.numCtx,
  };
}

/** What a `claude` choice would get: nothing. Counts the attempts so the tests can say there were none. */
export class NoClaude extends LlmProvider {
  calls = 0;
  get model() {
    return null;
  }
  async complete() {
    this.calls += 1;
    throw Object.assign(new Error("Claude isn't available on the hosted server: it answers with the local model only."), { local: true });
  }
  async countTokens() {
    this.calls += 1;
    return { inputTokens: null };
  }
}
