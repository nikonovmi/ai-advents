import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import pkg from "../../package.json" with { type: "json" };
import { DEFAULT_REDIRECT_URL, StoredOAuthProvider } from "./oauthProvider.js";

/**
 * **One remote MCP server, as a seam.**
 *
 * `connect()`, `listTools()`, `close()` — and the two halves of a login that
 * the routes need, `finishAuth()` and `disconnect()`. Nothing above this knows
 * about transports, OAuth or the SDK: a connect either works or comes back
 * `{ ok: false, authUrl }`, and a 401 anywhere is "needs auth", never a crash.
 *
 * The SDK `Client` and the transport are built through two injected factories,
 * which is the whole of how the tests run without a network.
 */

export const NOTION_MCP_URL = "https://mcp.notion.com/mcp";

const CLIENT_INFO = { name: pkg.name, version: pkg.version };

/** @typedef {"streamable" | "sse"} TransportKind */
/** @typedef {{ name: string, description?: string, inputSchema?: object }} McpTool */

function defaultCreateClient() {
  return new Client(CLIENT_INFO, { capabilities: {} });
}

/** @param {{ kind: TransportKind, url: URL, authProvider: StoredOAuthProvider }} options */
function defaultCreateTransport({ kind, url, authProvider }) {
  return kind === "sse"
    ? new SSEClientTransport(url, { authProvider })
    : new StreamableHTTPClientTransport(url, { authProvider });
}

/** A 401 the SDK could not refresh its way out of. */
export function isUnauthorized(err) {
  return err instanceof UnauthorizedError || err?.code === 401;
}

/** Notion serves the legacy SSE transport beside `/mcp`, at `/sse`. */
function sseUrlFor(url) {
  const sse = new URL(url);
  sse.pathname = sse.pathname.replace(/\/mcp\/?$/, "/sse");
  return sse;
}

export class McpClient {
  #server;
  #url;
  #sseUrl;
  #store;
  #redirectUrl;
  #createClient;
  #createTransport;

  /** The live connection. @type {{ client: any, transport: any, provider: StoredOAuthProvider, kind: TransportKind } | null} */
  #live = null;
  /** The transport a login was started on; `finishAuth` belongs to it. */
  #pending = null;
  /** One connect at a time: a double click is one handshake. */
  #connecting = null;

  /** @type {{ name: string, version: string } | null} */
  serverInfo = null;
  /** The last listing, for the status line. @type {McpTool[] | null} */
  tools = null;
  /** Where the user has to go, if the last attempt ended in a 401. @type {string | null} */
  authUrl = null;

  /**
   * @param {{
   *   authStore: import("../store/mcpAuthStore.js").McpAuthStore,
   *   server?: string,
   *   url?: string | URL,
   *   sseUrl?: string | URL,
   *   redirectUrl?: string,
   *   createClient?: () => any,
   *   createTransport?: (options: { kind: TransportKind, url: URL, authProvider: StoredOAuthProvider }) => any,
   * }} options
   */
  constructor({
    authStore,
    server = "notion",
    url = NOTION_MCP_URL,
    sseUrl,
    redirectUrl = DEFAULT_REDIRECT_URL,
    createClient = defaultCreateClient,
    createTransport = defaultCreateTransport,
  }) {
    this.#store = authStore;
    this.#server = server;
    this.#url = new URL(url);
    this.#sseUrl = sseUrl ? new URL(sseUrl) : sseUrlFor(this.#url);
    this.#redirectUrl = redirectUrl;
    this.#createClient = createClient;
    this.#createTransport = createTransport;
  }

  get server() {
    return this.#server;
  }

  get connected() {
    return this.#live !== null;
  }

  async status() {
    return {
      connected: this.connected,
      server: this.#server,
      toolCount: this.tools?.length ?? null,
      serverInfo: this.serverInfo,
      // Stored tokens: worth a silent connect without asking anyone to log in.
      authorized: await this.#provider().hasTokens(),
    };
  }

  /**
   * Connect with whatever is stored. Tokens that have expired are refreshed by
   * the SDK on the way; no tokens, or a refresh that fails, is `authUrl`.
   *
   * @returns {Promise<{ ok: true, serverInfo: object | null } | { ok: false, authUrl: string | null }>}
   */
  connect() {
    if (this.#live) return Promise.resolve({ ok: true, serverInfo: this.serverInfo });
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #connect() {
    let first;
    for (const kind of /** @type {TransportKind[]} */ (["streamable", "sse"])) {
      const provider = this.#provider();
      try {
        return await this.#attempt(kind, provider);
      } catch (err) {
        // A 401 is an answer, not a transport problem: falling back to SSE
        // would only ask the same server the same question again.
        if (isUnauthorized(err)) return this.#needsAuth(provider);
        first ??= err;
        if (kind === "streamable") {
          console.warn(`[mcp:${this.#server}] streamable HTTP failed (${err?.message ?? err}); trying SSE`);
        }
      }
    }
    throw first;
  }

  async #attempt(kind, provider) {
    const transport = this.#createTransport({
      kind,
      url: kind === "sse" ? this.#sseUrl : this.#url,
      authProvider: provider,
    });
    const client = this.#createClient();
    try {
      await client.connect(transport);
    } catch (err) {
      this.#pending = { transport, provider };
      await client.close?.().catch(() => {});
      throw err;
    }

    this.#live = { client, transport, provider, kind };
    this.#pending = null;
    this.authUrl = null;
    this.serverInfo = client.getServerVersion?.() ?? null;
    client.onclose = () => {
      if (this.#live?.client === client) this.#drop();
    };
    return { ok: true, serverInfo: this.serverInfo };
  }

  #needsAuth(provider) {
    this.authUrl = provider.authorizationUrl?.href ?? null;
    return { ok: false, authUrl: this.authUrl };
  }

  /**
   * The redirect came back: trade the code for tokens, then connect for real.
   *
   * @param {string} code
   * @param {string | undefined} state
   */
  async finishAuth(code, state) {
    const check = this.#provider();
    if (!(await check.checkState(state))) {
      throw new Error("OAuth state did not match — start the connection again.");
    }

    // The transport the login started on remembers where the resource
    // metadata was; after a restart a fresh one reads it from the store.
    const { transport } = this.#pending ?? {
      transport: this.#createTransport({ kind: "streamable", url: this.#url, authProvider: check }),
    };
    await transport.finishAuth(code);
    this.#pending = null;
    return this.connect();
  }

  /**
   * Every tool the server offers, every page of them.
   *
   * @returns {Promise<McpTool[]>}
   */
  async listTools() {
    const live = this.#live;
    if (!live) throw new Error("Not connected.");

    const tools = [];
    const seen = new Set();
    let cursor;
    try {
      do {
        const page = await live.client.listTools(cursor ? { cursor } : undefined);
        tools.push(...(page?.tools ?? []));
        cursor = page?.nextCursor;
        // A server that hands back a cursor it already gave is a loop, not a
        // longer list.
        if (cursor && seen.has(cursor)) break;
        if (cursor) seen.add(cursor);
      } while (cursor);
    } catch (err) {
      if (isUnauthorized(err)) {
        // The token died mid-session and could not be refreshed: back to
        // "needs auth", with the URL the SDK just produced.
        this.#needsAuth(live.provider);
        await this.close();
      }
      throw err;
    }

    this.tools = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    return this.tools;
  }

  async close() {
    const live = this.#live;
    this.#drop();
    await live?.client.close?.().catch(() => {});
  }

  /** Close, and forget the login: the next connect starts from scratch. */
  async disconnect() {
    await this.close();
    this.#pending = null;
    this.authUrl = null;
    await this.#store.clear(this.#server);
  }

  #drop() {
    this.#live = null;
    this.serverInfo = null;
    this.tools = null;
  }

  #provider() {
    return new StoredOAuthProvider({ store: this.#store, server: this.#server, redirectUrl: this.#redirectUrl });
  }
}
