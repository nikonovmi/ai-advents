import { McpClient, NOTION_MCP_URL } from "./mcpClient.js";
import { DEFAULT_REDIRECT_URL } from "./oauthProvider.js";

/**
 * **Which MCP servers the app knows about.**
 *
 * A server is `{ id, name, url, auth }` and nothing else. `auth: "oauth"` is a
 * hosted server with a login (Notion), `auth: "none"` is one that answers
 * anybody who can reach it — in practice, one of ours on localhost. Everything
 * that differs between the two lives inside `McpClient`; the routes, the panel
 * and the agents only ever see an id.
 *
 * Like the agent registry, it is code rather than a store: a server is a URL
 * and a trust decision, and both belong in review.
 *
 * @typedef {{ id: string, name: string, url: string, auth: "oauth" | "none" }} McpServerDefinition
 */

export const OMDB_MCP_URL = "http://127.0.0.1:3001/mcp";

/**
 * Read at call time, not import time, so `.env` has been loaded by then.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {McpServerDefinition[]}
 */
export function mcpServerDefinitions(env = process.env) {
  return [
    { id: "notion", name: "Notion", url: env.NOTION_MCP_URL || NOTION_MCP_URL, auth: "oauth" },
    { id: "omdb", name: "OMDb", url: env.OMDB_MCP_URL || OMDB_MCP_URL, auth: "none" },
  ];
}

/** One `McpClient` per registered server, built once and shared. */
export class McpRegistry {
  /** @type {Map<string, { definition: McpServerDefinition, client: McpClient }>} */
  #entries = new Map();

  /**
   * @param {{
   *   servers?: McpServerDefinition[],
   *   authStore?: import("../store/mcpAuthStore.js").McpAuthStore,
   *   redirectUrl?: string,
   *   createClient?: () => any,
   *   createTransport?: (options: object) => any,
   * }} [options] - The two factories are handed to every client, which is how
   *   the tests stand a whole registry up without a network.
   */
  constructor({ servers = mcpServerDefinitions(), authStore, redirectUrl = DEFAULT_REDIRECT_URL, createClient, createTransport } = {}) {
    for (const definition of servers) {
      if (this.#entries.has(definition.id)) throw new Error(`MCP server "${definition.id}" is registered twice`);
      const client = new McpClient({
        server: definition.id,
        url: definition.url,
        auth: definition.auth,
        authStore,
        redirectUrl,
        ...(createClient ? { createClient } : {}),
        ...(createTransport ? { createTransport } : {}),
      });
      this.#entries.set(definition.id, { definition: { ...definition }, client });
    }
  }

  has(id) {
    return this.#entries.has(id);
  }

  /** @returns {McpClient | undefined} */
  get(id) {
    return this.#entries.get(id)?.client;
  }

  /** @returns {McpServerDefinition | undefined} */
  definition(id) {
    const entry = this.#entries.get(id);
    return entry ? { ...entry.definition } : undefined;
  }

  /** Every registered server, in order: one section each in the panel. */
  list() {
    return [...this.#entries.values()].map(({ definition }) => ({ ...definition }));
  }

  /** @returns {McpClient[]} */
  clients() {
    return [...this.#entries.values()].map(({ client }) => client);
  }

  async closeAll() {
    await Promise.all(this.clients().map((client) => client.close()));
  }
}
