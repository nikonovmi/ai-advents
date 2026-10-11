/**
 * **The localhost-only `fetch` guard** (Day 27's, from `verify:local`; Day 30
 * reuses it for the hosted server).
 *
 * Wraps a `fetch` so that any request to a host other than localhost is
 * refused — it throws, and is recorded and logged — and every other request
 * goes through. Installed on `globalThis` before anything else is imported, it
 * covers every `fetch` in the process: the Ollama client, doc_index and any
 * dependency that would otherwise reach the network quietly.
 */

export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True for a URL whose host is this machine. */
export function isLocalUrl(url) {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * @param {object} [o]
 * @param {typeof fetch} [o.fetch] - what an allowed request goes to (default: the real one)
 * @param {string} [o.name] - who refused, for the error ("verify:local", "hosted")
 * @param {(line: string) => void} [o.log] - told about every refused request
 * @param {() => AbortSignal | null | undefined} [o.signal] - Day 30: a signal to add to every allowed request (the current request's deadline)
 * @returns {{ fetch: typeof fetch, outbound: Array<{ url: string, at: string }>, stats: { localRequests: number } }}
 */
export function guardFetch({ fetch: inner = globalThis.fetch, name = "fetch guard", log = () => {}, signal } = {}) {
  const outbound = [];
  const stats = { localRequests: 0 };
  const guarded = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!LOCAL_HOSTS.has(url.hostname)) {
      const entry = { url: `${url.protocol}//${url.host}${url.pathname}`, at: new Date().toISOString() };
      outbound.push(entry);
      log(`[${name}] blocked an outbound request to ${entry.url}: only localhost is allowed`);
      throw new Error(`${name} blocked a request to ${url.host}: only localhost is allowed`);
    }
    stats.localRequests += 1;
    const extra = signal?.();
    if (extra) init = { ...init, signal: init?.signal ? AbortSignal.any([init.signal, extra]) : extra };
    return inner(input, init);
  };
  return { fetch: guarded, outbound, stats };
}

/** Install the guard as `globalThis.fetch`. Returns the guard (its `outbound` list and stats). */
export function installFetchGuard(options = {}) {
  const guard = guardFetch({ fetch: globalThis.fetch, ...options });
  globalThis.fetch = guard.fetch;
  return guard;
}
