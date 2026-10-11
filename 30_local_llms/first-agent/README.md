# first-agent

A chat app with layered memory, a task lifecycle, MCP tools, planned pipelines, and a
**Knowledge** agent that answers with or without RAG over [`../doc_index`](../doc_index).
Node + Express, vanilla front end, no build step.

```bash
npm install
echo 'ANTHROPIC_API_KEY=sk-ant-…' > .env    # omit to run without the cloud (local models, Day 27)
npm start                                   # http://localhost:3000
```

The Knowledge agent also needs a built index: `cd ../doc_index && npm install && npm run index`.

| script | does |
| --- | --- |
| `npm test` | offline tests: no key, no network (Ollama is a fake `fetch`) |
| `npm run start:offline` | Day 27: `OFFLINE=1 HOST=127.0.0.1`: loopback only, Claude off, no remote MCP servers |
| `npm run verify:local [-- --model qwen3.5:9b]` | Day 27: the real routes in-process, no key, a fetch guard on every non-localhost host; a 3-message conversation per agent and local model → [`reports/day27_verify.md`](reports/day27_verify.md), `reports/day27_verify.json`; needs Ollama running |
| `npm run serve:local` | Day 30: [the hosted service](#hosted-service-day-30) — the Knowledge chat alone on 127.0.0.1:3100, for Tailscale Serve; runs under `caffeinate` |
| `npm run load:local [-- --url https://<machine>.<tailnet>.ts.net]` | Day 30: stability, limits and isolation checks against the running hosted server → [`reports/hosted_load_report.md`](reports/hosted_load_report.md), `reports/hosted_load_results.json` |
| `npm run eval:planner [-- <goal id>]` | plans 8 goals with the real model; exit 1 on a wrong tool sequence |
| `npm run eval:rag [-- q03] [-- --modes rag,rag+rerank]` | 17 questions × 4 modes (`plain`, `rag`, `rag+rerank`, `rag+rewrite+rerank`), judged blind → [`reports/rag_comparison.md`](reports/rag_comparison.md), `reports/rag_results.json`; needs the key and a built `../doc_index` |
| `npm run eval:citations [-- --mode rag] [-- q17]` | the 10 `citations` questions in one mode (default `rag+rerank`): sources, citations, fabricated quotes, faithfulness judge, "I don't know" → [`reports/citations_report.md`](reports/citations_report.md), `reports/citations_results.json`; `--report` re-renders with `reports/citations_notes.md` |
| `npm run eval:chat [-- scenario-1] [-- --check] [-- --report]` | Day 25: replays the two scripted conversations in [`eval/chat/`](eval/chat) through `POST /chat` with the real router, model, index and reranker; per-turn checks and judges → [`reports/chat_report.md`](reports/chat_report.md), `reports/chat_results.json`, with the hand-written [`reports/chat_notes.md`](reports/chat_notes.md); `--check` validates the scenario files only |
| `npm run eval:rag -- --check` / `--report` | only validate [`eval/rag/questions.json`](eval/rag/questions.json) against the index (and write `questions.md`) / only re-render the report with `reports/rag_notes.md` |
| `npm run mcp:tools [-- omdb]` | list one MCP server's tools |
| `npm run mcp:call -- omdb get_movie '{"title":"Inception"}'` | call one MCP tool directly |
| `npm run lifecycle` / `scenario` / `compare` | memory and task-lifecycle demos |

## Agents

Defined in `src/agents.js`; each has its own chat list.

- **first-agent**, **pirate support**: plain chat with memory (short-term, digest,
  working task, long-term profile, project invariants) and the
  `planning → execution → validation → done` lifecycle.
- **Movie buff**: chat that calls the OMDb tools.
- **Pipeline** (`claude-sonnet-5`): each chat is one pipeline. Read-only feed of runs.
- **Knowledge**: a multi-turn chat over the [`../doc_index`](../doc_index) vector index
  (Day 25, [below](#chat-with-task-memory-day-25)), with a **With RAG / Without RAG** switch in
  the header and, while RAG is on, a **Rerank** switch (on by default; stored per chat, sent
  with each message). With RAG, every message goes through a router and the chat keeps a small
  **task memory** (goal, clarified details, constraints, open questions) shown in the side
  panel; Without RAG it is Day 22's plain answer with the last 6 messages. No digest,
  profile, invariants or lifecycle.
  Each reply has a mode badge (`rag`, `rag+rerank`, `rag+rewrite+rerank`, …); a RAG reply
  lists its **Sources** (`[n]` vector score → rerank score · source · section, click for
  the chunk text), the queries searched when rewritten, and the dropped candidates
  (greyed, collapsed). A reply declined by the cutoff shows the best rejected chunks. **Compare** asks one question both ways side by
  side. **Eval results** opens http://localhost:3000/rag-report. Works without any MCP
  server running.

## Hosted service (Day 30)

The Knowledge chat as a private service on this MacBook Air: qwen3.5:9b under Ollama, the local
RAG pipeline, reached from my phone and other devices over Tailscale. Tailscale is the network
and the sign-in; there is no login code in the app.

```bash
npm run serve:local        # http://127.0.0.1:3100, then: tailscale serve --bg 3100
```

**A separate server, not a hidden page.** Hiding the other agents in the UI would leave
`/rag-report`, the pipeline routes and the Notion OAuth routes one `curl` away for anyone on the
tailnet. So `serve:local` starts its own entry point, [`src/hosted.js`](src/hosted.js)
([`src/hosted/app.js`](src/hosted/app.js)), which mounts only:

- `GET /` — the same `public/index.html`, served with `<html data-hosted="1">`, plus the scripts it imports;
- the user's own Knowledge chats — `GET /conversations`, `POST /conversations`, `GET` / `DELETE /conversations/:id`,
  `DELETE /conversations/:id/task-memory` (Reset), `POST /chat`;
- `POST /api/ask`, `GET /api/me`, `GET /health`.

Everything else is a 404: `/rag-report`, Compare, `/rag/*`, pipelines and runs, MCP and Notion
OAuth, the other agents, profiles, projects, `/local/status`. It binds to **127.0.0.1 only**, so
Tailscale Serve is the only way in from the network; the full app (`npm start`, port 3000) is
unchanged and never exposed. No MCP client is created (the hosted module graph never imports
`src/mcp/`, which a test checks) and Notion tokens are never read. `ANTHROPIC_API_KEY` is
dropped at startup; the only provider is Ollama, and Day 27's fetch guard
([`src/llm/fetchGuard.js`](src/llm/fetchGuard.js), shared with `verify:local`) refuses and logs
any request to a host other than localhost (`/health` counts them). The configuration is fixed:
RAG and rerank on, qwen3.5:9b, num_ctx 8192 on every call and the v1 prompts (Day 29's adopted
settings), `keep_alive` 60 m. There are no switches to change it.

**The page** is the Knowledge chat frontend with the hosted flag, not a fork: the chat list,
messages, citation chips with their quotes, sources, "I don't know" with its clarifying
question, and the task memory panel with Reset stay; the agent picker, the Model / RAG / Rerank
switches, Compare, the Eval results link, the cost chart and the debug detail (route badges,
rerank scores, dropped candidates, metric hovers) go. While a message waits it shows "waiting,
position 2", then "generating… 12 s"; a limit shows as a sentence. The header shows the signed-in
user.

**Identity.** Tailscale Serve (1.104 here) adds `Tailscale-User-Login`, `Tailscale-User-Name`
(RFC 2047-encoded when not ASCII) and `Tailscale-User-Profile-Pic` to every proxied request from a
user's device. They are trusted **only because the server listens on 127.0.0.1**
([`src/hosted/identity.js`](src/hosted/identity.js) says so). Each login gets its own conversation
directory (`data/hosted/<login>-<hash>/`, git-ignored), so a user only ever lists, reads, changes
or deletes their own chats; another user's id reads as an empty chat. No header (a request from
this Mac, or a tagged device) is the user `local`.

### Limits

Every message, a chat turn or an `/api/ask`, goes through one queue and one per-user rate limit
([`src/hosted/queue.js`](src/hosted/queue.js), [`rateLimit.js`](src/hosted/rateLimit.js)). All
are env settings, in `.env.example`:

| limit | default | when exceeded |
| --- | --- | --- |
| `HOSTED_CONCURRENCY` | 1 | requests at the model at once; the rest wait in the queue (FIFO) |
| `HOSTED_QUEUE_MAX` | 5 | 429 "server busy" with `Retry-After` (the work ahead at the recent pace) |
| `HOSTED_RATE_LIMIT` | `10/10m` (10 messages per 10 min per user) | 429 with `Retry-After` |
| `HOSTED_MAX_MESSAGE_CHARS` | 2000 | 413 with a readable message |
| history | `RAG_HISTORY_TURNS` (6) | older messages aren't sent |
| context | num_ctx 8192 (Day 29) | `possible_truncation` is logged |
| `HOSTED_MAX_OUTPUT_TOKENS` | 1024 | every model call's output ceiling |
| `HOSTED_REQUEST_TIMEOUT_MS` | 180000 | from when it starts running: 504 with a readable error; its model call is aborted and the queue moves on |

- A client that disconnects while waiting is removed from the queue and never runs. An
  `/api/ask` whose client leaves is cancelled even while running; a chat turn finishes and is
  saved, so the answer is there when the chat is reopened.
- One user can't hold more than one running or queued message per conversation (409).
- A message counts towards the rate limit once the queue admits it; one refused for size or a
  full queue costs nothing.
- `X-Request-Timeout-Ms` sets a request's own deadline. It can only shorten
  `HOSTED_REQUEST_TIMEOUT_MS`; `load:local` uses it to check the timeout path.
- `HOSTED_KEEP_ALIVE` (`60m`) keeps qwen loaded between visitors, `HOSTED_DATA_DIR` moves the chats.

### Running it

- **Warm-up:** before "ready", one search (embedding model and index), one rerank (the
  cross-encoder) and a one-token qwen call at num_ctx 8192, so the first user doesn't pay for
  loading (~14 s here).
- **Keep the Mac awake:** `serve:local` runs under `caffeinate -is` (no idle or system sleep
  while it runs; system sleep is only held off on power). Keep the lid open and the charger
  connected: closing the lid sleeps the Air whatever `caffeinate` says.
- **Stopping:** Ctrl-C (or SIGTERM) stops taking requests, rejects the waiting ones with 503,
  lets the running one finish, and exits. Nothing is unloaded.

### Tailscale

The CLI ships inside the Mac app: `alias tailscale=/Applications/Tailscale.app/Contents/MacOS/Tailscale`
(or install it from the menu bar app: Settings → CLI). MagicDNS and HTTPS certificates must be on
for the tailnet (admin console → DNS); the first `serve` offers a link to turn HTTPS on if not.

```bash
tailscale serve --bg 3100     # https://<machine>.<tailnet>.ts.net → http://127.0.0.1:3100, persists across restarts
tailscale serve status        # what is being served
tailscale serve reset         # stop serving (clears the serve config)
```

Here the URL is **https://michaels-macbook-air.tail10a1c4.ts.net** (`tailscale status --json` →
`Self.DNSName`). Only devices on the tailnet can resolve and reach it. To let someone else use it,
share the machine from the admin console (Machines → this Mac → Share…) or invite them to the
tailnet; their own login arrives in the headers, so they get their own chats and their own
rate limit. Don't use `tailscale funnel`: that would put it on the public internet.

### API

```bash
H=https://michaels-macbook-air.tail10a1c4.ts.net    # or http://127.0.0.1:3100 on this Mac

# one stateless question through the whole local RAG pipeline (no router, no memory)
curl -s $H/api/ask -H 'content-type: application/json' \
  -d '{"question":"Is Compose Multiplatform for iOS stable?"}'
# → { "status": "answered" | "dont_know", "answer", "citations": [{ id, chunk_id, quote, source, section }],
#     "sources", "clarifying_question", "timings": { queueMs, retrieveMs, rerankMs, answerMs, totalMs, runMs }, "model" }

# a conversation: create, send, read, reset its task memory, list, delete
ID=$(curl -s -X POST $H/conversations | jq -r .id)
curl -s $H/chat -H 'content-type: application/json' -d "{\"sessionId\":\"$ID\",\"message\":\"Is CMP for iOS stable?\"}" | jq .reply
curl -s $H/conversations/$ID | jq '.messages | length'
curl -s -X DELETE $H/conversations/$ID/task-memory
curl -s $H/conversations
curl -s -X DELETE $H/conversations/$ID

# the queue's progress as NDJSON: {"type":"queued","position":2} … {"type":"started"} … {"type":"done","body":…}
curl -sN $H/api/ask -H 'accept: application/x-ndjson' -H 'content-type: application/json' -d '{"question":"…"}'

curl -s $H/health   # ok, status, uptimeS, ollama, model (loaded, size), index, embeddings, reranker, queue, limits, outboundBlocked
curl -s $H/api/me   # who Tailscale says you are, and the limits
```

Errors are `{ "error": "<a sentence>" }` with 400, 409, 413, 429 (+ `Retry-After`), 503 or 504;
on an NDJSON stream they arrive as `{"type":"error","status":…,"error":…}`.

### `npm run load:local`

Runs against the hosted server (default `http://127.0.0.1:3100`, or `--url`) by HTTP only and
writes [`reports/hosted_load_report.md`](reports/hosted_load_report.md) and
`reports/hosted_load_results.json`:

- **Isolation:** 20 excluded routes must be 404.
- **Stability:** 5 simulated users (fake `Tailscale-User-Login` headers, which only work on
  127.0.0.1) send 2–3 `citations` questions each, all at once: the first in a new chat, the rest
  via `/api/ask`; a busy 429 is retried after `Retry-After`. Successes, 429s, timeouts, errors,
  queue wait and answer latency (p50, p95, max), Ollama's memory before and after, `/health` at the end.
- **Limits, one check each:** 413, 409 (same chat), 429 full queue, leaving the queue, 429 rate
  limit, 504 then the next request works, and another user's conversation reads as empty. The
  queue and rate checks fill the queue behind one running request and leave it again, so they
  cost one answer, not a dozen.
- **Outbound:** the server's fetch-guard count must not move.
- **Network access:** a section filled in by hand, with the commands to run (phone over
  Tailscale, `curl` from another tailnet device, a device off the tailnet).

Through `--url https://…ts.net`, Serve replaces the fake identities with your own, so the five
users become one; the report says so and skips the cross-user check.

## Optimization (Day 29)

The Knowledge RAG chat on qwen3.5:9b (gemma4:12b is gone from `LOCAL_MODELS`; its Day 28 reports
stay). `npm run opt:local` runs three variants of the same model in order, with `--cooldown`
seconds between them (default 180; the Air is fanless). Each runs `eval:local -- --variant <v>`
(the 10 citation questions from Day 28's cached retrieval, judged by Claude Haiku 4.5) and then
`verify:local -- --variant <v>` (the 3-turn RAG chat, fully local):

| variant | `LOCAL_RAG_NUM_CTX` · `LOCAL_NUM_CTX` | `LOCAL_PROMPT_VARIANT` |
| --- | --- | --- |
| `baseline` (Day 28) | 16384 · 8192 | v1 |
| `ctx8k` | 8192 · 8192 | v1 |
| `ctx8k+prompt` | 8192 · 8192 | v2 |

**v2** (`RAG_SYSTEM_V2` in `prompt.js`, `ROUTER_SYSTEM_V2` in `router.js`) replaces prose with
worked examples: one quote per line with two citations, a qualified answer instead of an "I
don't know", and two `memory_only` turns with their JSON patches. It is no longer than v1 in
characters (`npm test` checks it). Only a local provider whose settings say `v2` gets it; Claude
always gets v1, which a SHA-256 test pins byte for byte. Verification, the retry and the schemas
are unchanged.

**Measured:** quality (answered, fabricated, retries, faithfulness, false "I don't know", fact
score), router and memory (turn 2's `memory_patch`, turn 3's `usesMemory`), speed (TTFT, tok/s,
latency) and resources (`/api/ps` memory, reloads: a response with `load_duration` > 1 s after
the run's first request, the `num_ctx` actually sent, possible truncations).

**Decision rule:** `ctx8k` is adopted with 0 possible truncations and no quality row worse by more
than one question; `ctx8k+prompt` on top of it with a fact score ≥ the baseline's, no new false
"I don't know", no drop in faithfulness and verify:local's memory check passing.

**Result: `ctx8k` adopted, v2 not.** `LOCAL_RAG_NUM_CTX` now defaults to **8192**. ctx8k gave the
same answers on all 10 questions with 0 truncations, at the same speed (latency 31.3 s vs 29.5 s)
and ~0.2 GB less memory. There were no reloads to save: Ollama didn't reload qwen when `num_ctx`
changed. v2 cut the router prompt by 25% (907 → 682 tokens) and was the only variant whose router
wrote the task memory, but its contract prompt raised retries from 1 to 6 and turned q15 into a
false "I don't know". The baseline's fact score came out 0.52 against Day 28's 0.66: the same
"I don't know" on q12, graded differently by the judge (see the notes). The variants ran with
`--force`. Report: [`reports/local_opt_report.md`](reports/local_opt_report.md), notes:
[`reports/local_opt_notes.md`](reports/local_opt_notes.md), and the **Optimization (Day 29)** tab
of http://localhost:3000/rag-report.

```bash
npm run opt:local                          # all three, cooldown 180 s; stops if the baseline drifts from Day 28
npm run opt:local -- --force               # go on anyway
npm run opt:local -- --only ctx8k+prompt   # re-run one variant, keep the others' files
npm run opt:local -- --report              # re-render from reports/local_opt/*.json + the notes
```

## Local RAG (Day 28)

A Knowledge chat **With RAG** runs fully on this machine when its Model switch is a local
model. Retrieval was already local (EmbeddingGemma vectors from `../doc_index`, bge-reranker
for the rerank); now generation is too, through the same Day 27 `OllamaProvider`. Nothing in
the RAG path was forked: `runChatTurn`, `answerQuestion`, `answerWithContract` /
`verifySubmission`, `clarifyQuestion` and `routeMessage` all take a provider, and the chat
route hands them the chat's.

**Which calls run where**, per message of a RAG chat:

| call | Claude chat | local chat |
| --- | --- | --- |
| router (`route`: intent, standalone question, queries, memory patch) | Claude (`RAG_ROUTER_MODEL`) | local model, JSON schema |
| vector search (EmbeddingGemma) + rerank (bge-reranker-v2-m3) | local | local |
| answer (`submit_answer` contract, + one retry) | Claude | local model, JSON schema |
| low-relevance clarification (`submit_clarification`) | Claude | local model, JSON schema |
| Rewrite stage (`submit_queries`) | only in Compare, Claude | not used (the button is disabled; the router writes the queries anyway) |

`llms.ragProviderFor(llm)` (`src/llm/choice.js`) is the only way the route gets a provider for
a RAG turn: Claude for `claude`, an `OllamaProvider` sized for RAG for `local:<tag>`. There is
**no cloud fallback**. Ollama down, a timeout or a model that isn't pulled is the Day 27
readable error. A reply that never becomes valid JSON is handled in code, never sent to Claude:
- for `submit_answer`, it counts as not calling it; the contract retries once, then downgrades;
- for the router, the message is searched as typed (override `invalid JSON → search`);
- for the clarification, the fixed fallback question is used.

**Forced tool calls → JSON schema.** For the Ollama provider, a forced tool is sent as
Ollama's `format` with the tool's own `inputSchema` (the same object Claude gets as
`input_schema`), then parsed and validated with ajv. An invalid reply is retried once with the
validation errors, and the caller still receives a `tool_use` block. Each completion records
`structured: { attempts, invalid, errors }`, which the eval counts as "invalid JSON".

**The citation contract is unchanged.** It runs the same `verifySubmission` rules: markers,
known chunk_ids, verbatim quotes of 4–60 words, every citation used. The same single retry
follows, then the same repair or downgrade. The only difference is how the retry is sent.
Claude's tool call is answered with a `tool_result`. A local model's submission was a JSON
reply, so it gets that JSON back as an assistant message and the error list as a plain user
message.

**Context window.** Every RAG call on a local model sends `num_ctx = LOCAL_RAG_NUM_CTX`
(default 8192 since [Day 29](#optimization-day-29); 16384 on Day 28) and `num_predict ≤ LOCAL_RAG_NUM_PREDICT` (2048, the contract's ceiling). The
default comes from measurement: the eval's answer prompts are 0.7–3.1k tokens (system prompt +
5 chunks + question). A chat turn adds task memory and up to 6 history messages, and the reply
needs room. The window does cost memory once prompts fill it. Right after loading, `/api/ps`
shows 7.7 GB for qwen3.5:9b at 8k, 12k and 16k alike. After the eval's prompts at 16k it is
9.6 GB for qwen3.5:9b and 15.2 GB for gemma4:12b, nearly all of a 16 GB machine. Lower
`LOCAL_RAG_NUM_CTX` (e.g. 8192: still about 2.6× the largest eval prompt) if gemma is your
RAG model. Ollama doesn't report it when it cuts a prompt that doesn't fit. So any
response whose `prompt_eval_count` is within 10% of `num_ctx` is logged (`[local] possible
truncation: …`) and flagged on the result and the stored reply as `possible_truncation`. The
page shows a **⚠ possible truncation** chip. Plain local chats keep `LOCAL_NUM_CTX` (8192).
Ollama reloads a model when `num_ctx` changes, so the first message after switching a chat
between Without RAG and With RAG pays one model load (≈ 8–10 s).

**In the page.** A local RAG reply has one badge, `qwen3.5:9b · rag+rerank`. Hovering it shows:
- TTFT, tok/s, model latency over all calls, and tokens with `num_ctx`;
- the router's time;
- the local retrieval and rerank times;
- any invalid-JSON retries.

Citation chips, the verification badge, Sources, the chunk list and "I don't know" with its
clarifying question are the same components as for Claude. The side panel says the router and
the answer are local.

**Compare: Claude vs local.** The Compare dialog has a **Compare** select: *With RAG vs
without* (on a local chat both arms use the local model) or *Claude vs local* (the chat's
local model, or the default one). Claude vs local runs `retrieveForQuestion` **once**
(rag or rag+rerank, as the chat's Rerank switch says, never Rewrite). Then it calls
`answerQuestion({ retrieval })` for Claude and for the local model in parallel, so both
answer from the same chunks. Claude's call is streamed only to time it
(`AnthropicProvider({ stream: true })`), so its TTFT is a real first-token time. Each side
shows its answer, citation chips, verification badge, sources and timings: retrieval and
rerank (shared), TTFT, generation, total. A local failure shows as that side's error, never
filled in by Claude.

**`npm run eval:local`** (`scripts/eval-local.js`, pure half in `src/rag/localEval.js`):

- **Questions:** the 10 `citations` questions in `rag+rerank`, 7 to answer and 3 to decline,
  as on Day 24.
- **Shared retrieval:** each question is retrieved and reranked once, locally, and cached in
  [`reports/local_rag_retrieval.json`](reports/local_rag_retrieval.json). The cache is keyed by
  the retrieval settings and the question text; `--fresh` rebuilds it. Every generator answers
  from those exact chunks through `answerQuestion({ retrieval })`, the same contract as the
  chat, so the comparison isolates generation. Retrieval and rerank times are reported once.
- **Generators:** Claude Haiku 4.5 (cloud, streamed for TTFT), then each `LOCAL_MODELS` model
  in turn. Before each local model, everything is unloaded; the model is loaded with the RAG
  `num_ctx` and its load time recorded. After its questions, its memory comes from `/api/ps`
  and it is unloaded.
- **Judges:** they stay on Claude (`RAG_JUDGE_MODEL`): faithfulness and Day 22's fact judge,
  run after all generation so the local runs are back to back. The API key is needed for
  Claude's generation and the judges only. The report lists which calls were cloud and which
  local.
- **Thermals:** every request records its run order and start time. The summary compares the
  first and second half of each model's questions (tok/s, latency), because the Air is
  fanless.
- **Options:**
  - `-- --quick`: 3 questions (one corpus, one paraphrased, one decline), Claude + the first
    local model, written to `local_rag_quick_*`;
  - `-- --models qwen3.5:9b`, `-- q14`: partial runs, merged into the existing results;
  - `-- --no-claude`;
  - `-- --report`: re-render from the JSON and the notes.
- **Outputs:**
  [`reports/local_rag_results.json`](reports/local_rag_results.json) and
  [`reports/local_rag_report.md`](reports/local_rag_report.md). The report has a summary with
  the generators as columns, then every question with each generator's answer, citations,
  verification and timings, and the run order. The findings are in
  [`reports/local_rag_notes.md`](reports/local_rag_notes.md), and `/rag-report` has a
  **Local** tab.

**`npm run verify:local`** now also holds a Knowledge **With RAG** conversation per local model:
- turn 1 states a goal and asks if CMP for iOS is stable;
- turn 2 sets "at most 3 sentences" and "CMP = Compose Multiplatform";
- turn 3 asks only about "CMP", so the router has to read the term from the task memory.

It runs under the same no-key, localhost-only fetch guard, with a Claude provider that counts
its calls. It checks that every reply and every router call came from the local model and that
Claude was called 0 times. It also checks that search replies are `answered` with citations
that passed verification and were not downgraded, that no prompt was flagged for truncation,
and that turn 3's standalone question says "Compose Multiplatform" with the term held in
memory. See [`reports/day27_verify.md`](reports/day27_verify.md).

| env (Day 28) | default | |
| --- | --- | --- |
| `LOCAL_RAG_NUM_CTX` | 8192 (Day 28: 16384) | context window of every local call in a Knowledge RAG chat, the same as `LOCAL_NUM_CTX` since Day 29; a prompt within 10% of it is flagged `possible_truncation` |
| `LOCAL_RAG_NUM_PREDICT` | 2048 | output ceiling of those calls |
| `RAG_JUDGE_MODEL` | Haiku 4.5 | `eval:local`'s judges (cloud) |
| `OLLAMA_URL`, `LOCAL_MODELS`, `LOCAL_TIMEOUT_MS`, … | | as on Day 27, below |

## Local models (Day 27)

first-agent and Knowledge chats can be answered by a model running on this machine under
Ollama, with nothing sent to the cloud. The Ollama side is Day 26's client,
[`../local_llm/src/ollama.js`](../local_llm/src/ollama.js), imported from the directory next
to first-agent the way `../doc_index` is (override with `LOCAL_LLM_DIR`).

**Provider.** `OllamaProvider` (`src/llm/ollama.js`) implements the same `LlmProvider`
interface as `AnthropicProvider` and `FakeProvider`: `complete({ system, messages, temperature,
maxTokens, tools, toolChoice })` → `{ text, content, model, stopReason, usage }`. The system
prompt becomes a `system` message; content blocks are flattened to text. Every call sends
`think: false`, an explicit `num_ctx` and `num_predict` (the smaller of the caller's
`maxTokens` and `LOCAL_NUM_PREDICT`). A completion also carries `provider: "local"` and
`metrics` (time to first token, generation tok/s, total latency, prompt and output tokens,
from Ollama's own timings). Every local reply stores them as `provider` and `localMetrics`.
A call that forces a tool (`toolChoice`) is sent with the tool's input schema as Ollama's
JSON-schema `format`. The reply is parsed and validated with ajv, and an invalid one is
retried once with the validation errors; the caller still gets a `tool_use` block. Free tool
use (Movie buff) is refused. `countTokens` returns unknown, since Ollama has no count
endpoint, so "tokens sent" shows "?" on a local chat. Usage comes from Ollama's counts, and
the cost is unpriced.

Failures come back as one readable sentence, never a stack trace: Ollama down → "isn't
reachable … Start it with `ollama serve`", model not pulled → "Pull it with `ollama pull
qwen3.5:9b`", timeout → which setting to raise. **There is no cloud fallback anywhere**: a
failed local call is an error reply.

**Model switch.** The header has a **Model** select: `Claude` or `Local · <model>`. It is
stored per chat (`llm: "claude" | "local:<tag>"` on the record, `PUT /conversations/:id/llm`),
like the RAG switch, and sent with each message. New chats start on Claude when there is a
key and `LOCAL_DEFAULT_MODEL` is unset; otherwise on the default local model. Without
`ANTHROPIC_API_KEY` the Claude option is disabled. `GET /local/status` returns whether Ollama
is reachable, its version, the installed and loaded models, and what the switch offers. The
page polls it every 20 s. It shows a red **local model down** (or **model not pulled**) chip
next to the switch, and a **Local · Ollama** row in the sidebar like the MCP servers' "server
down".

**Replies.** A local reply has a green `local · qwen3.5:9b` badge; hovering it shows the time
to first token, tok/s, model and turn latency, and token counts. Replies are **not streamed**.
While one is generating, the bubble says "generating locally with qwen3.5:9b" with a running
seconds counter. Why not streaming: `POST /chat` answers once, after the memory strategy has
post-processed the reply (it strips the `<memory-close>` lines and updates memory), and the
memory extractor runs *before* the reply on every turn. Streaming would mean a streaming
provider method, a token callback through `Agent.run`, an SSE response on both chat routes,
and a reader in the page — a rewrite of the turn, not an addition. The Day 26 client is also
non-streaming, so TTFT is Ollama's load + prompt-eval time.

**Which agents and features work locally:**

| agent | local? | notes |
| --- | --- | --- |
| first-agent (memory chat) | fully | every model call goes to the chat's provider (list below); nothing disabled |
| Knowledge, Without RAG | fully | short-term history only, as before |
| Knowledge, With RAG | fully, since Day 28 | router, answer and clarification on the local model; see [Local RAG (Day 28)](#local-rag-day-28). Only the Rewrite stage (used by Compare) stays Claude's |
| pirate support, Movie buff, Pipeline | no | Claude only; the Model switch is hidden and the server refuses a local choice |

Every model call the first-agent chat makes, all on the chat's provider:

| call | when | where |
| --- | --- | --- |
| the reply | every turn | `Agent.#answer` |
| token counts (request, sent, without the memory block) | every turn | `Agent.#count` (local: unknown, no request) |
| memory extractor (JSON ops) | every turn, before the reply | `MemoryExtractor` in `context/memory.js` |
| digest fold | when the history passes the window mark | `Summarizer` |
| handoff brief | planning → execution | `Briefer`, via `POST …/memory/transition` |
| promotion proposals | → done | `Promoter`, via `POST …/memory/transition` |
| invariant proposals | the panel's Propose button | `InvariantProposer`, via `POST …/memory/invariants/propose` |
| profile comparison | the panel's Compare | `compareProfiles`, via `POST …/memory/compare` |

None of these uses forced tool use: the extractor, promoter and proposer ask for JSON as text
and parse it, so they run on a local model unchanged. The memory routes get the provider from
the chat's record (`providerFor`), so the lifecycle buttons stay local too. The forced-tool →
JSON-schema path in `OllamaProvider` is what Knowledge With RAG (router, contract, clarify)
uses locally since Day 28.

| env | default | |
| --- | --- | --- |
| `OLLAMA_URL` | `http://localhost:11434` | where Ollama listens |
| `LOCAL_MODELS` | `qwen3.5:9b`, if installed (Day 29; gemma4 only when named here) | the models the switch offers (comma list) |
| `LOCAL_DEFAULT_MODEL` | the first of them | the local model new chats start on; setting it makes local the default even with a key |
| `LOCAL_NUM_CTX` | 8192 | context window, sent on every call (not Ollama's default) |
| `LOCAL_NUM_PREDICT` | 1024 | ceiling on generated tokens per call |
| `LOCAL_TIMEOUT_MS` | 180000 | per call, model load included |
| `LOCAL_LLM_DIR` | `../local_llm` | where the Day 26 client lives |
| `LOCAL_PROMPT_VARIANT` | `v1` | Day 29: `v2` gives a local model the shorter contract and router prompts with examples; Claude always gets `v1` |

**`npm run verify:local`** starts the app's routes in-process (`createApp` in `src/app.js`,
which `server.js` now just listens on) with an in-memory store, no `ANTHROPIC_API_KEY`, and
a `fetch` guard that blocks and counts any request to a host other than localhost. For each
local model (warmed up first, unloaded after) and each supported agent, it sends three
messages through the real `POST /chat`. The second only makes sense after the first ("there",
"in it"); the third asks for facts from the first. It checks that every reply is
`provider: local` with the right model and non-empty, that the last uses the earlier context,
and that the record stores the choice. The report
([`reports/day27_verify.md`](reports/day27_verify.md)) has each conversation, the replies with
their metrics, and per model: mean TTFT, tok/s, model and turn latency, and outbound
non-localhost requests (expected 0). Exit code 1 on any failure.

**Manual check, no network at all:**

1. `ollama serve` (or the Ollama app) running, with a model pulled: `ollama list`.
2. Turn Wi-Fi off.
3. `npm run start:offline` (or plain `npm start`) and open http://localhost:3000.
   `start:offline` sets `OFFLINE=1 HOST=127.0.0.1`: the app listens on loopback only,
   ignores `ANTHROPIC_API_KEY` (Claude off, local the default), and registers only the
   MCP servers on this machine, so the page never quietly reconnects Notion. Pick **first-agent**, start a new
   conversation, and pick **Local · qwen3.5:9b** in the Model switch (without a key it is
   the default).
4. Chat: "I'm Mira, planning a trip to Lisbon." → "Two neighbourhoods to stay in there?" →
   "What's my name and where am I going?". Each reply gets a `local · qwen3.5:9b` badge;
   hover it for the numbers. The memory panel fills in as usual.
5. Optional: quit Ollama and send another message. The reply is the "isn't reachable … `ollama
   serve`" error, and the header shows **local model down**.

## Chat with task memory (Day 25)

With RAG on, the Knowledge chat is routed turn by turn (`src/rag/chatTurn.js`, used by `POST /chat`
and by `eval:chat`):

```
message → router (LLM call 1) → apply memory patch → branch on intent
  chat / memory_only → the router's reply                              (1 call)
  search → retrieve → rerank → cutoff → answer + verify                (2 calls)
           └ nothing relevant → "I don't know" + clarifying question   (2 calls)
```

**Router** (`router.js`): one forced `route` call per message, `RAG_ROUTER_MODEL` (Haiku 4.5 by
default), temperature 0. It sees the new message, the last `RAG_HISTORY_TURNS` messages (earlier
assistant messages cut to ~300 characters with citations stripped; never the chunks) and the task
memory, and returns `{ intent, standalone_question, queries, reply, memory_patch }`:

- `search`: anything that asks about content, including "why?" and "and the other one?"; any
  question, even off-topic; a message that mixes kinds; a reply to an open clarifying question
  (its `standalone_question` is the original question with the clarification applied); and
  whenever the router is unsure.
- `memory_only`: only a constraint, correction, preference or term definition. `chat`: greetings,
  thanks, acknowledgements. Both show the router's short `reply`; nothing is searched.
- `queries`: 1–3 short search queries (Day 23's rules) with the resolved subject and clarified
  terms, never the goal or the constraints.
- **Code overrides:** a missing or invalid intent becomes `search`; while an open question
  exists, anything but `chat` becomes `search`. The override is recorded and shown.

**Search turns** run Day 23's pipeline with the router's `queries` (the Rewrite stage is not used:
the router writes the queries) and **rerank against `standalone_question`**, not the raw message,
with the same cutoff and `K_RETRIEVE` / `K_FINAL`. The answering call is Day 24's `submit_answer`
contract and verification, plus the task memory (before the documents), the last
`RAG_HISTORY_TURNS` messages, and the user's message next to the resolved question. Extra rules:
follow the memory's constraints (length, terms, focus); document facts need `[cN]`; something
from the user's own earlier messages is written "(as you said)" without a citation; the task
memory is never a source. An "I don't know" works as on Day 24, and **code** then adds its
clarifying question to `open_questions`, so the next message can answer it.

**Task memory** (`taskMemory.js`), per chat, on the conversation record:

```js
{ goal: string | null,
  clarified: [{ id, text, turn }],        // details the user clarified        (ids d<turn>)
  constraints: [{ id, text, turn }],      // rules and terms the user set      (ids k<turn>)
  open_questions: [{ id, text, turn, question }] }  // clarifying questions asked (ids q<turn>)
```

The router's `memory_patch` is a list of operations — `set_goal`, `add_clarified`,
`add_constraint`, `remove` (by id), `resolve_question` (by id) — never a rewrite. Code applies
them one by one; an unknown op or id (or an empty or duplicate item) is logged and skipped,
never fatal, and nothing leaves the memory except by `remove` or `resolve_question`. The router
is told: a change of direction sets the new goal and removes the details that no longer apply; a
correction replaces the item it corrects; never store what the documents said; resolve every
open question the user answers or drops. Each user message stores its `route`: intent (and any
override), standalone question, queries, the patch as proposed, what was applied and skipped,
the open question added, the memory after the turn and its diff, and the router and answer
latency.

**In the page**, each user message has an intent badge (`search`, `memory`, `chat`; `*` marks a
code override); a search badge opens to the standalone question and the queries. The side
panel shows the task memory — goal, clarified, constraints & terms, open questions — with the
latest turn's additions tinted and removals struck through, and a **Reset** button
(`DELETE /conversations/:id/task-memory`). Everything from Day 24 is unchanged: citation chips,
sources, the verification badge, "I don't know" with its clarifying question.

| env | default | |
| --- | --- | --- |
| `RAG_ROUTER_MODEL` | `claude-haiku-4-5-20251001` | the router's model |
| `RAG_HISTORY_TURNS` | `6` | recent messages the router and the answering call see |

### Chat eval (`npm run eval:chat`)

Two scripted conversations, written from the corpus, in [`eval/chat/`](eval/chat):
`scenario-1.json` (deep dive: Compose Multiplatform for an iOS app, 13 messages) and
`scenario-2.json` (comparison: two Kotlin 2.4 articles, then a change of direction to a
navigation choice, 13 messages). Each message has `expected_intent`, `expect: { decline,
sources, facts }`, optional `memory_checkpoint` and `constraint_check`, and `tags` naming the
required elements it carries (goal, constraint, term, reference, vague → clarification,
correction, chat, off-topic → return, change of direction, late reference outside the history
window), which `npm test` checks are all present.

The runner mounts `ragRoutes` on an in-process server with an in-memory store and replays each
scenario through `POST /chat` on a fresh chat — the page's own code path — with real calls.
Per turn:

| check | how |
| --- | --- |
| intent | router intent (after overrides) vs `expected_intent` |
| sources + citations | search turns: ≥ 1 source and ≥ 1 verified citation, or a correct "I don't know" when `decline` is true; fabricated quotes on the first attempt are counted |
| expected source | when `expect.sources` is given: in the kept chunks and cited |
| constraint | `constraint_check`: sentences (Day 24's claim splitter) / words, mechanically |
| memory checkpoint | judge (`submit_memory_check`): does the memory reflect each statement; stale items (corrected, left behind by a change of direction, or not the user's) fail it |
| on track | judge (`submit_on_track`): does the reply address the resolved question, consistent with the goal and constraints; plus Day 24's faithfulness judge — an unsupported claim fails it |
| facts | when `expect.facts` is given: Day 22's fact judge, score ≥ 0.75 and no hallucination |

Output: `reports/chat_results.json`, [`reports/chat_report.md`](reports/chat_report.md) (summary
per scenario, every turn with its route, answer, memory diff and checks), the hand-written
[`reports/chat_notes.md`](reports/chat_notes.md), and the **Chat** tab at
http://localhost:3000/rag-report#chat (summary per scenario and both turn-by-turn timelines,
failing turns outlined).

## RAG (`src/rag/`)

```
question → [rewrite] → vector search (K_RETRIEVE) → [rerank + cutoff] → top K_FINAL → LLM
```

`answerQuestion(question, { mode, rerank, rewrite, history, provider, … })` in `answer.js` is
used by the chat and the eval. It returns `{ answer, mode, label, queries, candidates, chunks,
declined, rejected, usage, usageByStage, timings: { rewriteMs, retrieveMs, rerankMs, clarifyMs, llmMs } }`,
and in RAG modes also `{ status, citations, sources, clarifyingQuestion, dontKnow, verification }`
(the answer contract below).

- **plain**: a short neutral system prompt (`BASE_SYSTEM`) and the question.
- **rag** (both stages off, the Day 22 baseline): doc_index `search()` with the question alone
  (never the history), top `K_FINAL` by vector score, no cutoff. Chunks below `RAG_MIN_SCORE`
  are dropped and the scores are logged. The rest go into the **latest user message** as
  `<documents><doc n chunk_id source section title>…</doc></documents>`, built by
  `buildRagPrompt(question, chunks)` (`prompt.js`), with document rules in the system prompt.
  The answer comes back through the **answer contract** (below): `[cN]` markers, verbatim
  quotes, verified in code, or `dont_know`.
- **Rewrite** (`rewrite.js`): one call to the chat model, temperature 0, forced
  `submit_queries`, turns the question into 1–3 standalone search queries (filler stripped,
  the documents' terms, one query per part). Each is searched and the results are merged by
  `chunk_id`, keeping each chunk's best score. The model still answers the **original** question.
- **Rerank** (`reranker.js` → `../doc_index/src/rerank.js`): `K_RETRIEVE` candidates per query
  are scored by a local cross-encoder, `onnx-community/bge-reranker-v2-m3-ONNX` (int8, ~570 MB,
  downloaded on first use), against the **original** question. Logit → sigmoid (0–1), sorted,
  below `RAG_RERANK_THRESHOLD` dropped, top `K_FINAL` kept. **If nothing passes**, the answering
  model is not called: the reply is "I don't know" plus a clarifying question from one small
  call, and the 3 best rejected chunks are shown. Pairs are scored one at a time: the int8 model quantizes per batch, so
  padding a batch shifted every score depending on its neighbours (and was slower on CPU).
  About 7 s per 20 candidates on a laptop CPU.
- Every mode uses the provider's default chat model and `temperature: 0`; plain answers get max
  1024 tokens, `submit_answer` 2048.
- The embedding model and the reranker each load on first use (one log line when ready) and
  are reused. A missing index or one built with another model is a readable 503, not a stack.

| env | default | |
| --- | --- | --- |
| `RAG_K_FINAL` | `5` | chunks sent to the model (`RAG_K`, Day 22's name, still works) |
| `RAG_K_RETRIEVE` | `20` | vector candidates when rerank is on, per query when rewriting; with rerank off, `K_FINAL` are retrieved |
| `RAG_RERANK_THRESHOLD` | `0.02` | cutoff on the 0–1 rerank score |
| `RAG_STRATEGY` | `structural` | `structural` or `fixed` |
| `RAG_COLLECTIONS` | all | comma list of `knowledge`, `projects`, `downloads` |
| `RAG_MIN_SCORE` | off | drop chunks whose vector score is below it |
| `RAG_JUDGE_MODEL` | the chat model | judge for `eval:rag` |
| `DOC_INDEX_DIR` | `../doc_index` | |

**Threshold 0.02**: on doc_index's 20 retrieval questions (not the answer eval), the chunks
holding the expected text scored a median 0.92 and a minimum 0.010. 0.02 keeps 19 of 20, losing
only a chunk that was already 10th by vector score, and drops 63% of the other candidates.
The numbers are in [`reports/rag_notes.md`](reports/rag_notes.md).

Routes: `PUT /conversations/:id/rag` `{ mode?, rerank?, rewrite? }`, `DELETE /conversations/:id/task-memory` (Day 25), `POST /rag/compare`
`{ question, rerank?, rewrite? }`, `GET /rag/status`, `GET /rag-report` (page) and
`GET /rag-report/data` (reads `reports/rag_results.json`, `rag_notes.md`, `citations_results.json`,
`citations_notes.md`, `chat_results.json` and `chat_notes.md` on every request; the page has a
**Modes**, a **Citations** and a **Chat** tab).

### Answer contract (Day 24, `contract.js`)

Every RAG answer is one forced `submit_answer` call (temperature 0, max 2048 tokens because the
quotes and chunk_ids count too) instead of free text. Each document in the prompt carries its
`chunk_id`.

```js
{
  status: "answered" | "dont_know",
  answer: "Text with a marker after each claim [c1].",      // empty for dont_know
  citations: [{ id: "c1", chunk_id: "…", quote: "verbatim excerpt from that chunk" }],
  clarifying_question: "…"                                  // required for dont_know
}
```

The rules in the system prompt: every factual claim ends with at least one `[cN]` marker, just
before its final punctuation; a quote is one or two sentences copied verbatim from the chunk it
cites (4–60 words), the part that supports the claim; only the documents are used; if they don't
contain the answer, return `dont_know` with a clarifying question rather than stretching loosely
related text.

**Sources are never written by the model.** `deriveSources` builds them from the cited chunk_ids:
`source › section · chunk_id`, one per chunk, in the order the answer first cites them.

**Verification**, in code after the call (`verifySubmission`):

1. `answered` has ≥ 1 citation; `dont_know` has a non-empty `clarifying_question`.
2. Every `[cN]` is a citation, and every citation is used.
3. Every `chunk_id` is one of the chunks that were sent.
4. Every quote is in its chunk (`quotes.js`: compared case-insensitively after normalising
   whitespace, quote marks and backticks, dashes, `…`, and line-break hyphenation). A quote that
   isn't found is a **fabricated quote**.
5. A quote is 4–60 words.

Any failure gets **one** retry, with the list of errors sent back as the tool result (the
planner's pattern). If the retry fails too, the invalid citations are dropped, along with every
sentence whose markers were all invalid. With no valid citation left, the answer becomes
`dont_know`. The result records `verification: { firstAttemptValid, retried, droppedCitations,
droppedClaims, downgraded, firstAttemptErrors, fabricatedFirstAttempt, … }`.

**"I don't know"** has two triggers, and both reply "I don't know." plus a clarifying question:

1. **Low relevance** (rerank on): if the best rerank score is under `RAG_RERANK_THRESHOLD`, the
   answering model is not called. One small forced call (`clarify.js`, `submit_clarification`,
   temperature 0) sees the question and the title, section and first 150 characters of the top 3
   rejected chunks. It writes a clarifying question, which may offer what the documents cover
   nearby ("Did you mean X or Y?") but never answers.
2. **The model's own `dont_know`**, through the contract.

With rerank off there is no relevance score, so only trigger 2 applies; the UI says so next to
the switch. `dontKnow: { reason: "low_relevance" | "model" | "verification_failed" }`.

**In the chat**, `[cN]` markers render as chips. Clicking one shows its quote highlighted in the
full chunk text. Under the answer are a verification badge (`verified`, `retried → verified`,
`1 citation dropped`, `downgraded`; hover for the errors), **Sources** (derived) and
**Citations** (each quote with its source › section), then the retrieved chunks as before. An
"I don't know" reply has its own style, with the clarifying question and the reason. A
low-relevance one also shows the best rejected chunks.

### Citations eval (`npm run eval:citations`)

The 10 questions tagged `"sets": ["citations"]` in `questions.json`: 7 to answer (q02, q04, q06
corpus, q12 near_miss, q14 paraphrased, q15 messy, q16 multi_part, across 7 documents) and 3 to
decline (q10 unanswerable, q13 off_topic, and Day 24's q17 `ambiguous`, "How does it work?").
They run in one mode, `rag+rerank` by default (`--mode` to change it). Per question:

| check | how |
| --- | --- |
| has sources | answerable ⇒ answered with ≥ 1 derived source |
| has citations | answerable ⇒ answered with ≥ 1 valid citation |
| quotes are real | no fabricated quote on the **first** attempt, before the retry fixes it |
| meaning matches citations | faithfulness judge ≥ 0.75 and no `unsupported` claim |
| correct "I don't know" | to-decline ⇒ `dont_know` with a clarifying question; answerable ⇒ not `dont_know` (else a **false IDK**) |

The **faithfulness judge** (`faithfulness.js`) is one forced `submit_faithfulness` call at
temperature 0. It sees the answer cut into claims (sentences with their markers) and the quotes
each cited claim uses, but not the chunks or the expected facts. It rates each cited claim
`supported | partial | unsupported` and lists `uncited_claims`, the factual sentences with no
marker. Faithfulness = supported / cited claims. Answerable questions also get Day 22's fact
judge, to check that correctness didn't drop. Output: `reports/citations_results.json`,
[`reports/citations_report.md`](reports/citations_report.md) with the hand-written
[`reports/citations_notes.md`](reports/citations_notes.md), and the **Citations** tab at
http://localhost:3000/rag-report#citations.

### Eval (`npm run eval:rag`)

[`eval/rag/questions.json`](eval/rag/questions.json) holds 17 questions ([table](eval/rag/questions.md)):
Day 22's 10 unchanged as the regression set (7 corpus, 2 general, 1 unanswerable) plus 6 for
Day 23: 2 `near_miss` (baseline vector search ranks the answer chunk 4th and 2nd), 1
`off_topic`, 1 `paraphrased`, 1 `messy`, 1 `multi_part` (two documents), and Day 24's 1 `ambiguous`.
The unanswerable, off-topic and ambiguous ones carry `expect_decline: true`. 10 are tagged
`"sets": ["citations"]`, and `validateQuestions` checks that set's mix too. Each expected fact has an `evidence` quote, and
every run first checks that each quote appears verbatim in its expected source in the index,
failing loudly if not.

Every question runs in each mode (`--modes` picks some: `plain`, `rag`, `rag+rerank`,
`rag+rewrite`, `rag+rewrite+rerank`) and records:

- **judge**: one forced `submit_grade` call at temperature 0 that sees the question, type,
  expected facts and answer, but not the mode (`[n]` markers are stripped). It grades each
  fact `present | partial | missing | contradicted` and sets `hallucination` and `declined`.
  Score = (present + 0.5 × partial) / facts.
- **retrieval** (RAG modes): whether an expected source is in the final chunks, its rank
  before the rerank (vector order) and after, and **noise**: final chunks from no expected
  source.
- **declines**: correct (on `expect_decline`) vs wrong (on an answerable question), each
  wrong one named and marked `cutoff` or `model`.
- **citations**: every `[n]` is a sent chunk, and at least one comes from an expected source.
- **cost**: input tokens (rewrite + answer) and latency per stage.

Output: [`reports/rag_comparison.md`](reports/rag_comparison.md) (summary with modes as
columns, per-question scores and ranks, every answer with its queries and kept / dropped
candidates) and `reports/rag_results.json`. [`reports/rag_notes.md`](reports/rag_notes.md) is
the hand-written findings, included in the report and on `/rag-report`.

## Pipelines

1. **Goal → proposal.** *Generate plan* calls the planner (`src/pipeline/planner.js`)
   once, with `submit_plan` forced. It sees a catalog of the agent's `plannerTools`, as
   `server.tool` with description, inputSchema and outputSchema, plus which servers are down.
2. **Validation** (`src/pipeline/validatePlan.js`): tools exist, args match the
   inputSchema, and every `{{steps.N.path}}` exists in step N's output shape. An invalid
   plan gets one retry with its errors; still invalid → nothing stored.
3. **Accept → plan.** Runs (Run button, or every N ≥ 15 s) always execute the accepted
   plan; the planner is not called.
4. **Repair.** After a failed run the planner proposes a fix once; it waits for Accept.

Steps:

- `tool { server, tool, args }`: one MCP call made by code.
- `prompt { text, format: "text" | "json", outputSchema? }`: one model call from a
  fresh context, up to 4096 output tokens. A json step returns an object checked
  against its `outputSchema`.

Templates: `{{prev}}`, `{{steps.N.path}}`, `{{now}}`. `scheduler.record` / `aggregate`
always get the chat's own `scheduleId`. The first failing step stops the run; click a
step in a run's strip to see its exact input and output.

## MCP servers

| id | url | auth |
| --- | --- | --- |
| `notion` | `https://mcp.notion.com/mcp` | OAuth: press Connect in the panel; tokens in `data/mcp/notion.json` (git-ignored) |
| `omdb` | `http://127.0.0.1:3001/mcp` | none, [`../imdb_mcp_server`](../imdb_mcp_server) |
| `scheduler` | `http://127.0.0.1:3002/mcp` | none, [`../scheduler_mcp_server`](../scheduler_mcp_server) |

URLs can be overridden with `NOTION_MCP_URL`, `OMDB_MCP_URL`, `SCHEDULER_MCP_URL`.

## Pipeline routes

| route | does |
| --- | --- |
| `GET`/`PUT /conversations/:id/pipeline` | `{ goal, mode, intervalSeconds, enabled }`; GET also returns `plan`, `proposal` |
| `POST /conversations/:id/pipeline/plan` | `{ goal? }` → run the planner, store the proposal (422 with `errors` if invalid) |
| `POST /conversations/:id/pipeline/proposal` | `{ action: "accept" \| "discard" }` |
| `POST /conversations/:id/pipeline/run` | run the accepted plan now |
| `GET /conversations/:id/runs[/:runId]` | recent runs; one run's steps with input and output |
