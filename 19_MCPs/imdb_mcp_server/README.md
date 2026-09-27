# imdb_mcp_server

A local [MCP](https://modelcontextprotocol.io) server that exposes
[OMDb](https://www.omdbapi.com) (the IMDb-backed Open Movie Database) as three tools.
Node + ES modules, `@modelcontextprotocol/sdk` (`McpServer`) + `zod`, stateless
streamable HTTP on `http://127.0.0.1:3001/mcp` — bound to localhost only.

## Install

```bash
npm install
```

## OMDb key

1. Request a free key at <https://www.omdbapi.com/apikey.aspx> (the FREE tier is
   1,000 requests a day).
2. OMDb emails an **activation link** — click it, or every request answers
   `Invalid API key!`.
3. Put the key in this project's own `.env` (copy `.env.example`):

   ```
   OMDB_API_KEY=your-key
   ```

The key is read only here, only when a tool runs, and never appears in a tool result,
a log line or an error message. `.env` is git-ignored. Without a key the server still
starts; every tool call answers `isError: true` with instructions.

## Run

```bash
npm start      # OMDb MCP server listening at http://127.0.0.1:3001/mcp
npm test       # node:test, fetch stubbed — no key, no network
npm run validate:top500   # manual: checks src/top500.js against OMDb (~500 of 1,000 daily requests)
```

`PORT` overrides 3001. From `../first-agent`:

```bash
npm run mcp:tools -- omdb
npm run mcp:call -- omdb get_movie '{"title":"Inception"}'
```

## Tools

| tool | input | returns |
| --- | --- | --- |
| `search_movies` | `query` (title words), `year?`, `type?` (`movie` \| `series` \| `episode`), `page?` (1–100) | `{ results: [{ title, year, imdbId, type }] ≤ 10, totalResults }` |
| `get_movie` | exactly one of `imdbId` \| `title`; `year?`, `plot?` (`short` \| `full`) | `{ title, year, runtimeMinutes, genres[], director, actors[], plot, imdbRating, ratings[], imdbId }` |
| `random_movie` | none | `{ n, pickedAt, ...get_movie }` for one of 500 well-known, highly rated films |

Results are normalized JSON: `"148 min"` → `148`, `"8.8"` → `8.8`, `"N/A"` → `null`
(or `[]` for lists). Each result is JSON text content plus `structuredContent`.

`random_movie` picks `n = hash(Date.now()) % 500` (multiplicative hash, high half
folded down so 15 s ticks spread over all 500).

Failures are `isError: true` with a readable sentence, never a crash: invalid input
(including both or neither of `imdbId`/`title`), OMDb's own
`{"Response":"False","Error":…}` (`OMDb: Movie not found!`), a network failure, the
8-second timeout, and a missing key.

## Layout

```
src/
  server.js        Express + StreamableHTTPServerTransport, stateless, 127.0.0.1
  tools.js         zod schemas, handlers, registerTool ×3, toolResult()
  omdbClient.js    the only code that talks to OMDb: one GET, timeout, OmdbError
  normalize.js     OMDb's strings → numbers, arrays and nulls
  top500.js        the random_movie pool: 500 IMDb ids (OMDb has no random endpoint)
  tools.test.js    offline tests: normalization, validation, error mapping, over MCP
```
