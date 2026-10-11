#!/usr/bin/env node
/**
 * **`npm run load:local` — the hosted service under a light load (Day 30).**
 *
 * Runs against a hosted server that is already up (`npm run serve:local`), by
 * HTTP only, like any other client:
 *
 *   1. **Isolation** — every excluded route is a 404 (`/rag-report`, Compare,
 *      `/rag/*`, pipelines, MCP and Notion OAuth, the other agents' routes).
 *   2. **Stability** — 5 simulated users, each with its own fake identity
 *      header, send 2–3 questions from the `citations` set all at once: the
 *      first in a new chat (`POST /chat`), the rest through `POST /api/ask`. A
 *      429 "server busy" is retried after its `Retry-After`, as a polite client
 *      would. Reported: successes, 429s, timeouts and errors; queue wait and
 *      answer latency (p50, p95, max); Ollama's memory (`/api/ps`, through
 *      `/health`) before and after; `/health` at the end.
 *   3. **Limits, one check each** — 413 over the size limit; 409 for a second
 *      message in a chat that has one waiting; 429 + `Retry-After` for a full
 *      queue; leaving the queue frees the place; 429 + `Retry-After` over the
 *      rate limit; a timeout fails cleanly (a short client deadline,
 *      `X-Request-Timeout-Ms`) and the next request works; one user can't read
 *      another's conversation.
 *   4. **Outbound** — the server's fetch guard count (`/health`) must not move.
 *
 * The rate-limit and full-queue checks don't make the model answer a dozen
 * questions: they fill the queue behind one running request and leave it
 * again (an admitted message counts towards the rate limit even if its client
 * leaves). The whole run is 1 model on 1 laptop and takes about 10 minutes:
 * it shows that the queue and the limits work, not throughput.
 *
 *   npm run load:local
 *   npm run load:local -- --url https://<machine>.<tailnet>.ts.net
 *
 * Through Tailscale Serve, the fake identity headers are replaced by your own,
 * so the five users become one (and share one rate limit): the report says so.
 *
 * Writes `reports/hosted_load_report.md` and `reports/hosted_load_results.json`.
 * Exit code 1 if a check failed.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { REPORTS_DIR, RAG_QUESTIONS_PATH } from "../src/rag/config.js";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  if (at >= 0) return args[at + 1];
  return args.find((a) => a.startsWith(name + "="))?.slice(name.length + 1);
};
const BASE = (option("--url") ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
const REPORT_MD = path.join(REPORTS_DIR, "hosted_load_report.md");
const REPORT_JSON = path.join(REPORTS_DIR, "hosted_load_results.json");
const USERS = 5;
/** A polite client retries a busy server this many times before giving up. */
const BUSY_RETRIES = 6;
/** The deadline the timeout check asks for: long enough for retrieval and rerank, far too short for an answer. */
const TIMEOUT_CHECK_MS = 4000;

const startedAt = new Date();
const t0 = Date.now();
const log = (line) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s] ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const questions = JSON.parse(fs.readFileSync(RAG_QUESTIONS_PATH, "utf8"));
const CITATIONS = (Array.isArray(questions) ? questions : questions.questions).filter((q) => (q.sets ?? []).includes("citations"));

// ---- HTTP --------------------------------------------------------------------------

const identity = (user) => (user ? { "Tailscale-User-Login": user, "Tailscale-User-Name": user.split("@")[0] } : {});

async function json(method, url, { user, body, headers = {} } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { "content-type": "application/json", ...identity(user), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed, retryAfter: res.headers.get("retry-after") };
}

/**
 * A queued request, streamed (NDJSON): `events` resolves on each event,
 * `result` with the outcome and its times, `abort()` leaves the queue.
 *
 * @returns {{ result: Promise<object>, next: (type: string) => Promise<object>, abort: () => void }}
 */
function open(url, body, { user, headers = {} } = {}) {
  const controller = new AbortController();
  const sentAt = Date.now();
  const seen = [];
  const waiters = [];
  const emit = (event) => {
    seen.push(event);
    for (const w of waiters.splice(0)) w();
  };
  const next = async (type) => {
    for (;;) {
      // Waiting for "queued" also ends when the request started straight away.
      const hit = seen.find((e) => e.type === type || e.type === "started" || e.type === "error" || e.type === "done" || e.type === "refused");
      if (hit) return hit;
      await new Promise((r) => waiters.push(r));
    }
  };
  const result = (async () => {
    let res;
    try {
      res = await fetch(BASE + url, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/x-ndjson", ...identity(user), ...headers },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const out = { status: err.name === "AbortError" ? "left" : "network", error: String(err.message), sentAt, totalMs: Date.now() - sentAt };
      emit({ type: "error", ...out });
      return out;
    }
    if (!(res.headers.get("content-type") ?? "").includes("ndjson")) {
      const data = await res.json().catch(() => ({}));
      const out = { status: res.status, error: data.error ?? null, retryAfter: Number(res.headers.get("retry-after")) || null, body: res.ok ? data : null, sentAt, totalMs: Date.now() - sentAt };
      emit({ type: "refused", ...out });
      return out;
    }
    let startedAtMs = null;
    let firstPosition = null;
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.type === "queued" && firstPosition === null) firstPosition = event.position;
          if (event.type === "started") startedAtMs = Date.now();
          emit(event);
          if (event.type === "done" || event.type === "error") {
            const now = Date.now();
            return {
              status: event.status,
              error: event.error ?? null,
              body: event.body ?? null,
              position: firstPosition ?? 0,
              sentAt,
              queueMs: (startedAtMs ?? now) - sentAt,
              answerMs: startedAtMs ? now - startedAtMs : null,
              totalMs: now - sentAt,
            };
          }
        }
      }
    } catch (err) {
      const out = { status: err.name === "AbortError" ? "left" : "network", error: String(err.message), sentAt, totalMs: Date.now() - sentAt };
      emit({ type: "error", ...out });
      return out;
    }
    const out = { status: "network", error: "the stream ended without an answer", sentAt, totalMs: Date.now() - sentAt };
    emit({ type: "error", ...out });
    return out;
  })();
  return { result, next, abort: () => controller.abort() };
}

const health = async () => (await json("GET", "/health")).body;
const percentile = (values, p) => {
  const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const sec = (ms) => (typeof ms === "number" ? `${(ms / 1000).toFixed(1)} s` : "—");
const gb = (bytes) => (typeof bytes === "number" ? `${(bytes / 1e9).toFixed(2)} GB` : "—");
const memoryOf = (h) => ({
  model: h?.model?.name ?? null,
  loaded: h?.model?.loaded ?? null,
  sizeBytes: h?.model?.sizeBytes ?? null,
  vramBytes: h?.model?.vramBytes ?? null,
  ollamaModels: h?.loadedModels ?? [],
  serverRssBytes: h?.process?.rssBytes ?? null,
});

// ---- 0. preflight ---------------------------------------------------------------------

log(`load:local against ${BASE}`);
let before;
try {
  before = await health();
} catch (err) {
  console.error(`✗ ${BASE}/health didn't answer (${err.cause?.code ?? err.message}). Start the server first: npm run serve:local`);
  process.exit(1);
}
if (!before?.ok) {
  console.error(`✗ ${BASE}/health is not ok (status ${before?.status}): ${JSON.stringify(before?.warmup?.error ?? before?.ollama?.error ?? before?.index?.error ?? "")}`);
  process.exit(1);
}
const limits = before.limits;
const outboundBefore = before.outboundBlocked;
const probe = await json("GET", "/api/me", { user: "probe@loadtest" });
const fakeIdentities = probe.body?.user?.login === "probe@loadtest";
log(`health ok · ${before.model.name} loaded ${before.model.loaded} (${gb(before.model.sizeBytes)}) · queue ${limits.concurrency}+${limits.queueMax} · rate ${limits.rateLimit}/${limits.rateWindowS / 60} min · fake identities ${fakeIdentities ? "accepted" : "replaced by Tailscale"}`);

const checks = [];
/** `pass: null` is a check that could not run here (it is reported as skipped, not failed). */
const check = (name, pass, detail) => {
  checks.push({ name, pass: pass === null ? null : Boolean(pass), detail });
  log(`${pass === null ? "–" : pass ? "✓" : "✗"} ${name} — ${detail}`);
};

// ---- 1. isolation ---------------------------------------------------------------------

const SAMPLE = "33333333-3333-4333-8333-333333333333";
const EXCLUDED = [
  ["GET", "/rag-report"],
  ["GET", "/rag-report/data"],
  ["GET", "/rag/status"],
  ["POST", "/rag/compare"],
  ["PUT", `/conversations/${SAMPLE}/rag`],
  ["PUT", `/conversations/${SAMPLE}/llm`],
  ["POST", `/conversations/${SAMPLE}/fork`],
  ["GET", `/conversations/${SAMPLE}/usage`],
  ["GET", `/conversations/${SAMPLE}/pipeline`],
  ["POST", `/conversations/${SAMPLE}/pipeline/run`],
  ["GET", `/conversations/${SAMPLE}/runs`],
  ["POST", `/conversations/${SAMPLE}/memory/finish-task`],
  ["GET", "/mcp/servers"],
  ["POST", "/mcp/notion/connect"],
  ["GET", "/mcp/oauth/callback"],
  ["GET", "/local/status"],
  ["GET", "/agents"],
  ["GET", "/profiles"],
  ["GET", "/projects"],
  ["POST", "/reset"],
];
const isolation = [];
for (const [method, url] of EXCLUDED) {
  const res = await json(method, url, { body: method === "GET" ? undefined : {} });
  isolation.push({ method, url, status: res.status });
}
const leaks = isolation.filter((r) => r.status !== 404);
check("excluded routes are 404", !leaks.length, leaks.length ? `not 404: ${leaks.map((r) => `${r.method} ${r.url} → ${r.status}`).join(", ")}` : `${isolation.length}/${isolation.length} routes → 404`);

// ---- 2. stability -------------------------------------------------------------------------

const users = Array.from({ length: USERS }, (_, i) => `load-user-${i + 1}@loadtest`);
const plan = [];
let qi = 0;
users.forEach((user, u) => {
  const count = u < 2 ? 3 : 2;
  for (let k = 0; k < count; k++) {
    const q = CITATIONS[qi++ % CITATIONS.length];
    plan.push({ user, question: q, kind: k === 0 ? "chat" : "ask", sessionId: k === 0 ? crypto.randomUUID() : null });
  }
});
log(`stability: ${USERS} users, ${plan.length} questions, all at once (one model: expect ~${Math.round((plan.length * 35) / 60)} min)`);

async function polite(item) {
  const attempts = [];
  for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
    const url = item.kind === "chat" ? "/chat" : "/api/ask";
    const body = item.kind === "chat" ? { message: item.question.question, sessionId: item.sessionId } : { question: item.question.question };
    const r = await open(url, body, { user: item.user }).result;
    attempts.push({ status: r.status, retryAfter: r.retryAfter ?? null, error: r.error ?? null });
    if (r.status === 429 && /busy/.test(r.error ?? "") && attempt < BUSY_RETRIES) {
      await sleep(Math.min(120, r.retryAfter ?? 10) * 1000);
      continue;
    }
    const answer = item.kind === "chat" ? r.body?.meta?.rag : r.body;
    const outcome = {
      user: item.user,
      kind: item.kind,
      id: item.question.id,
      status: r.status,
      busy429: attempts.filter((a) => a.status === 429).length,
      answerStatus: answer?.status ?? (item.kind === "chat" ? r.body?.meta?.stopReason : null) ?? null,
      citations: answer?.citations?.length ?? 0,
      position: r.position ?? null,
      queueMs: r.queueMs ?? null,
      answerMs: r.answerMs ?? null,
      totalMs: r.totalMs,
      error: r.error ?? null,
      sessionId: item.sessionId,
      possibleTruncation: Boolean(r.body?.possible_truncation ?? r.body?.meta?.possible_truncation),
    };
    log(`  ${item.user.split("@")[0]} ${item.kind} ${item.question.id} → ${r.status}${outcome.answerStatus ? ` ${outcome.answerStatus}` : ""} · waited ${sec(outcome.queueMs)} · answered in ${sec(outcome.answerMs)}${outcome.busy429 ? ` · ${outcome.busy429}× 429 busy first` : ""}`);
    return outcome;
  }
}
const memoryBefore = memoryOf(before);
const stabilityStarted = Date.now();
const stability = await Promise.all(plan.map(polite));
const stabilityMs = Date.now() - stabilityStarted;
const ok = stability.filter((s) => s.status === 200);
const stabilitySummary = {
  requests: stability.length,
  succeeded: ok.length,
  answered: ok.filter((s) => s.answerStatus === "answered").length,
  dontKnow: ok.filter((s) => s.answerStatus === "dont_know").length,
  busy429: stability.reduce((a, s) => a + s.busy429, 0),
  rate429: stability.filter((s) => s.status === 429 && !/busy/.test(s.error ?? "")).length,
  timeouts: stability.filter((s) => s.status === 504).length,
  errors: stability.filter((s) => s.status !== 200 && s.status !== 504 && s.status !== 429).length,
  queueMs: { p50: percentile(ok.map((s) => s.queueMs), 50), p95: percentile(ok.map((s) => s.queueMs), 95), max: percentile(ok.map((s) => s.queueMs), 100) },
  answerMs: { p50: percentile(ok.map((s) => s.answerMs), 50), p95: percentile(ok.map((s) => s.answerMs), 95), max: percentile(ok.map((s) => s.answerMs), 100) },
  possibleTruncations: stability.filter((s) => s.possibleTruncation).length,
  wallMs: stabilityMs,
};
check(
  "stability: every question answered",
  stabilitySummary.succeeded === stabilitySummary.requests,
  `${stabilitySummary.succeeded}/${stabilitySummary.requests} → 200 (${stabilitySummary.answered} answered, ${stabilitySummary.dontKnow} "I don't know") · ${stabilitySummary.busy429}× 429 busy (retried) · ${stabilitySummary.timeouts} timeouts · ${stabilitySummary.errors} errors · ${sec(stabilityMs)}`,
);
const afterStability = await health();

// ---- 3. limits -----------------------------------------------------------------------------

const limitChecks = {};

// 413
{
  const r = await json("POST", "/api/ask", { user: "size@loadtest", body: { question: "x".repeat(limits.maxMessageChars + 1) } });
  limitChecks.size = { status: r.status, error: r.body?.error };
  check("a message over the size limit → 413", r.status === 413 && /characters/.test(r.body?.error ?? ""), `${r.status}: ${r.body?.error}`);
}

// One request running for the next three checks: the queue fills behind it.
log("limits: one request running, the queue filled and emptied behind it");
const anchor = open("/api/ask", { question: CITATIONS[0].question }, { user: "anchor@loadtest" });
await anchor.next("started");

// 409: a second message in a chat that has one waiting
{
  const chatId = crypto.randomUUID();
  const first = open("/chat", { message: CITATIONS[1].question, sessionId: chatId }, { user: "chat@loadtest" });
  await first.next("queued");
  const second = await json("POST", "/chat", { user: "chat@loadtest", body: { message: "And on Android?", sessionId: chatId } });
  first.abort();
  await first.result;
  limitChecks.sameChat = { status: second.status, error: second.body?.error };
  check("a second message in a chat that has one waiting → 409", second.status === 409, `${second.status}: ${second.body?.error}`);
}

// 429: full queue, then leaving it
{
  const fillers = Array.from({ length: limits.queueMax }, (_, i) => open("/api/ask", { question: CITATIONS[(i + 2) % CITATIONS.length].question }, { user: `queue-${i + 1}@loadtest` }));
  const positions = [];
  for (const f of fillers) positions.push((await f.next("queued")).position);
  const full = await health();
  const over = await json("POST", "/api/ask", { user: "queue-over@loadtest", body: { question: CITATIONS[5].question } });
  limitChecks.fullQueue = { positions, depth: full.queue.depth, status: over.status, retryAfter: over.retryAfter, error: over.body?.error };
  check("a full queue → 429 with Retry-After", over.status === 429 && Number(over.retryAfter) > 0 && /busy/.test(over.body?.error ?? ""), `positions ${positions.join(", ")} · depth ${full.queue.depth} → ${over.status}, Retry-After ${over.retryAfter} s: ${over.body?.error}`);
  for (const f of fillers) f.abort();
  await Promise.all(fillers.map((f) => f.result));
  let depth = null;
  for (let i = 0; i < 40; i++) {
    depth = (await health()).queue.depth;
    if (depth === 0) break;
    await sleep(50);
  }
  limitChecks.leave = { depthAfter: depth };
  check("clients that leave the queue are removed", depth === 0, `${limits.queueMax} clients disconnected → queue depth ${depth}`);
}

// 429: the rate limit
{
  const user = "rate@loadtest";
  const admitted = [];
  for (let i = 0; i < limits.rateLimit; i++) {
    const r = open("/api/ask", { question: CITATIONS[i % CITATIONS.length].question }, { user });
    const first = await r.next("queued");
    admitted.push(first.type);
    r.abort();
    await r.result;
  }
  const over = await json("POST", "/api/ask", { user, body: { question: CITATIONS[0].question } });
  limitChecks.rate = { admitted: admitted.length, status: over.status, retryAfter: over.retryAfter, error: over.body?.error };
  check(
    `the ${limits.rateLimit + 1}th message in ${limits.rateWindowS / 60} min → 429 with Retry-After`,
    over.status === 429 && Number(over.retryAfter) > 0 && /You've sent/.test(over.body?.error ?? ""),
    `${admitted.filter((t) => t === "queued").length} admitted (left the queue), then ${over.status}, Retry-After ${over.retryAfter} s: ${over.body?.error}`,
  );
}

const anchorResult = await anchor.result;
limitChecks.anchor = { status: anchorResult.status, answerMs: anchorResult.answerMs };
log(`  the running request finished: ${anchorResult.status} in ${sec(anchorResult.answerMs)}`);

// 504, then the next request works
{
  const slow = await open("/api/ask", { question: CITATIONS[3].question }, { user: "timeout@loadtest", headers: { "x-request-timeout-ms": String(TIMEOUT_CHECK_MS) } }).result;
  const afterTimeout = await health();
  const next = await open("/api/ask", { question: CITATIONS[4].question }, { user: "after-timeout@loadtest" }).result;
  limitChecks.timeout = {
    deadlineMs: TIMEOUT_CHECK_MS,
    status: slow.status,
    error: slow.error,
    totalMs: slow.totalMs,
    runningAfter: afterTimeout.queue.running,
    next: { status: next.status, answerStatus: next.body?.status ?? null, queueMs: next.queueMs, answerMs: next.answerMs },
  };
  check("a timeout fails cleanly → 504", slow.status === 504 && /didn't finish/.test(slow.error ?? ""), `deadline ${sec(TIMEOUT_CHECK_MS)} → ${slow.status} after ${sec(slow.totalMs)}: ${slow.error}`);
  check("…and the next request works", next.status === 200, `${next.status} ${next.body?.status ?? ""} · waited ${sec(next.queueMs)} · answered in ${sec(next.answerMs)}`);
}

// Cross-user: user 2 can't read user 1's chat
{
  const owner = stability.find((s) => s.kind === "chat" && s.status === 200);
  if (!owner) {
    check("one user can't read another's conversation", false, "no chat from the stability run to try it on");
  } else {
    const other = users.find((u) => u !== owner.user);
    const mine = await json("GET", `/conversations/${owner.sessionId}`, { user: owner.user });
    const theirs = await json("GET", `/conversations/${owner.sessionId}`, { user: other });
    const theirList = await json("GET", "/conversations", { user: other });
    const listed = (theirList.body ?? []).some((c) => c.id === owner.sessionId);
    limitChecks.crossUser = { owner: owner.user, other, ownerMessages: mine.body?.messages?.length, otherMessages: theirs.body?.messages?.length, listedForOther: listed, fakeIdentities };
    check(
      "one user can't read another's conversation",
      fakeIdentities ? mine.body?.messages?.length > 0 && theirs.body?.messages?.length === 0 && !listed : null,
      fakeIdentities
        ? `${owner.user.split("@")[0]} sees ${mine.body?.messages?.length} messages; ${other.split("@")[0]} gets ${theirs.body?.messages?.length} and ${listed ? "DOES" : "doesn't"} see it in the list`
        : "skipped: through Tailscale Serve every request is yours",
    );
  }
}

// ---- 4. the end ---------------------------------------------------------------------------

const after = await health();
const outbound = after.outboundBlocked - outboundBefore;
check("/health is ok at the end", after.ok, `status ${after.status} · queue ${after.queue.depth} waiting, ${after.queue.running} running · up ${after.uptimeS} s`);
check("0 outbound non-localhost requests", outbound === 0, `the server's fetch guard refused ${outbound} during the run (${after.outboundBlocked} since it started)`);

const finishedAt = new Date();
const passed = checks.every((c) => c.pass !== false);
const host = magicDnsName();
const results = {
  ranAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  durationMs: finishedAt - startedAt,
  url: BASE,
  machine: `${os.cpus()[0]?.model ?? "?"}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM`,
  fakeIdentities,
  limits,
  passed,
  checks,
  isolation,
  stability: { summary: stabilitySummary, requests: stability },
  limitChecks,
  memory: { before: memoryOf(before), afterStability: memoryOf(afterStability), after: memoryOf(after) },
  outbound: { duringRun: outbound, sinceStart: after.outboundBlocked },
  healthAfter: after,
  magicDns: host,
};
fs.mkdirSync(REPORTS_DIR, { recursive: true });
fs.writeFileSync(REPORT_JSON, JSON.stringify(results, null, 2) + "\n");
fs.writeFileSync(REPORT_MD, renderReport(results));
log(`${passed ? "✓ PASS" : "✗ FAIL"} · ${checks.filter((c) => c.pass).length}/${checks.length} checks · wrote ${path.relative(process.cwd(), REPORT_MD)} and ${path.basename(REPORT_JSON)}`);
process.exit(passed ? 0 : 1);

// ---- the report ------------------------------------------------------------------------------

/** The machine's MagicDNS name, from the Tailscale CLI if it is installed here. */
function magicDnsName() {
  for (const cli of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const status = JSON.parse(execFileSync(cli, ["status", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }));
      const name = String(status.Self?.DNSName ?? "").replace(/\.$/, "");
      if (name) return name;
    } catch {
      // not this one
    }
  }
  return null;
}

function renderReport(r) {
  const s = r.stability.summary;
  const host = r.magicDns ?? "<machine>.<tailnet>.ts.net";
  const mem = (m) => `${m.loaded ? gb(m.sizeBytes) : "not loaded"}${m.loaded ? ` (${gb(m.vramBytes)} on GPU)` : ""} · server process ${gb(m.serverRssBytes)}`;
  const l = r.limitChecks;
  const lines = [
    "# The hosted service under load (Day 30)",
    "",
    `Generated ${r.finishedAt} by \`npm run load:local\` against \`${r.url}\` on ${r.machine}. Took ${sec(r.durationMs)}. Raw results: [\`hosted_load_results.json\`](hosted_load_results.json).`,
    "",
    `Server: \`npm run serve:local\` — the Knowledge chat alone, ${r.healthAfter.model.name} under Ollama ${r.healthAfter.ollama.version}, RAG + rerank, num_ctx ${r.healthAfter.model.numCtx}, prompts ${r.healthAfter.model.promptVariant}, bound to 127.0.0.1. Limits: ${r.limits.concurrency} request at the model at once, ${r.limits.queueMax} waiting, ${r.limits.rateLimit} messages / ${r.limits.rateWindowS / 60} min per user, ${r.limits.maxMessageChars} characters, ${r.limits.maxOutputTokens} output tokens, ${r.limits.requestTimeoutMs / 1000} s per request, ${r.limits.historyTurns} messages of history.`,
    "",
    r.fakeIdentities ? "" : "**Through Tailscale Serve:** the fake identity headers were replaced by the real tailnet identity, so the simulated users were one user (one rate limit, one list of chats) and the cross-user check was skipped.\n",
    `**Result: ${r.passed ? "PASS" : "FAIL"}** — ${r.checks.filter((c) => c.pass).length}/${r.checks.length} checks.`,
    "",
    "| check | result | detail |",
    "| --- | --- | --- |",
    ...r.checks.map((c) => `| ${c.name} | ${c.pass === null ? "skipped" : c.pass ? "✓" : "✗"} | ${String(c.detail).replace(/\|/g, "\\|")} |`),
    "",
    "## Stability",
    "",
    `${USERS} simulated users, each with its own \`Tailscale-User-Login\`, sent ${s.requests} questions from the \`citations\` set at the same moment: each user's first in a new chat (\`POST /chat\`: router, retrieval, rerank, answer), the rest through \`POST /api/ask\`. A 429 "server busy" was retried after its \`Retry-After\`.`,
    "",
    "| | |",
    "| --- | --- |",
    `| requests | ${s.requests} |`,
    `| succeeded (200) | ${s.succeeded} — ${s.answered} answered with citations, ${s.dontKnow} "I don't know" |`,
    `| 429 server busy (then retried) | ${s.busy429} |`,
    `| 429 rate limit | ${s.rate429} |`,
    `| timeouts (504) | ${s.timeouts} |`,
    `| other errors | ${s.errors} |`,
    `| queue wait p50 · p95 · max | ${sec(s.queueMs.p50)} · ${sec(s.queueMs.p95)} · ${sec(s.queueMs.max)} |`,
    `| answer latency p50 · p95 · max | ${sec(s.answerMs.p50)} · ${sec(s.answerMs.p95)} · ${sec(s.answerMs.max)} |`,
    `| possible truncations | ${s.possibleTruncations} |`,
    `| wall time for all of them | ${sec(s.wallMs)} |`,
    "",
    "Queue wait: from sending the attempt that got in until the server said `started` (a client refused with 429 first also spent its `Retry-After` before that). Answer latency: from `started` to the answer (a chat turn includes its router call).",
    "",
    "| user | route | question | status | answer | waited | answered in | 429 busy first |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...r.stability.requests.map((q) => `| ${q.user.split("@")[0]} | ${q.kind === "chat" ? "/chat" : "/api/ask"} | ${q.id} | ${q.status} | ${q.answerStatus ?? "—"}${q.citations ? ` (${q.citations} cit.)` : ""} | ${sec(q.queueMs)} | ${sec(q.answerMs)} | ${q.busy429 || ""} |`),
    "",
    "**Memory** (Ollama's `/api/ps`, through `/health`):",
    "",
    `- before: ${mem(r.memory.before)}`,
    `- after the stability run: ${mem(r.memory.afterStability)}`,
    `- at the end: ${mem(r.memory.after)}`,
    "",
    "## Limits",
    "",
    `- **Size:** a ${r.limits.maxMessageChars + 1}-character question → ${l.size?.status}: “${l.size?.error}”`,
    `- **One message per chat:** a second message while the first waited → ${l.sameChat?.status}: “${l.sameChat?.error}”`,
    `- **Full queue:** one running, ${r.limits.queueMax} waiting (positions ${l.fullQueue?.positions?.join(", ")}), one more → ${l.fullQueue?.status}, \`Retry-After: ${l.fullQueue?.retryAfter}\`: “${l.fullQueue?.error}”`,
    `- **Leaving the queue:** the ${r.limits.queueMax} waiting clients disconnected → queue depth ${l.leave?.depthAfter}; the running request still finished (${l.anchor?.status} in ${sec(l.anchor?.answerMs)}).`,
    `- **Rate limit:** ${l.rate?.admitted} messages admitted (each left the queue right after), the next → ${l.rate?.status}, \`Retry-After: ${l.rate?.retryAfter}\`: “${l.rate?.error}”`,
    `- **Timeout:** a request with a ${sec(l.timeout?.deadlineMs)} deadline (\`X-Request-Timeout-Ms\`, which can only shorten \`HOSTED_REQUEST_TIMEOUT_MS\`) → ${l.timeout?.status} after ${sec(l.timeout?.totalMs)}: “${l.timeout?.error}” Running right after: ${l.timeout?.runningAfter}. The next request → ${l.timeout?.next?.status} ${l.timeout?.next?.answerStatus ?? ""} in ${sec(l.timeout?.next?.answerMs)}.`,
    l.crossUser
      ? `- **Another user's chat:** ${l.crossUser.owner} has ${l.crossUser.ownerMessages} messages in it; ${l.crossUser.other} reading the same id gets ${l.crossUser.otherMessages}, and ${l.crossUser.listedForOther ? "**does**" : "doesn't"} see it in their list.`
      : "",
    "",
    "## Isolation",
    "",
    `Excluded routes (${r.isolation.filter((i) => i.status === 404).length}/${r.isolation.length} → 404): ${r.isolation.map((i) => `\`${i.method} ${i.url.replace(SAMPLE, ":id")}\` ${i.status}`).join(" · ")}.`,
    "",
    `Outbound non-localhost requests refused by the server's fetch guard: **${r.outbound.duringRun}** during the run (${r.outbound.sinceStart} since the server started).`,
    "",
    "## Network access (filled in by hand)",
    "",
    `The server listens on 127.0.0.1:3100 only; \`tailscale serve --bg 3100\` publishes it to the tailnet as **https://${host}**.`,
    "",
    "| check | how | result |",
    "| --- | --- | --- |",
    `| the page opens on my phone over Tailscale | phone on the tailnet → open https://${host} — the header shows my name | _fill in_ |`,
    `| the API answers from another tailnet device | \`curl -s https://${host}/api/ask -H 'content-type: application/json' -d '{"question":"Is Compose Multiplatform for iOS stable?"}'\` | _fill in_ |`,
    `| /health from another tailnet device | \`curl -s https://${host}/health\` | _fill in_ |`,
    `| a device that isn't on the tailnet can't connect | Tailscale off on the phone (mobile data): open https://${host}, or \`curl -m 10 https://${host}/health\` | _fill in_ |`,
    `| nothing listens on the LAN | from another machine on the same Wi-Fi: \`curl -m 5 http://<this Mac's LAN IP>:3100/health\` (connection refused) | _fill in_ |`,
    "",
  ];
  return lines.filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n");
}
