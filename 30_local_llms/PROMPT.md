# Day 30 — Local LLM as a private service

Day 30 of my AI challenge: deploy the local LLM as a private service, with an HTTP API and
chat. Then check:
- that the model is reachable over the network,
- that it stays stable under multiple requests,
- that basic limits work: rate limits and max context.

**Setup decisions (already made):**
- **Server:** my MacBook Air M2 (16 GB) is the home server, running `qwen3.5:9b` via Ollama
  with the Day 29 settings.
- **Network and sign-in:** Tailscale. Only devices on my tailnet can reach the service, and
  Tailscale is the sign-in. No login code in the app.
- **What's exposed:** only the Knowledge agent (local RAG chat), on its own page. There are no
  other agents, no eval results or stats, no Notion and no MCP servers, and no Claude.

Before writing code, read how first-agent builds its Express app, the Knowledge chat routes
(`POST /chat`, conversations, task memory), the frontend for the Knowledge agent, and the
Day 27–29 local provider settings.

## 1. A separate hosted server, not a hidden page

Hiding the other agents in the UI is not enough. If the full app is reachable, anyone on the
tailnet can call `/rag-report`, the pipeline routes or the Notion OAuth routes directly. So
the hosted service is **its own entry point**:

- `npm run serve:local` starts `src/hosted.js` on `HOSTED_PORT` (default 3100), bound to
  **127.0.0.1 only**. Tailscale Serve is the only way in from the network. The full app
  (`npm start`, port 3000) is unchanged and is never exposed.
- It mounts **only**:
  - the hosted page;
  - the Knowledge chat routes (the user's own conversations: create, list, delete, send a
    message, reset task memory);
  - `GET /health`;
  - the API routes below.

  Everything else returns 404. That includes `/rag-report`, Compare, `/rag/*` settings,
  pipelines, runs, MCP and Notion OAuth, and the other agents.
- **No MCP clients are created** (no Notion, OMDb or scheduler), and Notion tokens are never
  read.
- **No Claude.** The hosted server ignores `ANTHROPIC_API_KEY` and only uses the Ollama
  provider. Reuse Day 27's fetch guard in hosted mode: any outbound request to a host other
  than localhost is refused and logged.
- **Fixed configuration:** RAG on, rerank on, qwen3.5:9b, Day 29's adopted `num_ctx` and
  prompt variant. There are no model, RAG or rerank switches.

## 2. The hosted page

Reuse the existing Knowledge chat frontend with a hosted flag. Don't fork it.

- **Keep:** the chat list, the messages, citation chips with their quotes, sources,
  "I don't know" with its clarifying question, the task memory panel and its Reset button.
- **Remove:** the agent picker, the model, RAG and rerank switches, Compare, the "Eval
  results" link, and metric hovers or debug details (route badges, rerank scores, dropped
  candidates).
- **Add:** a queue status while a message waits ("waiting, position 2") and then
  "generating…" with elapsed time, plus readable messages when a limit is hit.
- Show the signed-in user's name in the header.

## 3. Identity

Tailscale Serve adds the tailnet user's identity to proxied requests. Check the exact header
names with the installed Tailscale version; it's `Tailscale-User-Login` and related headers.

- These headers are trusted only because the server listens on 127.0.0.1, so only Tailscale
  Serve can reach it. Say this in a code comment.
- Conversations are scoped to the user's login. A user only sees and changes their own chats.
- If the header is missing (a local request, or a device shared with a tagged identity), use
  `local` as the user. This is not an error.

## 4. HTTP API

The page's chat routes are the conversation API. In addition:

- `POST /api/ask { question }`: a stateless one-shot question through the full local RAG
  pipeline. It returns `{ status, answer, citations, sources, clarifying_question, timings }`.
- `GET /health`: whether Ollama is reachable, the model and whether it's loaded, whether the
  index is OK, whether the reranker is loaded, the queue depth and running count, and uptime.

Everything goes through the same queue and limits.

## 5. Limits

All are set by env, in `.env.example`, with these defaults:

| limit | default | when exceeded |
| --- | --- | --- |
| `HOSTED_CONCURRENCY` | 1 | requests at the model at once; the rest wait in the queue |
| `HOSTED_QUEUE_MAX` | 5 | 429 "server busy" with `Retry-After` |
| `HOSTED_RATE_LIMIT` | 10 messages / 10 min per user | 429 with `Retry-After` |
| `HOSTED_MAX_MESSAGE_CHARS` | 2000 | 413 with a readable message |
| history | `RAG_HISTORY_TURNS` (6) | older messages aren't sent |
| context | Day 29's `num_ctx` | `possible_truncation` is logged |
| `HOSTED_MAX_OUTPUT_TOKENS` | 1024 | — |
| `HOSTED_REQUEST_TIMEOUT_MS` | 180000 | the request fails with a readable error; the queue moves on |

Other rules:
- A request that leaves the queue (the client disconnects) is removed and doesn't block
  others.
- One user can't hold more than one running or queued message per conversation.

## 6. Running it as a service

- **Warm-up on start:** load qwen, the embedding model and the reranker before saying
  "ready", so the first user doesn't pay for loading.
- **Keep the Mac awake:** `serve:local` runs under `caffeinate` (system and idle sleep off
  while it runs). The README says to keep the lid open and the charger connected.
- **Tailscale:** README steps to expose port 3100 with `tailscale serve` over HTTPS (check
  the current CLI syntax with `tailscale serve --help`), the resulting MagicDNS URL, how to
  stop serving, and how to share the machine with another tailnet user if I want to.
- Graceful shutdown: finish the running request, reject queued ones with 503, unload nothing.

## 7. Verification

**`npm run load:local [-- --url https://<machine>.<tailnet>.ts.net]`** runs against the
hosted server (default http://127.0.0.1:3100) and writes `reports/hosted_load_report.md`
and `hosted_load_results.json`:

- **Stability:** 5 simulated users with different fake identities in the header. Each sends
  2–3 questions from the citations set, all at once. Report successes, 429s, timeouts and
  errors; queue wait and answer latency (p50, p95, max); memory from `/api/ps` before and
  after; and that `/health` is still OK at the end.
- **Limits, one check each:** a message over the size limit returns 413; a user over the
  rate limit gets 429 with `Retry-After`; a full queue gives 429; a timeout fails cleanly and
  the next request still works; one user can't read another user's conversation.
- **Isolation:** the excluded routes return 404 (`/rag-report`, pipeline, MCP and Notion
  routes, other agents), and the run made 0 outbound non-localhost requests.
- **Network access:** a section I fill in by hand. Open the page from my phone over
  Tailscale, run a `curl` of `/api/ask` from another tailnet device, and confirm a device
  that isn't on the tailnet can't connect. The report prints the commands to run.

Keep the load test light. It's 1 model on 1 laptop, so it shows that the queue and limits
work, not throughput. It should finish in about 10–15 minutes.

## Tests

`npm test` stays offline, with a fake Ollama. Test that:
- the hosted app mounts only the allowed routes, and everything else is 404;
- no MCP client is created, and Anthropic is never called;
- conversations are scoped by the identity header, with `local` as the fallback;
- queue order, the queue max and removal on disconnect work;
- the rate limit and `Retry-After` work;
- the message size limit and the timeout work;
- `/health` has the expected shape.

## Docs

- first-agent README: a **Hosted service (Day 30)** section covering `serve:local`, what is
  and isn't exposed and why it's a separate server, Tailscale setup, the API with curl
  examples, the limits table, and `load:local`.
- Repo root README: a "Day 30 — Local LLM as a private service" section at the top, like the
  previous days. Two or three sentences, the load-test summary with real numbers, and links.

## Finish

1. Run `npm test`.
2. Start `npm run serve:local`, then run `npm run load:local` against 127.0.0.1, and fix
   anything that fails.
3. Show me the load-test summary.
4. Give me the exact Tailscale commands to expose it, and leave the hosted server running so
   I can open it from my phone.
