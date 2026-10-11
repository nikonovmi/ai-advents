# imdb_mcp_server

MCP server exposing [OMDb](https://www.omdbapi.com) as three tools, over stateless
streamable HTTP at `http://127.0.0.1:3001/mcp` (localhost only).

```bash
npm install
cp .env.example .env   # OMDB_API_KEY=… (free key; click the activation link OMDb emails)
npm start              # PORT overrides 3001
npm test               # offline, fetch stubbed
```

Without a key the server still starts; every call returns `isError` with instructions.
The key never appears in a result, log or error.

## Tools

| tool | input | returns |
| --- | --- | --- |
| `search_movies` | `query` (title words only), `year?`, `type?`, `page?` | `{ results: [{ title, year, imdbId, type }] ≤ 10, totalResults }` |
| `get_movie` | exactly one of `imdbId` / `title`; `year?`, `plot?` | `{ title, year, runtimeMinutes, genres, director, actors, plot, imdbRating, ratings, imdbId }` |
| `random_movie` | none | `get_movie`'s shape plus `n`, `pickedAt`: one of 500 well-known films, picked by the clock |

Every tool declares an `outputSchema` and returns matching `structuredContent`.
Values are normalized: `"148 min"` → `148`, `"N/A"` → `null`. Failures are `isError`
with a readable sentence, never a crash.
