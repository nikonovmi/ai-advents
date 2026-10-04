import path from "node:path";

import dotenv from "dotenv";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createOmdbClient } from "./omdbClient.js";
import { createServer } from "./tools.js";

// The server's own .env, wherever it was started from.
dotenv.config({ path: path.join(import.meta.dirname, "..", ".env"), quiet: true });

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 3001;

// The key is read per call, so it is never copied anywhere else and a missing
// one is a tool error rather than a refusal to start.
const omdb = createOmdbClient({ apiKey: () => process.env.OMDB_API_KEY });

// DNS-rebinding protection for a localhost server comes with this helper.
const app = createMcpExpressApp({ host: HOST });

/**
 * Stateless streamable HTTP: a fresh server and transport per POST, no session
 * ids. There is nothing to remember between calls — every tool is a lookup.
 */
app.post("/mcp", async (req, res) => {
  const server = createServer({ omdb });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp]", err?.message ?? err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

// No sessions, so no server-initiated stream and nothing to delete.
const notAllowed = (_req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
};
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

app.listen(PORT, HOST, (err) => {
  if (err) {
    console.error(`Could not start on ${HOST}:${PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`OMDb MCP server listening at http://${HOST}:${PORT}/mcp`);
  if (!process.env.OMDB_API_KEY?.trim()) {
    console.warn("⚠️  OMDB_API_KEY is not set — every tool call will return an error until it is (see README).");
  }
});
