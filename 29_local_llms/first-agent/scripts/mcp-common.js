import "dotenv/config";

import { McpRegistry } from "../src/mcp/servers.js";
import { JsonMcpAuthStore } from "../src/store/mcpAuthStore.js";

const PORT = Number(process.env.PORT) || 3000;

/** The same registry the app builds, pointed at the same token files. */
export function cliRegistry() {
  return new McpRegistry({
    authStore: new JsonMcpAuthStore(),
    redirectUrl: `http://localhost:${PORT}/mcp/oauth/callback`,
  });
}

/**
 * Connect one server or explain why not. Returns the client, or null after
 * printing what to do.
 */
export async function connectOrExplain(registry, id) {
  const mcp = registry.get(id);
  if (!mcp) {
    console.error(`No MCP server "${id}". Registered: ${registry.list().map((server) => server.id).join(", ")}.`);
    return null;
  }
  const result = await mcp.connect();
  if (result.ok) return mcp;
  console.log(`Not authorized yet — there are no usable tokens in data/mcp/${id}.json.\n`);
  if (result.authUrl) console.log(`Authorization URL:\n  ${result.authUrl}\n`);
  console.log(`Run the app (npm start), open http://localhost:${PORT} and click Connect under "MCP · ${registry.definition(id).name}".`);
  return null;
}
