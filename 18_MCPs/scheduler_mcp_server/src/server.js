import path from "node:path";

import dotenv from "dotenv";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { DEFAULT_DB_PATH, openScheduler } from "./db.js";
import { createServer } from "./tools.js";

// The server's own .env, wherever it was started from.
dotenv.config({ path: path.join(import.meta.dirname, "..", ".env"), quiet: true });

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 3002;
const DB_FILE = process.env.SCHEDULER_DB ? path.resolve(process.env.SCHEDULER_DB) : DEFAULT_DB_PATH;

// One database handle for the life of the process; one MCP server per request.
const scheduler = openScheduler({ file: DB_FILE });

// DNS-rebinding protection for a localhost server comes with this helper.
const app = createMcpExpressApp({ host: HOST });

/**
 * Stateless streamable HTTP, like the OMDb server: a fresh server and
 * transport per POST, no session ids. Everything worth remembering is in
 * SQLite, not in a session.
 */
app.post("/mcp", async (req, res) => {
  const server = createServer({ scheduler });
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

const notAllowed = (_req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
};
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

const listener = app.listen(PORT, HOST, (err) => {
  if (err) {
    console.error(`Could not start on ${HOST}:${PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Scheduler MCP server listening at http://${HOST}:${PORT}/mcp`);
  console.log(`Database: ${scheduler.file}`);
});

// Close the database cleanly, so the WAL is checkpointed on the way out.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    listener.close();
    scheduler.close();
    process.exit(0);
  });
}
