# Day 27 — Integrating a local LLM into an application

Day 27 of my AI challenge: integrate a local model into a real application. The application
is the existing `first-agent` chat app. The local model is served by Ollama and reached
through the client built on Day 26 in `../local_llm/src/ollama.js`. Hardware: MacBook Air M2,
16 GB RAM.

The application must:
- send requests to the local LLM,
- receive and display its responses,
- run without relying on cloud models.

Before writing code, read how first-agent talks to models today: the Anthropic provider,
the offline FakeProvider, how a provider is chosen, and every place in the chat path that
makes a model call. Match the existing provider interface. Don't invent a parallel one.

## What to build

### 1. `OllamaProvider` in first-agent

- A provider next to the Anthropic one and FakeProvider, with the same interface. It uses
  `../local_llm/src/ollama.js`, imported the same way first-agent imports `../doc_index`.
- Maps the app's message format to Ollama's: the system prompt becomes a system message,
  and content blocks are flattened to text.
- Settings (env, all optional, in `.env.example`): `OLLAMA_URL` (http://localhost:11434),
  `LOCAL_MODELS` (default: the installed gemma4 and qwen3.5:9b tags from Ollama),
  `LOCAL_DEFAULT_MODEL`, `LOCAL_NUM_CTX` (set explicitly; don't rely on Ollama's default),
  `LOCAL_NUM_PREDICT` (default 1024), `LOCAL_TIMEOUT_MS` (default 180000). Always `think: false`.
- Every reply records the model, the provider (`local`), and Ollama's metrics from Day 26
  (time to first token, generation tokens/s, total latency, prompt and output tokens).
- If Ollama is down or the model isn't pulled, return a readable error (the fix:
  `ollama serve`, `ollama pull …`), never a stack trace.

### 2. Model choice per chat

- A **Model** switch in the chat header: `Claude` or one of the local models. It is stored
  per chat, like the RAG switch. The default comes from env.
- Without `ANTHROPIC_API_KEY`, the Claude option is disabled and local is the default.
- `GET /local/status`: Ollama reachable, version, installed models, which one is loaded.
  The page shows a "local model down" state like the MCP servers' "server down".

### 3. Which agents support local in Day 27

- **Knowledge, Without RAG**: fully local. With a local model selected, the RAG switch
  is off and disabled, with the note "local + RAG: Day 28".
- **first-agent** (the memory chat): fully local. List every model call this chat makes
  (reply, digest, profile, lifecycle, etc.). Each one goes to the chat's selected provider.
  A call that relies on forced tool use is changed, for the Ollama provider, to Ollama's
  JSON-schema `format` plus validation, with one retry on invalid JSON. If that isn't
  workable for a call, disable that feature for local chats and show it in the UI. Don't
  quietly send it to Claude.
- Movie buff, Pipeline and pirate support stay Claude-only. The Model switch is hidden there.
- **No silent cloud fallback anywhere.** If the local call fails, the reply is an error.

### 4. Displaying replies

- Each local reply gets a badge with the model name. Hovering shows the metrics.
- Local replies are slow, so stream tokens into the page if the chat route can stream
  without a large rewrite. If not, show a "generating…" state with a running elapsed time.
  Say which one you chose and why.

### 5. Proof that it runs without the cloud

`npm run verify:local` (writes `reports/day27_verify.md`):
- Starts the app's routes in-process with an in-memory store, no `ANTHROPIC_API_KEY`, and a
  fetch guard that fails the run if any request goes to a host other than localhost.
- Sends a short multi-turn conversation through the real chat route for each supported
  agent and each local model: at least 3 messages, including one that only makes sense
  from an earlier message. It checks that every reply came from the local provider, is
  non-empty, and uses the earlier context.
- The report has each conversation, the replies with their metrics, and per model: mean
  time to first token, tokens/s, latency, and outbound non-localhost requests (expected: 0).

Also add a manual check to the README: turn Wi-Fi off, `npm start`, chat.

## Tests

`npm test` stays offline, with a fake fetch for Ollama. Test the message mapping, the
metrics, the JSON-schema path and its retry, the readable errors (server down, model
missing, timeout), that a local chat never calls the Anthropic provider, and that the
per-chat model setting is stored and respected.

## Docs

- first-agent README: a **Local models (Day 27)** section covering the provider, the switch,
  which agents and features work locally, the env table, `verify:local`, and the manual check.
- Repo root README: a "Day 27 — Integrating a local LLM into an application" section at the
  top, like the previous days. Two or three sentences, a small table from the real
  `verify:local` numbers per model, and links. Add `local_llm` to the Projects table if
  Day 26 didn't.

## Finish

Run `npm test` and `npm run verify:local` with Ollama running, and fix anything that fails.
Then start the server so I can try it at http://localhost:3000. Tell me which features were
disabled for local chats, and why.
