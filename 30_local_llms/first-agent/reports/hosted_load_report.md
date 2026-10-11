# The hosted service under load (Day 30)

Generated 2026-10-11T21:08:42.177Z by `npm run load:local` against `http://127.0.0.1:3100` on Apple M2, 16 GB RAM. Took 528.9 s. Raw results: [`hosted_load_results.json`](hosted_load_results.json).

Server: `npm run serve:local` — the Knowledge chat alone, qwen3.5:9b under Ollama 0.40.2, RAG + rerank, num_ctx 8192, prompts v1, bound to 127.0.0.1. Limits: 1 request at the model at once, 5 waiting, 10 messages / 10 min per user, 2000 characters, 1024 output tokens, 180 s per request, 6 messages of history.

**Result: PASS** — 12/12 checks.

| check | result | detail |
| --- | --- | --- |
| excluded routes are 404 | ✓ | 20/20 routes → 404 |
| stability: every question answered | ✓ | 12/12 → 200 (7 answered, 5 "I don't know") · 10× 429 busy (retried) · 0 timeouts · 0 errors · 459.3 s |
| a message over the size limit → 413 | ✓ | 413: Your question is 2001 characters long; this server takes at most 2000. Shorten it and send it again. |
| a second message in a chat that has one waiting → 409 | ✓ | 409: A message in this chat is still waiting for its answer. Send the next one once it's in. |
| a full queue → 429 with Retry-After | ✓ | positions 2, 3, 2, 4, 5 · depth 5 → 429, Retry-After 214 s: The server is busy: 1 request running and 5 waiting, the most it holds. Try again in about 4 min. |
| clients that leave the queue are removed | ✓ | 5 clients disconnected → queue depth 0 |
| the 11th message in 10 min → 429 with Retry-After | ✓ | 10 admitted (left the queue), then 429, Retry-After 599 s: You've sent 10 messages in the last 10 min, the most this server takes from one person. Try again in 10 min. |
| a timeout fails cleanly → 504 | ✓ | deadline 4.0 s → 504 after 4.0 s: The model didn't finish within 4 s, so this request was stopped and the next one started. Try again, or ask a shorter question. |
| …and the next request works | ✓ | 200 dont_know · waited 0.0 s · answered in 25.7 s |
| one user can't read another's conversation | ✓ | load-user-1 sees 2 messages; load-user-2 gets 0 and doesn't see it in the list |
| /health is ok at the end | ✓ | status ok · queue 0 waiting, 0 running · up 655 s |
| 0 outbound non-localhost requests | ✓ | the server's fetch guard refused 0 during the run (0 since it started) |

## Stability

5 simulated users, each with its own `Tailscale-User-Login`, sent 12 questions from the `citations` set at the same moment: each user's first in a new chat (`POST /chat`: router, retrieval, rerank, answer), the rest through `POST /api/ask`. A 429 "server busy" was retried after its `Retry-After`.

| | |
| --- | --- |
| requests | 12 |
| succeeded (200) | 12 — 7 answered with citations, 5 "I don't know" |
| 429 server busy (then retried) | 10 |
| 429 rate limit | 0 |
| timeouts (504) | 0 |
| other errors | 0 |
| queue wait p50 · p95 · max | 119.9 s · 225.3 s · 225.3 s |
| answer latency p50 · p95 · max | 37.7 s · 58.7 s · 58.7 s |
| possible truncations | 0 |
| wall time for all of them | 459.3 s |

Queue wait: from sending the attempt that got in until the server said `started` (a client refused with 429 first also spent its `Retry-After` before that). Answer latency: from `started` to the answer (a chat turn includes its router call).

| user | route | question | status | answer | waited | answered in | 429 busy first |
| --- | --- | --- | --- | --- | --- | --- | --- |
| load-user-1 | /chat | q02 | 200 | answered (2 cit.) | 0.0 s | 58.7 s |  |
| load-user-1 | /api/ask | q04 | 200 | answered (4 cit.) | 58.7 s | 44.3 s |  |
| load-user-1 | /api/ask | q06 | 200 | answered (1 cit.) | 103.1 s | 53.4 s |  |
| load-user-2 | /chat | q10 | 200 | dont_know | 156.5 s | 42.7 s |  |
| load-user-2 | /api/ask | q12 | 200 | dont_know | 199.3 s | 25.9 s |  |
| load-user-2 | /api/ask | q13 | 200 | dont_know | 225.3 s | 14.6 s |  |
| load-user-3 | /chat | q14 | 200 | dont_know | 119.9 s | 28.6 s | 1 |
| load-user-3 | /api/ask | q15 | 200 | answered (1 cit.) | 148.6 s | 30.1 s | 1 |
| load-user-4 | /chat | q16 | 200 | answered (4 cit.) | 58.6 s | 46.7 s | 2 |
| load-user-4 | /api/ask | q17 | 200 | dont_know | 105.4 s | 44.6 s | 2 |
| load-user-5 | /chat | q02 | 200 | answered (2 cit.) | 149.9 s | 31.5 s | 2 |
| load-user-5 | /api/ask | q04 | 200 | answered (4 cit.) | 181.5 s | 37.7 s | 2 |

**Memory** (Ollama's `/api/ps`, through `/health`):

- before: 8.38 GB (8.38 GB on GPU) · server process 0.04 GB
- after the stability run: 13.00 GB (13.00 GB on GPU) · server process 0.23 GB
- at the end: 13.26 GB (13.26 GB on GPU) · server process 0.43 GB

## Limits

- **Size:** a 2001-character question → 413: “Your question is 2001 characters long; this server takes at most 2000. Shorten it and send it again.”
- **One message per chat:** a second message while the first waited → 409: “A message in this chat is still waiting for its answer. Send the next one once it's in.”
- **Full queue:** one running, 5 waiting (positions 2, 3, 2, 4, 5), one more → 429, `Retry-After: 214`: “The server is busy: 1 request running and 5 waiting, the most it holds. Try again in about 4 min.”
- **Leaving the queue:** the 5 waiting clients disconnected → queue depth 0; the running request still finished (200 in 39.6 s).
- **Rate limit:** 10 messages admitted (each left the queue right after), the next → 429, `Retry-After: 599`: “You've sent 10 messages in the last 10 min, the most this server takes from one person. Try again in 10 min.”
- **Timeout:** a request with a 4.0 s deadline (`X-Request-Timeout-Ms`, which can only shorten `HOSTED_REQUEST_TIMEOUT_MS`) → 504 after 4.0 s: “The model didn't finish within 4 s, so this request was stopped and the next one started. Try again, or ask a shorter question.” Running right after: 0. The next request → 200 dont_know in 25.7 s.
- **Another user's chat:** load-user-1@loadtest has 2 messages in it; load-user-2@loadtest reading the same id gets 0, and doesn't see it in their list.

## Isolation

Excluded routes (20/20 → 404): `GET /rag-report` 404 · `GET /rag-report/data` 404 · `GET /rag/status` 404 · `POST /rag/compare` 404 · `PUT /conversations/:id/rag` 404 · `PUT /conversations/:id/llm` 404 · `POST /conversations/:id/fork` 404 · `GET /conversations/:id/usage` 404 · `GET /conversations/:id/pipeline` 404 · `POST /conversations/:id/pipeline/run` 404 · `GET /conversations/:id/runs` 404 · `POST /conversations/:id/memory/finish-task` 404 · `GET /mcp/servers` 404 · `POST /mcp/notion/connect` 404 · `GET /mcp/oauth/callback` 404 · `GET /local/status` 404 · `GET /agents` 404 · `GET /profiles` 404 · `GET /projects` 404 · `POST /reset` 404.

Outbound non-localhost requests refused by the server's fetch guard: **0** during the run (0 since the server started).

## Network access (filled in by hand)

The server listens on 127.0.0.1:3100 only; `tailscale serve --bg 3100` publishes it to the tailnet as **https://michaels-macbook-air.tail10a1c4.ts.net**.

| check | how | result |
| --- | --- | --- |
| the page opens on my phone over Tailscale | phone on the tailnet → open https://michaels-macbook-air.tail10a1c4.ts.net — the header shows my name | _fill in_ |
| the API answers from another tailnet device | `curl -s https://michaels-macbook-air.tail10a1c4.ts.net/api/ask -H 'content-type: application/json' -d '{"question":"Is Compose Multiplatform for iOS stable?"}'` | _fill in_ |
| /health from another tailnet device | `curl -s https://michaels-macbook-air.tail10a1c4.ts.net/health` | _fill in_ |
| a device that isn't on the tailnet can't connect | Tailscale off on the phone (mobile data): open https://michaels-macbook-air.tail10a1c4.ts.net, or `curl -m 10 https://michaels-macbook-air.tail10a1c4.ts.net/health` | _fill in_ |
| nothing listens on the LAN | from another machine on the same Wi-Fi: `curl -m 5 http://<this Mac's LAN IP>:3100/health` (connection refused) | _fill in_ |
