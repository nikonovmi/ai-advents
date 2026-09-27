Day 17: build a local OMDb MCP server and let the agent call its tools.

PART 1: THE SERVER (new sibling project ./imdb_mcp_server, next to first-agent)
- Node + ES modules, @modelcontextprotocol/sdk (McpServer) + zod, Express.
  Check the SDK's current server docs for registerTool and the streamable HTTP
  server transport; don't guess signatures.
- Streamable HTTP at http://127.0.0.1:3001/mcp (stateless mode is fine).
  Bind to localhost only. console.log the URL on start.
- The API key is read from OMDB_API_KEY in the server's own .env via dotenv.
  The key never leaves this server.
- Create a .gitignore in imdb_mcp_server that excludes node_modules and .env.
  Add a .env.example with OMDB_API_KEY= (no value).
- Register three tools with zod input schemas and clear descriptions (the
  descriptions are what Claude reads, so make them useful):
  - search_movies { query: string, year?: int, type?: "movie"|"series"|"episode",
    page?: int 1-100 } → up to 10 { title, year, imdbId, type }.
  - get_movie { imdbId?: string, title?: string, year?: int,
    plot?: "short"|"full" } → exactly one of imdbId/title is required; reject
    otherwise. Returns title, year, runtimeMinutes (parsed to a number), genres[],
    director, actors[], plot, imdbRating (number or null), ratings[], imdbId.
  - random_movie { genre?: string } → picks from a curated list of ~30 IMDb ids
    in the source (OMDb has no random endpoint), fetches it via get_movie's logic.
- Result return: normalized JSON as text content (plus structuredContent if the
  SDK version supports it). OMDb's {"Response":"False","Error":...}, network
  failures and a missing OMDB_API_KEY → isError: true with a readable message,
  never a crash. Wrap OMDb calls in one small client module with a timeout.
- Tests (node:test, no network): stub fetch, check the input validation, the
  normalization (runtime "148 min" → 148, "N/A" → null) and the error mapping.
- README: install, key setup (omdbapi.com, activation link, OMDB_API_KEY in
  .env), npm start, tool list.

PART 2: REGISTER IT IN first-agent LIKE NOTION
- Generalize the Day 16 MCP code into a registry (src/mcp/servers.js):
  { id, name, url, auth: "oauth"|"none" }. Notion stays auth "oauth" with its
  existing provider and callback; the new entry is { id:"omdb", name:"OMDb",
  url: OMDB_MCP_URL || "http://127.0.0.1:3001/mcp", auth:"none" }.
- Routes become per-server: /mcp/:server/status, /connect, /tools, /disconnect.
  Keep the Notion OAuth callback working. For auth "none", connect never
  returns authUrl. If the server is down, report connected:false with the
  reason instead of throwing.
- The UI panel renders one section per registered server (status dot,
  connect/disconnect, tool list). Same component, no Notion special-casing.

PART 3: THE AGENT CALLS THE TOOL
- Agents opt in: in src/agents.js add mcpServers: ["omdb"] to one agent (or a
  new "Movie buff" agent). Agents without it behave exactly as before.
- LlmProvider gains tool support: pass tools (MCP name/description/inputSchema
  mapped to Anthropic's tool format, name-prefixed like "omdb__get_movie" to
  avoid collisions) and return tool_use blocks. FakeProvider must be scriptable
  to emit a tool_use, so the loop is testable offline.
- In Agent.run(), after the strategy builds the payload: loop model call →
  if stop_reason is "tool_use", call each tool via the MCP client
  (client.callTool), append tool_use + tool_result (is_error when the tool
  failed), and call the model again → until a final text reply. Cap it at 5
  tool rounds with a clear fallback message. Add every round's tokens to the
  turn's usage.
- Persistence: don't put raw tool_use/tool_result blocks into the record's
  messages. That would break boundaries.js (pairs never split, the payload opens
  on a user message) and the digest fold. Store the final assistant text as
  usual and attach toolCalls: [{ server, tool, input, ok, resultPreview,
  ms }] to that message.
- UI: under an assistant reply that used tools, a collapsible "🔧 omdb.get_movie
  (230 ms)" row showing input and the result preview. It's plain text, not
  Markdown.

TESTS (first-agent, still offline)
- Registry and routes with auth "none"; server down → connected:false.
- Tool loop with FakeProvider + stub MCP client: single call, a chained
  search→get call, a tool error → is_error passed back, the round cap, usage
  summed, toolCalls saved, and history still valid under boundaries.js.
- The existing 144 tests stay green.

DONE WHEN
Start ../imdb_mcp_server (3001) and first-agent (3000). In the movie agent,
asking "Is Inception longer than The Matrix, and which is rated higher?" makes
the agent call search/get_movie, the panel shows the calls, and the answer uses
the real runtimes and ratings. Also add npm run mcp:call -- omdb get_movie
'{"title":"Inception"}' as a direct CLI check. Then run both test suites and
start both servers.
