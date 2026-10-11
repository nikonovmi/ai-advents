/**
 * **`npm run serve:local` — the Knowledge chat as a private service (Day 30).**
 *
 * Its own server, not the full app with pages hidden (`src/hosted/app.js` has
 * the list of what is mounted; everything else is a 404). It listens on
 * **127.0.0.1 only**: the one way in from the network is Tailscale Serve,
 * which is also what makes the identity headers trustworthy
 * (`src/hosted/identity.js`). The full app (`npm start`, port 3000) is not
 * involved and is never exposed.
 *
 *   1. `.env` is read, then `ANTHROPIC_API_KEY` is dropped: no Claude here.
 *   2. Day 27's fetch guard goes on before anything else is imported: a
 *      request to any host other than localhost is refused and logged.
 *   3. Warm-up: the embedding model, the index, the reranker and qwen3.5:9b at
 *      num_ctx 8192 are loaded before "ready", so the first user doesn't wait for them.
 *   4. SIGINT / SIGTERM: stop taking requests, reject the waiting ones (503),
 *      let the running one finish, close. Nothing is unloaded.
 *
 * `npm run serve:local` runs this under `caffeinate -is`, so the Mac doesn't
 * sleep while it serves (keep the lid open and the charger in).
 */

import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { installFetchGuard } from "./llm/fetchGuard.js";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_WORKSPACE_ID;

const guard = installFetchGuard({ name: "hosted", log: (line) => console.warn(line) });

const { createHostedApp } = await import("./hosted/app.js");

const HOST = "127.0.0.1";
const hosted = createHostedApp({ outboundBlocked: () => guard.outbound.length });
const { app, queue, settings, warmUp } = hosted;

console.log(`[hosted] warming up: embeddings, index, reranker, qwen3.5:9b at num_ctx ${hosted.llms.settings.ragNumCtx}…`);
const warm = await warmUp();
if (warm.error) console.warn(`[hosted] ⚠ warm-up failed after ${(warm.ms / 1000).toFixed(1)} s: ${warm.error}\n          The server starts anyway; /health says what is down.`);
else console.log(`[hosted] warm-up done in ${(warm.ms / 1000).toFixed(1)} s`);

const server = app.listen(settings.port, HOST, () => {
  console.log(
    `[hosted] ready on http://${HOST}:${settings.port} — the Knowledge chat only, qwen3.5:9b, RAG + rerank, num_ctx ${hosted.llms.settings.ragNumCtx}\n` +
      `         limits: ${settings.concurrency} at a time, queue ${settings.queueMax}, ${settings.rateLimit} messages / ${Math.round(settings.rateWindowMs / 60000)} min per user, ` +
      `${settings.maxMessageChars} chars, ${settings.maxOutputTokens} output tokens, ${settings.requestTimeoutMs / 1000} s per request\n` +
      `         reachable from the tailnet only through: tailscale serve --bg ${settings.port}`,
  );
});
// A queued request can wait minutes; the socket must not time out under it.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[hosted] ${signal}: no new requests; rejecting ${queue.depth} waiting, finishing ${queue.running} running…`);
  server.close();
  await queue.drain();
  console.log("[hosted] stopped (models left loaded).");
  // Let the last answer flush before the process goes.
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
