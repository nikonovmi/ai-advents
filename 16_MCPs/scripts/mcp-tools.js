#!/usr/bin/env node
/**
 * **Is the MCP connection real?**
 *
 * Connects to Notion's hosted MCP server with the tokens the app stored in
 * `data/mcp/notion.json` and prints what the server says it is and every tool
 * it offers. It never logs in by itself: with no tokens it prints the
 * authorization URL and points at the Connect button, because the callback
 * that finishes a login is a route on the running app.
 *
 *   npm run mcp:tools
 */

import "dotenv/config";

import { McpClient, NOTION_MCP_URL } from "../src/mcp/mcpClient.js";
import { JsonMcpAuthStore } from "../src/store/mcpAuthStore.js";

const PORT = Number(process.env.PORT) || 3000;

const mcp = new McpClient({
  server: "notion",
  url: process.env.NOTION_MCP_URL || NOTION_MCP_URL,
  authStore: new JsonMcpAuthStore(),
  redirectUrl: `http://localhost:${PORT}/mcp/oauth/callback`,
});

try {
  const result = await mcp.connect();
  if (!result.ok) {
    console.log("Not authorized yet — there are no usable tokens in data/mcp/notion.json.\n");
    if (result.authUrl) console.log(`Authorization URL:\n  ${result.authUrl}\n`);
    console.log(`Run the app (npm start), open http://localhost:${PORT} and click Connect under "MCP · Notion".`);
    process.exitCode = 1;
  } else {
    const info = result.serverInfo ?? {};
    console.log(`Connected to ${info.name ?? "(unnamed server)"} ${info.version ?? ""}`.trimEnd());
    const tools = await mcp.listTools();
    console.log(`${tools.length} tool${tools.length === 1 ? "" : "s"}\n`);
    printTable(tools);
  }
} catch (err) {
  console.error(`Could not reach the MCP server: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  await mcp.close();
}

function printTable(tools) {
  const width = Math.max(4, ...tools.map((tool) => tool.name.length));
  const room = Math.max(20, (process.stdout.columns || 100) - width - 3);
  console.log(`${"name".padEnd(width)}   description`);
  console.log(`${"-".repeat(width)}   ${"-".repeat(Math.min(room, 11))}`);
  for (const tool of tools) {
    const line = String(tool.description ?? "").replace(/\s+/g, " ").trim();
    const text = line.length > room ? line.slice(0, room - 1) + "…" : line;
    console.log(`${tool.name.padEnd(width)}   ${text}`);
  }
}
