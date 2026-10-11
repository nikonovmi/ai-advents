import path from "node:path";

import dotenv from "dotenv";
import express from "express";
import { localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
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

// What `createMcpExpressApp` does — DNS-rebinding protection, then JSON — but
// with room for a finish_run that carries every step's input and output:
// express's default 100 kB is one long search result away.
const app = express();
app.use(localhostHostValidation());
app.use(express.json({ limit: "8mb" }));

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
  if (scheduler.migrated) console.log(`Migrated ${scheduler.migrated} older schedule(s) to goal + plan.`);
});

// Close the database cleanly, so the WAL is checkpointed on the way out.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    listener.close();
    scheduler.close();
    process.exit(0);
  });
}
