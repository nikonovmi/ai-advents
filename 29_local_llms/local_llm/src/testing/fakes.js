/**
 * **A stand-in for `fetch`, so tests never need Ollama.**
 *
 * `routes` maps "POST /api/chat" (or just "/api/chat") to a JSON body, a
 * `(body) => json` function, or `{ status, json }`. A route that throws
 * simulates a network error. Every call is recorded in `calls`.
 */
export function fakeFetch(routes = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: pathname, body });
    let route = routes[`${method} ${pathname}`] ?? routes[pathname];
    if (route === undefined) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    if (typeof route === "function") route = await route(body);
    const { status = 200, json } = route && "json" in route && "status" in route ? route : { json: route };
    return new Response(JSON.stringify(json), { status });
  };
  return Object.assign(fetch, { calls });
}

/** fetch as it fails when nothing listens on the port. */
export async function refusedFetch() {
  const err = new TypeError("fetch failed");
  err.cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" });
  throw err;
}

/** A /api/chat response with Ollama's nanosecond timing fields. */
export const chatResponse = (content, overrides = {}) => ({
  model: "fake:1b",
  message: { role: "assistant", content },
  done: true,
  done_reason: "stop",
  total_duration: 3_000_000_000,
  load_duration: 500_000_000,
  prompt_eval_count: 100,
  prompt_eval_duration: 250_000_000,
  eval_count: 40,
  eval_duration: 2_000_000_000,
  ...overrides,
});
