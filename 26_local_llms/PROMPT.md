Day 26 of my AI challenge: launch a local LLM and verify it works. I already have Ollama
installed with two models (gemma4 and qwen3.5:9b — check `ollama list` for the exact tags,
don't assume them). Hardware: MacBook Air M2, 16 GB RAM.

Create a new sibling project `local_llm/` at the repo root, next to first-agent and
doc_index, following the same conventions: Node, ES modules, no build step, native fetch
(no Ollama SDK), npm scripts, offline tests, a README.

GOAL
Show that:
1. the model runs locally (Ollama server is up, models are installed),
2. it is reachable over the HTTP API (and via CLI),
3. it answers requests of varying complexity, with measured speed.

WHAT TO BUILD
- `src/ollama.js`: a tiny client for Ollama's native HTTP API at OLLAMA_URL
  (default http://localhost:11434): version, list models, and a non-streaming chat call.
  Options: model, messages, temperature (default 0), seed, num_predict, num_ctx, format
  (JSON schema), think (default false; record whether it was used). Return the text plus
  Ollama's own timing fields: total_duration, load_duration, prompt_eval_count,
  prompt_eval_duration, eval_count, eval_duration. Derive prompt tokens/s, generation
  tokens/s, and time to first token (≈ load + prompt eval).
- `npm run check`: Ollama reachable (version), models installed, one "say OK" request per
  model. If Ollama isn't running or a model is missing, print a readable message with the
  fix (`ollama serve`, `ollama pull …`), not a stack trace.
- `npm run bench [-- --model qwen3.5:9b]`: runs the request set below against each model
  (default: all models from `ollama list` that match the two above, overridable via
  LOCAL_MODELS). Models run one after another, never in parallel (16 GB RAM): one warm-up
  request per model that isn't counted (its load time is reported separately), then the set,
  then unload the model (keep_alive: 0) before the next one.

REQUEST SET (eval/requests.json, each with an automatic check)
1. simple: a short factual question with a known answer → check: contains the answer.
2. reasoning: a multi-step word problem with a single numeric answer → check: correct number.
3. structured: extract fields from a short text into JSON using Ollama's `format` with a
   JSON schema → check: valid JSON that validates against the schema and has the right values.
4. grounded (preview of Day 28): answer a question using only a provided passage — take one
   real chunk from ../doc_index/reports/chunks.structural.jsonl about Kotlin / Compose
   Multiplatform — and say "I don't know" if the passage doesn't contain it. Two variants:
   one answerable from the passage, one not → check: expected fact present / declined.

OUTPUT
- `reports/day26_results.json`: every request × model with text, check result and metrics,
  plus machine info (chip, RAM, Ollama version, model tags and quantization from /api/show).
- `reports/day26_report.md`: summary table per model (checks passed, load time, mean TTFT,
  mean generation tokens/s, mean total latency), then every request with each model's answer
  and metrics. Include short findings written from the actual numbers (what passed, what
  failed and why, the speed difference between the models).

DOCS
- README.md: what the project does, prerequisites (Ollama running, models pulled), the
  scripts, env vars (OLLAMA_URL, LOCAL_MODELS), and a "verify by hand" section with the
  equivalent `ollama run` command and a curl example against /api/chat.
- Add a "Day 26 — Launching a local LLM" section at the top of the repo root README, like the
  previous days: two or three sentences, the summary table with real numbers, and links to
  the report. Add local_llm to the Projects table.
- .gitignore for node_modules; .env.example with OLLAMA_URL and LOCAL_MODELS.

TESTS
`npm test`, offline, with a fake fetch: metric derivation from Ollama's nanosecond fields,
the checks for each request type, and the readable error when the server is down.

After building, run `npm test`, `npm run check` and `npm run bench`, and fix anything that
fails. Then show me the summary table.

