#!/usr/bin/env node
/**
 * **Is the MCP connection real?**
 *
 * Connects to one registered MCP server — Notion by default, with the tokens
 * the app stored in `data/mcp/notion.json` — and prints what the server says
 * it is and every tool it offers. It never logs in by itself: with no tokens it
 * prints the authorization URL and points at the Connect button, because the
 * callback that finishes a login is a route on the running app.
 *
 *   npm run mcp:tools            # notion
 *   npm run mcp:tools -- omdb
 */

import { describeError } from "../src/mcp/mcpClient.js";
import { cliRegistry, connectOrExplain } from "./mcp-common.js";

const id = process.argv[2] || "notion";
const registry = cliRegistry();

try {
  const mcp = await connectOrExplain(registry, id);
  if (!mcp) {
    process.exitCode = 1;
  } else {
    const info = mcp.serverInfo ?? {};
    console.log(`Connected to ${info.name ?? "(unnamed server)"} ${info.version ?? ""}`.trimEnd());
    const tools = await mcp.listTools();
    console.log(`${tools.length} tool${tools.length === 1 ? "" : "s"}\n`);
    printTable(tools);
  }
} catch (err) {
  console.error(`Could not reach the MCP server: ${describeError(err)}`);
  process.exitCode = 1;
} finally {
  await registry.closeAll();
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
