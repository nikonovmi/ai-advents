# local_llm

Day 26: run an LLM locally and verify that it works. This project talks to
[Ollama](https://ollama.com) over its native HTTP API (plain `fetch`, no SDK). It checks
that the server is up and the models are installed, then benchmarks each model on five
requests of increasing complexity. Every answer gets an automatic check, and speed is
measured from Ollama's own timing fields.

Results: **[`reports/day26_report.md`](reports/day26_report.md)** (raw data in
[`reports/day26_results.json`](reports/day26_results.json)).

## Prerequisites

- Node ≥ 20.12 (no dependencies, so `npm install` does nothing)
- Ollama running: the macOS app, or `ollama serve`
- The models pulled:

```bash
ollama pull gemma4:12b
ollama pull qwen3.5:9b
```

Each model is about 8 GB, so on a 16 GB machine they run one at a time.

## Scripts

```bash
npm run check                         # server up (HTTP + CLI), models installed, one "say OK" per model
npm run bench                         # the request set against each model → reports/day26_*
npm run bench -- --model qwen3.5:9b   # one model
npm run bench -- --only reasoning,structured
npm run report                        # re-render the .md from the .json (no model calls)
npm test                              # offline, with a fake fetch
```

When Ollama is down or a model is missing, `check` and `bench` print the fix
(`ollama serve`, `ollama pull …`) and exit 1, with no stack trace.

`bench` runs the models **one after another**. For each model it does:

1. a warm-up "Say OK." request, which isn't counted; its `load_duration` is reported as the load time
2. the five requests, with temperature 0, seed 42, `think: false`
3. `keep_alive: 0`, which unloads the model before the next one loads

## The request set ([`eval/requests.json`](eval/requests.json))

| id | what | check |
| --- | --- | --- |
| `simple` | capital of Australia | answer contains "Canberra" |
| `reasoning` | 3-step word problem (fractions, %, integer division) | final number (`Answer: N`) is 7 |
| `structured` | order message → JSON via `format` = JSON schema | valid JSON, valid against the schema, 8 expected values |
| `grounded-answerable` | question about one real doc_index chunk (CMP 1.8.0 on iOS) | mentions "9 MB", doesn't decline |
| `grounded-unanswerable` | same chunk, question it doesn't cover | says "I don't know" |

The passage is chunk `…compose-multiplatform-1.8.0…:structural:3` from
`../doc_index/reports/chunks.structural.jsonl`. It is copied into `requests.json`, and a
test checks that the copy still matches the source.

## Metrics

All come from Ollama's response (nanoseconds, converted to ms):

| metric | from |
| --- | --- |
| load time | `load_duration` of the warm-up request |
| TTFT | `load_duration + prompt_eval_duration` (a non-streaming call can't see the first token directly) |
| prompt tok/s | `(prompt_eval_count − prompt_eval_cached_count) / prompt_eval_duration` |
| generation tok/s | `eval_count / eval_duration` |
| total latency | `total_duration` |

The report gives each model's mean per request, plus token-weighted rates (all tokens over
all time). Two-token answers have noisy rates, and the weighted rates are less affected by them.

## Env vars

Both optional; see [`.env.example`](.env.example). They can go in `local_llm/.env`.

- `OLLAMA_URL`: default `http://localhost:11434`
- `LOCAL_MODELS`: comma-separated tags, e.g. `gemma4:12b,qwen3.5:9b`. Default: every
  installed `gemma4*` / `qwen3.5*` model. `--model` overrides both.

## Verify by hand

The CLI:

```bash
ollama list                                   # installed models
ollama run qwen3.5:9b "What is the capital of Australia? Answer with the city name only." --verbose
ollama ps                                     # what's loaded right now
ollama stop qwen3.5:9b                        # unload
```

`--verbose` prints the same timings the bench reads (load duration, prompt eval rate, eval rate).

The HTTP API:

```bash
curl -s http://localhost:11434/api/version

curl -s http://localhost:11434/api/chat -d '{
  "model": "qwen3.5:9b",
  "messages": [{ "role": "user", "content": "What is the capital of Australia? Answer with the city name only." }],
  "stream": false,
  "think": false,
  "options": { "temperature": 0 }
}'
```

The response contains `message.content` plus `total_duration`, `load_duration`,
`prompt_eval_count`, `prompt_eval_duration`, `eval_count` and `eval_duration`.

## Layout

| file | role |
| --- | --- |
| `src/ollama.js` | the client: `version`, `list`, `show`, `chat`, `unload`, and `deriveMetrics` |
| `src/checks.js` | the four check types and a small JSON Schema validator |
| `src/bench.js` | model picking, the per-model run loop, machine info, the summary |
| `src/report.js` | results → markdown, with findings computed from the numbers |
| `scripts/` | `check`, `bench`, `report` |
