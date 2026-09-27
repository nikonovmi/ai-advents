#!/usr/bin/env node
/**
 * **Call one MCP tool directly — no model, no agent.**
 *
 *   npm run mcp:call -- omdb get_movie '{"title":"Inception"}'
 *
 * Prints the tool's text result. Exits 1 when the tool reports `isError`, the
 * JSON is not JSON, or the server cannot be reached.
 */

import { describeError } from "../src/mcp/mcpClient.js";
import { resultText } from "../src/mcp/toolbox.js";
import { cliRegistry, connectOrExplain } from "./mcp-common.js";

const [id, tool, json = "{}"] = process.argv.slice(2);
if (!id || !tool) {
  console.error(`Usage: npm run mcp:call -- <server> <tool> '<json input>'`);
  process.exit(2);
}

let input;
try {
  input = JSON.parse(json);
} catch (err) {
  console.error(`The input is not JSON: ${err.message}`);
  process.exit(2);
}

const registry = cliRegistry();
try {
  const mcp = await connectOrExplain(registry, id);
  if (!mcp) {
    process.exitCode = 1;
  } else {
    const started = Date.now();
    const result = await mcp.callTool(tool, input);
    const ms = Date.now() - started;
    console.log(`${result.isError ? "✗" : "✓"} ${id}.${tool} (${ms} ms)\n`);
    console.log(resultText(result));
    if (result.isError) process.exitCode = 1;
  }
} catch (err) {
  console.error(`Could not call ${id}.${tool}: ${describeError(err)}`);
  process.exitCode = 1;
} finally {
  await registry.closeAll();
}
