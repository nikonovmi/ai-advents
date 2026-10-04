/**
 * **The only file that talks to OMDb.**
 *
 * One GET, one timeout, one error translation. It knows the endpoint and the
 * query parameters, and it is the only place the API key is ever put into a
 * URL. That URL is never logged and never part of an error message, so the key
 * cannot leave this process by way of a tool result.
 *
 * Every failure is an `OmdbError` with a sentence a person (or a model) can
 * read: a missing key, a timeout, a network failure, a non-JSON body, and
 * OMDb's own `{"Response":"False","Error":"…"}`.
 */

export const OMDB_URL = "https://www.omdbapi.com/";
export const DEFAULT_TIMEOUT_MS = 8000;

export class OmdbError extends Error {
  /**
   * @param {string} message
   * @param {"config" | "network" | "timeout" | "http" | "omdb"} kind
   */
  constructor(message, kind) {
    super(message);
    this.name = "OmdbError";
    this.kind = kind;
  }
}

/**
 * @param {{
 *   apiKey?: string | (() => string | undefined),
 *   fetch?: typeof globalThis.fetch,
 *   timeoutMs?: number,
 *   baseUrl?: string,
 * }} [options] - `apiKey` may be a function, so a key added to `.env` after
 *   start-up is not the difference between a crash and a readable error.
 */
export function createOmdbClient({
  apiKey = () => process.env.OMDB_API_KEY,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  baseUrl = OMDB_URL,
} = {}) {
  const keyOf = typeof apiKey === "function" ? apiKey : () => apiKey;

  /** @param {Record<string, string | number | undefined>} params */
  async function get(params) {
    const key = String(keyOf() ?? "").trim();
    if (!key) {
      throw new OmdbError(
        "OMDB_API_KEY is not set on the OMDb MCP server. Get a free key at https://www.omdbapi.com/apikey.aspx and put it in imdb_mcp_server/.env.",
        "config"
      );
    }

    const url = new URL(baseUrl);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
    }
    url.searchParams.set("apikey", key);

    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        throw new OmdbError(`OMDb did not answer within ${timeoutMs} ms.`, "timeout");
      }
      // Deliberately not the URL: it carries the key.
      const cause = err?.cause?.code ? ` (${err.cause.code})` : "";
      throw new OmdbError(`Could not reach OMDb: ${err?.message ?? err}${cause}.`, "network");
    }

    const raw = await response.text().catch(() => "");
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new OmdbError(`OMDb answered HTTP ${response.status} with something that was not JSON.`, "http");
    }

    // OMDb reports its own failures in the body, sometimes with a 200 and
    // sometimes with a 401 — the body is the more specific of the two.
    if (data?.Response === "False") {
      throw new OmdbError(`OMDb: ${data.Error || "the request failed"}`, "omdb");
    }
    if (!response.ok) {
      throw new OmdbError(`OMDb answered HTTP ${response.status}.`, "http");
    }
    return data;
  }

  return {
    /** `?s=` — a page of up to ten matches. */
    search({ query, year, type, page }) {
      return get({ s: query, y: year, type, page });
    },
    /** `?i=` — one title by its IMDb id. */
    byId(imdbId, { plot = "short" } = {}) {
      return get({ i: imdbId, plot });
    },
    /** `?t=` — OMDb's best single match for a title. */
    byTitle(title, { year, plot = "short" } = {}) {
      return get({ t: title, y: year, plot });
    },
  };
}
