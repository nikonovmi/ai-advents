import { describeError } from "./mcpClient.js";

/**
 * **MCP tools, as the agent sees them.**
 *
 * The agent never touches a client. It asks for the tools of the servers it
 * opted into and gets neutral `{ name, description, inputSchema }` definitions
 * whose names carry the server — `omdb__get_movie` — so two servers can both
 * have a `search` without colliding. It hands one of those names back with an
 * input and gets `{ ok, text }`.
 *
 * Nothing here throws at the agent: a server that is down makes its tools
 * absent from the list (with the reason beside it), and a call that fails is
 * `ok: false` with a sentence the model can read.
 */

export const SEPARATOR = "__";
/** How much of a result is kept on the stored message. The model gets all of it. */
export const PREVIEW_CHARS = 1500;
/** And how much of a result the model gets: a runaway tool must not fill the context. */
export const MAX_RESULT_CHARS = 20000;

/** Anthropic's rule for a tool name: `^[a-zA-Z0-9_-]{1,64}$`. */
export function prefixedName(server, tool) {
  return `${server}${SEPARATOR}${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/** A result's text parts, joined; structured content only when there is no text. */
export function resultText(result) {
  const text = (result?.content ?? [])
    .map((part) => (part?.type === "text" ? part.text : part?.type ? `[${part.type} content]` : ""))
    .filter(Boolean)
    .join("\n");
  if (text) return text;
  return result?.structuredContent ? JSON.stringify(result.structuredContent) : "";
}

export function preview(text, limit = PREVIEW_CHARS) {
  const value = String(text ?? "");
  return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
}

export class McpToolbox {
  #registry;
  /** Prefixed name → where it goes. Filled by `toolsFor`, read by `call`. @type {Map<string, { server: string, tool: string }>} */
  #routes = new Map();

  /** @param {{ registry: import("./servers.js").McpRegistry }} deps */
  constructor({ registry }) {
    this.#registry = registry;
  }

  /**
   * The tools of every server named, connecting to each on demand. A listing
   * is cached on the client, so a turn does not re-list what it listed last
   * turn.
   *
   * @param {string[]} serverIds
   * @returns {Promise<{ tools: Array<{ name: string, description: string, inputSchema: object }>, unavailable: Array<{ server: string, error: string }> }>}
   */
  async toolsFor(serverIds) {
    const tools = [];
    const unavailable = [];
    for (const server of serverIds ?? []) {
      const client = this.#registry.get(server);
      if (!client) {
        unavailable.push({ server, error: "not a registered MCP server" });
        continue;
      }
      try {
        const connected = await client.connect();
        if (!connected.ok) {
          unavailable.push({ server, error: "needs authorization" });
          continue;
        }
        const listed = client.tools ?? (await client.listTools());
        for (const tool of listed) {
          const name = prefixedName(server, tool.name);
          this.#routes.set(name, { server, tool: tool.name });
          tools.push({
            name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
          });
        }
      } catch (err) {
        unavailable.push({ server, error: describeError(err) });
      }
    }
    return { tools, unavailable };
  }

  /** Which server and tool a prefixed name is. */
  route(name) {
    const known = this.#routes.get(name);
    if (known) return known;
    const at = String(name).indexOf(SEPARATOR);
    return at > 0 ? { server: name.slice(0, at), tool: name.slice(at + SEPARATOR.length) } : { server: "", tool: String(name) };
  }

  /**
   * @param {string} name - A prefixed name from `toolsFor`.
   * @param {object} input
   * @returns {Promise<{ server: string, tool: string, ok: boolean, text: string, preview: string, ms: number }>}
   */
  async call(name, input) {
    const { server, tool } = this.route(name);
    const started = Date.now();
    const client = this.#registry.get(server);
    const done = (ok, text) => ({ server, tool, ok, text, preview: preview(text), ms: Date.now() - started });
    if (!client) return done(false, `Unknown tool "${name}".`);
    try {
      const result = await client.callTool(tool, input ?? {});
      const text = resultText(result) || (result?.isError ? "The tool failed without saying why." : "(no output)");
      return done(!result?.isError, text.slice(0, MAX_RESULT_CHARS));
    } catch (err) {
      return done(false, `Tool call failed: ${describeError(err)}`);
    }
  }
}
