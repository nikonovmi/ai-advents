import fs from "node:fs/promises";
import path from "node:path";

/**
 * **Where an MCP server's credentials live.**
 *
 * One record per server: the client registration we got from dynamic client
 * registration, the tokens, and the two values that only exist between sending
 * the user to the authorization page and their coming back — the PKCE code
 * verifier and the `state` we check the callback against.
 *
 * A fifth injected store rather than a corner of the profile store: these are
 * secrets, they belong to the app rather than to a user's memory, and the only
 * deletion rule is "disconnect". Nothing above it knows it is a file. Nothing
 * in it is ever logged.
 *
 * @typedef {{
 *   server: string,
 *   updatedAt: string | null,
 *   clientInformation?: object,
 *   tokens?: object,
 *   codeVerifier?: string,
 *   state?: string,
 *   discoveryState?: object,
 * }} McpAuthRecord
 */

/** A server name has to be safe to use as a filename before it reaches one. */
const SERVER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** @param {unknown} server */
export function isValidServer(server) {
  return typeof server === "string" && SERVER_PATTERN.test(server);
}

/** @returns {McpAuthRecord} */
export function emptyAuth(server) {
  return { server, updatedAt: null };
}

export class McpAuthStore {
  /**
   * @param {string} server
   * @returns {Promise<McpAuthRecord>} Always a record — a server we have never
   *   talked to is an empty one.
   */
  // eslint-disable-next-line no-unused-vars
  async load(server) {
    throw new Error("Not implemented");
  }

  /**
   * Read, change, write — as one step, so the SDK saving the verifier and the
   * client information back to back cannot lose either.
   *
   * @param {string} server
   * @param {(record: McpAuthRecord) => McpAuthRecord | void} mutate
   * @returns {Promise<McpAuthRecord>}
   */
  // eslint-disable-next-line no-unused-vars
  async update(server, mutate) {
    throw new Error("Not implemented");
  }

  /** Forget the server entirely: registration, tokens, all of it. */
  // eslint-disable-next-line no-unused-vars
  async clear(server) {
    throw new Error("Not implemented");
  }
}

/** Apply a mutation to a copy and stamp it. */
function applied(server, current, mutate) {
  const draft = structuredClone(current);
  const next = mutate(draft) ?? draft;
  return { ...next, server, updatedAt: new Date().toISOString() };
}

/**
 * One JSON file per server, in `data/mcp/`. Git-ignored: it holds tokens.
 *
 * Same write protocol as every other store: beside the target, then renamed,
 * so a crash mid-write cannot leave a half-written token file behind. Written
 * owner-only, because it is a credential.
 */
export class JsonMcpAuthStore extends McpAuthStore {
  #dir;
  #ready;
  /** Updates are serialised per store: each one reads what the last wrote. */
  #queue = Promise.resolve();

  constructor({ dir = path.join(import.meta.dirname, "..", "..", "data", "mcp") } = {}) {
    super();
    this.#dir = dir;
  }

  get dir() {
    return this.#dir;
  }

  async load(server) {
    const file = this.#fileFor(server);
    let raw;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") console.warn(`[mcp-auth] could not read ${file}: ${err?.message ?? err}`);
      return emptyAuth(server);
    }
    try {
      const data = JSON.parse(raw);
      return data && typeof data === "object" ? { ...data, server } : emptyAuth(server);
    } catch (err) {
      console.warn(`[mcp-auth] ignoring unreadable ${file}: ${err?.message ?? err}`);
      return emptyAuth(server);
    }
  }

  async update(server, mutate) {
    const file = this.#fileFor(server);
    const run = this.#queue.then(async () => {
      const record = applied(server, await this.load(server), mutate);
      await this.#ensureDir();
      const tmp = file + ".tmp";
      await fs.writeFile(tmp, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, file);
      return record;
    });
    // The chain survives a failed write; the caller still hears about it.
    this.#queue = run.catch(() => {});
    return run;
  }

  async clear(server) {
    const file = this.#fileFor(server);
    const run = this.#queue.then(async () => {
      try {
        await fs.unlink(file);
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  /** The single place a server name becomes a path. */
  #fileFor(server) {
    if (!isValidServer(server)) {
      throw new Error("Invalid MCP server name: expected lowercase letters, digits, dash or underscore");
    }
    return path.join(this.#dir, server + ".json");
  }

  #ensureDir() {
    this.#ready ??= fs.mkdir(this.#dir, { recursive: true });
    return this.#ready;
  }
}

/** The same contract backed by a Map: the twin the tests use. */
export class MemoryMcpAuthStore extends McpAuthStore {
  /** @type {Map<string, McpAuthRecord>} */
  #records = new Map();

  async load(server) {
    const stored = this.#records.get(server);
    return stored ? structuredClone(stored) : emptyAuth(server);
  }

  async update(server, mutate) {
    const record = applied(server, await this.load(server), mutate);
    this.#records.set(server, record);
    return structuredClone(record);
  }

  async clear(server) {
    this.#records.delete(server);
  }
}
