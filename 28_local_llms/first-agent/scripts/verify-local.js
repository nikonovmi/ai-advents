/**
 * **`npm run verify:local` — proof that the app runs without the cloud (Day 27).**
 *
 * Starts the app's real routes in-process (`createApp`) with an in-memory
 * store, no `ANTHROPIC_API_KEY`, and a `fetch` guard that records — and fails
 * — any request to a host other than localhost. Then, for each local model and
 * each agent that supports one, it holds a short conversation through the real
 * `POST /chat`: three messages, the second only meaningful after the first, the
 * third asking for facts from the first. Every reply must come from the local
 * provider, be non-empty, and the last must use the earlier context.
 *
 * Writes `reports/day27_verify.md` (and `.json`). Exit code 1 on any failed
 * check or any outbound non-localhost request.
 *
 *   npm run verify:local
 *   npm run verify:local -- --model qwen3.5:9b
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import dotenv from "dotenv";

const ROOT = path.join(import.meta.dirname, "..");
const REPORT_MD = path.join(ROOT, "reports", "day27_verify.md");
const REPORT_JSON = path.join(ROOT, "reports", "day27_verify.json");

// ---- 1. No key, and only the local settings from .env ----------------------
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_WORKSPACE_ID;
const envFile = path.join(ROOT, ".env");
const fromFile = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const env = Object.fromEntries(Object.entries({ ...fromFile, ...process.env }).filter(([key]) => /^(OLLAMA_|LOCAL_)/.test(key)));
delete env.ANTHROPIC_API_KEY;
// Only the MCP servers on this machine, too.
env.OFFLINE = "1";

// ---- 2. The fetch guard, installed before anything is imported --------------
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const outbound = [];
let localRequests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    outbound.push({ url: `${url.protocol}//${url.host}${url.pathname}`, at: new Date().toISOString() });
    throw new Error(`verify:local blocked a request to ${url.host}: only localhost is allowed`);
  }
  localRequests += 1;
  return realFetch(input, init);
};

const { createApp } = await import("../src/app.js");
const { MemoryStore } = await import("../src/store/memoryStore.js");
const { MemoryProfileStore } = await import("../src/store/profileStore.js");
const { MemoryInvariantStore } = await import("../src/store/invariantStore.js");
const { loadOllamaModule } = await import("../src/llm/ollama.js");

// ---- 3. The conversations ---------------------------------------------------
const CONVERSATIONS = [
  {
    agent: "first-agent",
    label: "first-agent (memory chat)",
    body: {},
    turns: [
      "Hi! I'm Mira, and I'm planning a five-day trip to Lisbon in May.",
      "Suggest two neighbourhoods to stay in there, one line each.",
      "Remind me: what's my name, which city am I visiting, and for how many days?",
    ],
    // The last reply must carry facts only the first message gave.
    recall: [/\bmira\b/i, /lisbon/i, /\b(five|5)\b/i],
  },
  {
    agent: "knowledge",
    label: "Knowledge, Without RAG",
    body: { ragMode: "plain" },
    turns: [
      "I'm building a Kotlin Multiplatform app called Tidepool that targets Android and iOS.",
      "Which library would you use for HTTP networking in it? One short paragraph.",
      "What's my app called, and which two platforms does it target?",
    ],
    recall: [/tidepool/i, /android/i, /\bios\b/i],
  },
];

const args = process.argv.slice(2);
const onlyModel = args.includes("--model") ? args[args.indexOf("--model") + 1] : null;

const store = new MemoryStore();
const { app, llms } = await createApp({ env, store, profileStore: new MemoryProfileStore(), invariantStore: new MemoryInvariantStore() });
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const status = (await call("GET", "/local/status")).body;
if (!status.reachable) {
  console.error(`✗ ${status.error}`);
  server.close();
  process.exit(1);
}
const models = onlyModel ? [onlyModel] : status.models.filter((m) => m.installed).map((m) => m.name);
const missing = status.models.filter((m) => !m.installed).map((m) => m.name);
if (!models.length) {
  console.error(`✗ No local model is installed. Pull one: ollama pull ${missing[0] ?? "qwen3.5:9b"}`);
  server.close();
  process.exit(1);
}
console.log(`Ollama ${status.version} at ${status.url} · models: ${models.join(", ")} · num_ctx ${status.numCtx} · no ANTHROPIC_API_KEY`);

const { createOllama } = await loadOllamaModule(llms.settings.dir);
const ollama = createOllama({ url: llms.settings.url, timeoutMs: llms.settings.timeoutMs });

const results = [];
for (const model of models) {
  const llm = `local:${model}`;
  const outboundBefore = outbound.length;
  // Unload everything else, then warm this model up (not counted), so the
  // numbers are a warm model's and the load is reported on its own.
  for (const loaded of await ollama.running()) if ((loaded.name ?? loaded.model) !== model) await ollama.unload(loaded.name ?? loaded.model);
  process.stdout.write(`\n${model}: warm-up… `);
  const warm = await ollama.chat({ model, messages: [{ role: "user", content: "Say OK." }], num_predict: 4, num_ctx: llms.settings.numCtx, think: false });
  console.log(`load ${(warm.metrics.load_ms / 1000).toFixed(2)} s`);

  const conversations = [];
  for (const conv of CONVERSATIONS) {
    const sessionId = crypto.randomUUID();
    const turns = [];
    for (const [i, message] of conv.turns.entries()) {
      process.stdout.write(`  ${conv.agent} ${i + 1}/${conv.turns.length}… `);
      const startedAt = Date.now();
      const res = await call("POST", "/chat", { message, sessionId, agent: conv.agent, llm, ...conv.body });
      const ms = Date.now() - startedAt;
      const meta = res.body.meta ?? {};
      const reply = res.body.reply ?? "";
      const checks = {
        ok: res.status === 200,
        local: meta.provider === "local" && meta.model === model,
        nonEmpty: reply.trim().length > 0,
        ...(i === conv.turns.length - 1 ? { context: conv.recall.every((re) => re.test(reply)) } : {}),
      };
      turns.push({ message, status: res.status, reply: reply || res.body.error || "", provider: meta.provider ?? null, model: meta.model ?? null, turnMs: ms, metrics: meta.localMetrics ?? null, overheadCalls: meta.strategy?.overheadCalls ?? 0, checks });
      console.log(`${Object.values(checks).every(Boolean) ? "✓" : "✗"} ${(ms / 1000).toFixed(1)} s`);
    }
    // The stored record says the same thing: a local chat, local replies.
    const record = await store.load(sessionId);
    conversations.push({
      agent: conv.agent,
      label: conv.label,
      recall: conv.recall.map(String),
      storedLlm: record?.llm ?? null,
      storedLocalReplies: (record?.messages ?? []).filter((m) => m.role === "assistant" && m.provider === "local").length,
      turns,
    });
  }
  await ollama.unload(model);
  results.push({ model, loadMs: warm.metrics.load_ms, conversations, outbound: outbound.slice(outboundBefore) });
}
server.close();

// ---- 4. Summary and report ---------------------------------------------------
const mean = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const summary = results.map(({ model, loadMs, conversations, outbound: out }) => {
  const turns = conversations.flatMap((c) => c.turns);
  const checks = turns.flatMap((t) => Object.values(t.checks));
  return {
    model,
    loadMs,
    turns: turns.length,
    checksPassed: checks.filter(Boolean).length,
    checks: checks.length,
    contextOk: conversations.filter((c) => c.turns.at(-1).checks.context).length,
    conversations: conversations.length,
    meanTtftMs: mean(turns.map((t) => t.metrics?.ttftMs)),
    meanGenTps: mean(turns.map((t) => t.metrics?.genTps)),
    meanModelMs: mean(turns.map((t) => t.metrics?.totalMs)),
    meanTurnMs: mean(turns.map((t) => t.turnMs)),
    outbound: out.length,
  };
});
const passed = summary.every((s) => s.checksPassed === s.checks) && outbound.length === 0 && results.every((r) => r.conversations.every((c) => c.storedLlm === `local:${r.model}` && c.storedLocalReplies === c.turns.length));

const sec = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(2)} s`);
const num = (x, d = 1) => (x == null ? "—" : x.toFixed(d));
const fence = (text) => "````text\n" + String(text).trim() + "\n````";
const when = new Date();
const lines = [
  "# Day 27 — verify:local",
  "",
  `Run ${when.toISOString().slice(0, 16).replace("T", " ")} UTC on ${os.cpus()[0]?.model ?? os.arch()}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM; Ollama ${status.version} at ${status.url}.`,
  `The app's routes ran in-process (\`createApp\`) with an in-memory store, **no ANTHROPIC_API_KEY**, and a fetch guard on every non-localhost host. num_ctx ${llms.settings.numCtx}, num_predict ≤ ${llms.settings.numPredict}, think false. Each model was warmed up (not counted) and unloaded after.`,
  "",
  `**Result: ${passed ? "PASS" : "FAIL"}** · outbound non-localhost requests: **${outbound.length}** · localhost requests: ${localRequests}`,
  "",
  "## Per model",
  "",
  "| model | checks | context kept | mean TTFT | mean generation | mean model latency | mean turn latency | cold load | outbound non-localhost |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...summary.map((s) => `| \`${s.model}\` | ${s.checksPassed}/${s.checks} | ${s.contextOk}/${s.conversations} | ${sec(s.meanTtftMs)} | ${num(s.meanGenTps)} tok/s | ${sec(s.meanModelMs)} | ${sec(s.meanTurnMs)} | ${sec(s.loadMs)} | ${s.outbound} |`),
  "",
  "TTFT ≈ load + prompt evaluation (Ollama's timings; the call is non-streaming). Model latency = Ollama's `total_duration` for the reply call. Turn latency = the whole `POST /chat`, which for first-agent also includes the memory extractor's call (and a digest fold when one is due), all on the same local model.",
  "",
  "Checks per reply: HTTP 200, `provider: local` with the expected model, non-empty. On the last message of each conversation, also: the reply contains the facts from the first message.",
  "",
];
for (const r of results) {
  lines.push(`## \`${r.model}\``, "");
  for (const c of r.conversations) {
    lines.push(`### ${c.label}`, "", `Stored on the record: \`llm: ${c.storedLlm}\`, ${c.storedLocalReplies}/${c.turns.length} replies with \`provider: local\`. Context check: ${c.recall.join(", ")}.`, "");
    for (const [i, t] of c.turns.entries()) {
      const m = t.metrics ?? {};
      const failed = Object.entries(t.checks).filter(([, ok]) => !ok).map(([k]) => k);
      lines.push(
        `**${i + 1}. User:** ${t.message}`,
        "",
        fence(t.reply),
        "",
        `${failed.length ? `✗ failed: ${failed.join(", ")}` : "✓"} · ${t.provider ?? "?"} · \`${t.model ?? "?"}\` · TTFT ${sec(m.ttftMs)} · ${num(m.genTps)} tok/s · model ${sec(m.totalMs)} · turn ${sec(t.turnMs)} · ${m.promptTokens ?? "?"} prompt / ${m.outputTokens ?? "?"} output tokens${t.overheadCalls ? ` · +${t.overheadCalls} memory call(s)` : ""}`,
        "",
      );
    }
  }
  if (r.outbound.length) lines.push("Blocked outbound requests:", "", ...r.outbound.map((o) => `- ${o.url} (${o.at})`), "");
}
fs.mkdirSync(path.dirname(REPORT_MD), { recursive: true });
fs.writeFileSync(REPORT_MD, lines.join("\n"));
fs.writeFileSync(REPORT_JSON, JSON.stringify({ ranAt: when.toISOString(), ollama: { version: status.version, url: status.url }, settings: llms.settings, passed, outbound, localRequests, summary, results }, null, 2) + "\n");

console.log("");
for (const s of summary) {
  console.log(`${s.model}: ${s.checksPassed}/${s.checks} checks · TTFT ${sec(s.meanTtftMs)} · ${num(s.meanGenTps)} tok/s · model ${sec(s.meanModelMs)} · turn ${sec(s.meanTurnMs)} · outbound ${s.outbound}`);
}
console.log(`\n${passed ? "✓ PASS" : "✗ FAIL"} · outbound non-localhost requests: ${outbound.length} · wrote ${path.relative(ROOT, REPORT_MD)}`);
process.exit(passed ? 0 : 1);
