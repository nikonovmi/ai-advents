# Day 21 — Document indexing

Build a new project `doc_index/` next to `first-agent/`, `imdb_mcp_server/` and
`scheduler_mcp_server/`. It turns a corpus of documents into a local vector index with
metadata, using two chunking strategies, and produces a report comparing them.
Retrieval and generation come in later days, so keep the search code small but reusable
(`first-agent` will import it).

## Stack

- Node 20+, ES modules, no TypeScript, no build step. Same style as the sibling projects.
- Embeddings: **EmbeddingGemma-300M**, run locally via `@huggingface/transformers`
  (v3 or later), model id `onnx-community/embeddinggemma-300m-ONNX`, `dtype: "q8"`.
  - It does not support fp16. Use `q8` by default and allow `fp32` via `EMBED_DTYPE`.
  - Load it with `AutoTokenizer` + `AutoModel` and use the model's `sentence_embedding`
    output, as shown on the model card. Do not use a pipeline with mean pooling.
  - It needs prefixes. Documents: `title: {title} | text: {text}`. Queries:
    `task: search result | query: {text}`. Put both in one module (`src/embed.js`)
    so nothing else ever embeds without them.
  - It outputs 768 dims and supports Matryoshka truncation. Add `EMBED_DIMS`
    (768 | 512 | 256 | 128). When it's below 768, truncate and re-normalise.
  - Vectors are L2-normalised, so cosine similarity = dot product.
  - The first run downloads the model to the transformers.js cache. After that,
    everything runs offline with no API key.
- Storage: SQLite via `better-sqlite3`, one file `data/index.sqlite`. Embeddings are
  stored as `Float32Array` BLOBs. Search is brute-force dot product in JS. FAISS is
  unnecessary at this size.
- Parsing: `cheerio` for HTML, `unpdf` (or `pdfjs-dist`) for PDF. Markdown and code are
  read as text.

## Corpus

At least 30 pages of text in total (count ~3,000 characters as one page). Use several
formats so the loaders are real:

1. **`knowledge_database/`** (main source): a folder of HTML files the user has already
   put in place. First find where it is (the repo root or inside `doc_index/`). Then set
   the default path in config, overridable with `KNOWLEDGE_DIR`. Read every `.html` /
   `.htm` file in it recursively. Never modify, move, or rename them. These files are
   not committed: add `knowledge_database/` to the `.gitignore` that covers its location.
   If any are already tracked, run `git rm -r --cached` on them, leaving the files on
   disk.
2. **Our own projects**: every `README.md` and `PROMPT.md` in the repo root and the three
   sibling projects, plus the `.js` files under `first-agent/src/` and both MCP servers'
   `src/`. Copy them by path from a config. Don't hardcode absolute paths. Skip
   `node_modules`, `data`, and tests.
3. **PDF**: "Attention Is All You Need", `https://arxiv.org/pdf/1706.03762`.

`npm run fetch` downloads 3 into `corpus/raw/` and copies 2 into `corpus/raw/projects/`.
It's idempotent: existing files are skipped unless `--force` is passed. Sources live in
`corpus/sources.json`, so the list is easy to change. `knowledge_database/` is read in
place, not copied. `corpus/raw/` is git-ignored.

If `knowledge_database/` already reaches 30 pages on its own, say so in the stats. 2 and
3 still stay, so markdown, code, and PDF are covered.

## Pipeline

```
fetch → load (per format) → normalised documents → chunk (×2 strategies) → embed → store
```

### Loaders → normalised document

Each loader returns:

```js
{ doc_id, source, format, title, text, sections: [{ path: ["H1", "H2"], start, end }] }
```

`text` is clean plain text with paragraphs separated by blank lines. `sections` are
character ranges into `text`, used by both chunkers to set the `section` metadata.

- **html**: The files in `knowledge_database/` come from arbitrary sites, so open a few
  before writing the loader. Find the main content generically: the first match of
  `main`, `article`, `[role=main]`, `#content`, or `#mw-content-text`. Fall back to
  `body`. Drop `script`, `style`, `nav`, `header`, `footer`, `aside`, `form`, cookie
  banners, sidebars, reference lists, and edit links. `title` comes from the first `h1`,
  then `<title>`, then the file name. Headings `h1`–`h4` become sections. Tables become
  simple `a | b` rows or are dropped. Don't emit raw markup. `doc_id` is derived from the
  path relative to `knowledge_database/`. If a file yields almost no text after cleanup,
  log a warning naming it instead of silently indexing nothing.
- **markdown**: `#` headings are sections. Fenced code stays as text.
- **code** (`.js`): There are no headings. Sections are top-level declarations (`export`,
  `function`, `class`, `const x = ` at column 0), each named after the identifier.
  `title` is the relative file path.
- **pdf**: Extract text per page, then fix hyphenation and line wraps. Detect section
  headings by the numbered-heading pattern (`3.2 Attention`) and fall back to
  `Page N` sections if none are found.

### Chunking strategies

Count tokens with the EmbeddingGemma tokenizer, not characters. Both strategies are
pure functions `(doc, tokenizer, options) → chunks[]` in `src/chunkers/`.

1. **fixed**: windows of 300 tokens with 50 tokens of overlap. Ignore structure, but move
   each boundary to the nearest whitespace so words are never cut. `section` = the
   section containing the chunk's start.
2. **structural**: one chunk per section (heading section, code declaration, or PDF
   section). Merge sections under 40 tokens into the following sibling. Split sections
   over 500 tokens at paragraph boundaries, or at line boundaries for code. Fall back to
   sentence boundaries only when a single paragraph exceeds 500 tokens.
   `section` = the breadcrumb, e.g. `Pipelines › Steps`.

Options (sizes, overlap, thresholds) live in one config object and are stored with the
index. Changing them must trigger a rebuild.

### Chunk record

```js
{
  chunk_id,      // `${doc_id}:${strategy}:${index}`; stable across runs if inputs are unchanged
  strategy,      // "fixed" | "structural"
  doc_id, source, format, title,
  section,       // breadcrumb string
  index,         // position within the doc for this strategy
  char_start, char_end, token_count,
  text,          // the chunk as stored and shown
  content_hash   // sha256 of the exact string sent to the embedder
}
```

The string sent to the embedder is `title: {title} | text: {text}`, the same rule for
both strategies so the comparison is fair. Do not inject the section breadcrumb into the
embedded text. It stays metadata only, and a later day can test whether adding it helps.

### Embedding and storage

- Embed in batches (16 by default) and log progress (`fixed 120/412`).
- Cache by `content_hash` plus model id, dtype, and dims. Re-running `npm run index`
  without changes embeds nothing.
- Tables: `meta` (model id, dtype, dims, prefixes, chunker config, created_at),
  `documents`, `chunks` (all fields above), `embeddings` (`chunk_id`, `vector BLOB`).
  If the stored model, dtype, or dims differ from the current settings, refuse to mix
  them and tell the user to run `npm run index -- --rebuild`.
- `npm run export` also writes `data/index.<strategy>.json` (chunks + metadata +
  vectors as arrays), for inspection and for anyone who wants the JSON variant.

### Search (minimal, for evaluation)

`src/search.js` exports `search(query, { strategy, k = 5 })`. It embeds the query with
the query prefix and returns chunks with `score`, sorted by score. It loads the vectors
of one strategy into memory once and reuses them.

## Comparison

`npm run compare` writes `reports/comparison.md` and prints a summary table.

1. **Stats per strategy**: chunk count; token count min / median / p90 / max;
   percentage of chunks starting or ending mid-sentence; percentage of chunks spanning
   more than one section; total embedded tokens and embedding time.
2. **Retrieval eval**: `eval/questions.json` holds 15–20 questions written after reading
   the corpus. Spread them across sources and formats: at least half from
   `knowledge_database/`, the rest from our READMEs, code, and the PDF. Include a few phrased without the document's own wording. Each question has
   `{ id, question, expected_source, expected_text }`, where `expected_text` is a short
   phrase (3–10 words) that a correct chunk must contain. A hit = a chunk from
   `expected_source` whose text contains `expected_text`, ignoring case and whitespace.
   Report hit@1, hit@3, hit@5, and MRR per strategy. Add a per-question table showing
   which strategy found the answer and at what rank, plus the top-1 chunk's `section`
   for each strategy.
3. **Findings**: a short section written from the actual numbers. Say where each
   strategy wins and why, using 2–3 concrete examples of questions where they differ.
   Don't write conclusions the numbers don't support.

## Scripts

| script | does |
| --- | --- |
| `npm run fetch [-- --force]` | gather the corpus |
| `npm run index [-- --rebuild] [-- --strategy fixed]` | load, chunk, embed, store (both strategies by default) |
| `npm run search -- "query" [--strategy structural] [--k 5]` | print top-k with score, source, section, and the first 200 chars |
| `npm run compare` | stats + retrieval eval → `reports/comparison.md` |
| `npm run stats` | corpus size (chars, est. pages, per source) and chunk counts |
| `npm run export` | JSON copies of the index |
| `npm test` | offline tests: no network, no model download |

## Tests (`node --test`)

Use a fake embedder (deterministic hash → vector) and a fake whitespace tokenizer
behind the same interfaces, so tests never load the real model.

- Loaders: a small HTML fixture loses its nav/script/footer and keeps headings as
  sections. Markdown sections are correct. The code loader finds the declarations.
- fixed: windows respect size and overlap, never cut a word, and cover the whole text.
- structural: tiny sections get merged, oversized ones get split, breadcrumbs are
  correct, and every chunk fits the token limit.
- `chunk_id`s are stable across two runs. The cache skips unchanged chunks.
- Search returns results in score order and refuses an index built with another model.

## Project setup

- `package.json` with `"type": "module"`. `.gitignore`: `node_modules`, `data/`,
  `corpus/raw/`, `.env`, plus `knowledge_database/` (see Corpus). Check with
  `git status` / `git check-ignore` that no file from `knowledge_database/` is staged.
- Env vars (all optional): `KNOWLEDGE_DIR`, `EMBED_MODEL`, `EMBED_DTYPE`, `EMBED_DIMS`,
  `EMBED_BATCH`. Add `.env.example` and load it with `dotenv`.
- `README.md` in the style of the sibling projects: what it is, the commands above, the
  index schema, and a link to `reports/comparison.md`. Add a row for `doc_index` to the
  root README's project table.

## Done when

1. `npm run fetch && npm run index` builds both indexes from a corpus of at least 30
   estimated pages (`npm run stats` shows the total).
2. `npm run search -- "how does the planner validate a plan?"` returns
   `first-agent` chunks at the top for both strategies, and a question about a topic
   from `knowledge_database/` returns chunks from that folder.
3. `npm run compare` produces `reports/comparison.md` with real numbers and findings.
4. `npm test` passes offline.

Run steps 1–4 yourself and fix what fails before reporting back. In the final message,
include the summary table from `npm run compare`.
