# doc_index

Turns a corpus of documents into a local vector index, chunked two ways (fixed windows
and document structure), and compares the two. Embeddings come from
[EmbeddingGemma-300M](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX),
run locally through `@huggingface/transformers`. Storage is one SQLite file, and search
is a brute-force dot product. There's no API key, and after the first model download
it runs offline.

```bash
npm install
npm run fetch      # PDF → corpus/raw/, our READMEs + sources → corpus/raw/projects/
npm run index      # first run downloads the model (~300 MB) into the transformers.js cache
npm run search -- "how does the planner validate a plan?"
npm run compare    # → reports/comparison.md
```

| script | does |
| --- | --- |
| `npm run fetch [-- --force]` | gather the corpus; existing downloads and unchanged copies are skipped |
| `npm run index [-- --rebuild] [-- --strategy fixed]` | load, chunk, embed, store (both strategies by default) |
| `npm run search -- "query" [--strategy structural] [--k 5]` | top-k with score, source, section and the first 200 chars (both strategies unless one is named) |
| `npm run compare` | stats + retrieval eval → [`reports/comparison.md`](reports/comparison.md) |
| `npm run stats` | corpus size (chars, est. pages, per collection) and chunk counts |
| `npm run export` | `data/index.<strategy>.json` (chunks, metadata, vectors; git-ignored) and `reports/chunks.<strategy>.jsonl` (chunks without vectors; committed) |
| `npm test` | offline tests: fake tokenizer and embedder, no network, no model |

Env (all optional, see `.env.example`): `KNOWLEDGE_DIR` (default `../knowledge_database`),
`EMBED_MODEL`, `EMBED_DTYPE` (`q8` | `fp32`; the model has no fp16), `EMBED_DIMS`
(768 | 512 | 256 | 128, Matryoshka truncation and re-normalisation), `EMBED_BATCH` (16).

## Corpus

Listed in [`corpus/sources.json`](corpus/sources.json):

- **`knowledge_database/`**: HTML pages saved from the web, read in place and never
  modified. It's git-ignored (`../.gitignore`). A page that has almost no text left after
  cleanup (one of them is a CAPTCHA page) is named in a warning and skipped.
- **projects**: the README/PROMPT files of the repo root and the three sibling projects,
  plus every `.js` under their `src/` (tests, `testing/` and fixtures skipped).
- **PDF**: "Attention Is All You Need" (arXiv 1706.03762).

## Pipeline

```
fetch → load (html | markdown | code | pdf) → { doc_id, source, format, title, text, sections }
      → chunk (fixed, structural) → embed ("title: … | text: …") → SQLite
```

- **Loaders** (`src/loaders/`) produce plain text plus `sections`, which are character
  ranges with a heading breadcrumb. HTML: the first `main`/`article`/… then narrowed to the
  block that holds the paragraphs; chrome removed; h1–h4 become sections. Markdown: `#`
  headings. Code: top-level declarations. PDF: numbered headings (`3.2 Attention`), or
  `Page N` if there are none.
- **fixed** (`src/chunkers/fixed.js`): windows of 300 tokens with 50 tokens of overlap,
  cut only at whitespace. `section` is where the window starts.
- **structural** (`src/chunkers/structural.js`): one chunk per section. A section under
  40 tokens merges into the next one. A section over 500 tokens is split at paragraphs
  (for code, blank lines and then lines), then sentences, then words, as each is needed.
- Tokens are counted with the EmbeddingGemma tokenizer. Both strategies embed the same
  string, `title: {title} | text: {chunk}`. The breadcrumb is metadata only.
- Vectors are cached by `content_hash` + model + dtype + dims, so re-running `index`
  without changes embeds nothing. Changing the chunker config (`src/config.js`) re-chunks
  automatically.

## Index schema (`data/index.sqlite`)

| table | columns |
| --- | --- |
| `meta` | `key`, `value` (JSON): `embedding` {modelId, dtype, dims, prefixes}, `chunker`, `embed_stats`, `created_at`, `updated_at` |
| `documents` | `doc_id`, `collection`, `source`, `format`, `title`, `char_count`, `text`, `sections` |
| `chunks` | `chunk_id` (`doc_id:strategy:index`), `strategy`, `doc_id`, `source`, `format`, `title`, `section`, `idx`, `char_start`, `char_end`, `token_count`, `text`, `content_hash` |
| `embeddings` | `chunk_id`, `vector` (Float32Array BLOB) |
| `embedding_cache` | `content_hash`, `model`, `dtype`, `dims`, `vector` |

An index built with a different model, dtype or dims is refused by both `index` and
`search`. To start over, run `npm run index -- --rebuild`.

## Using search from another project

`first-agent`'s Knowledge agent (Day 22) uses exactly this: `search()` with
`strategy: "structural"`, `k: 5`, and optionally `collections` (its `RAG_COLLECTIONS`).

```js
import { search } from "../doc_index/src/search.js";
const hits = await search("how does the planner validate a plan?", { strategy: "structural", k: 5 });
// [{ score, chunk_id, source, section, title, collection, text, char_start, char_end, … }]

// Only some collections (`knowledge`, `projects`, `downloads`); absent or [] means all.
await search("what's new in Compose Multiplatform 1.8?", { k: 5, collections: ["knowledge"] });
```

A failed first load (no index, another model) is not cached: the next call tries again.

### Reranking (Day 23)

`src/rerank.js` (`doc_index/rerank`) is the second retrieval stage that first-agent's
Knowledge agent can switch on: a local cross-encoder,
[`onnx-community/bge-reranker-v2-m3-ONNX`](https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX)
(int8 `model_quantized.onnx`, ~570 MB, downloaded into the transformers.js cache on first use),
that scores (query, chunk) pairs and maps each logit to 0–1 with a sigmoid.

```js
import { loadReranker } from "../doc_index/src/rerank.js";
const reranker = await loadReranker();               // RERANK_MODEL / RERANK_DTYPE override
const scores = await reranker.score("how big is the iOS app?", hits.map((h) => h.text)); // [0.94, 0.003, …]
```

Pairs are scored one per pass: the int8 model quantizes activations per batch, so in a padded
batch a chunk's score shifted with its neighbours. `createReranker({ scoreRaw })` wraps a fake
for the tests.

`createSearcher({ dbPath, embedder })` does the same with an injected embedder, which is
how the tests use it.

## Comparison

See [`reports/comparison.md`](reports/comparison.md). It has chunk stats, hit@1/3/5 and
MRR over the 20 questions in [`eval/questions.json`](eval/questions.json), a per-question
table, and findings. To read the chunks themselves without building the index, see
[`reports/chunks.fixed.jsonl`](reports/chunks.fixed.jsonl) and
[`reports/chunks.structural.jsonl`](reports/chunks.structural.jsonl). Each line holds
`chunk_id`, `source`, `section`, `token_count`, `char_start`, `char_end`, and `text`. [`reports/notes.md`](reports/notes.md) is the hand-written analysis
that gets included in it.
