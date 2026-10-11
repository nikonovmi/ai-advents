/**
 * **Ollama as a fake `fetch`**, for the tests (Day 27). It answers
 * `/api/version`, `/api/tags`, `/api/ps` and `/api/chat` (from a script),
 * 404s a model that is not "installed", and records every body it was sent.
 */

/** Ollama's non-streaming /api/chat response, with its nanosecond timings. */
export function ollamaReply(content, { model = "qwen3.5:9b", done_reason = "stop", prompt = 120, output = 30 } = {}) {
  return {
    model,
    message: { role: "assistant", content },
    done: true,
    done_reason,
    total_duration: 3_000_000_000,
    load_duration: 200_000_000,
    prompt_eval_count: prompt,
    prompt_eval_duration: 800_000_000,
    eval_count: output,
    eval_duration: 2_000_000_000,
  };
}

/**
 * @param {Array<string | object | ((body: object) => object | string)>} script - one per /api/chat call;
 *   a string is the reply text, an object a whole response, a function decides from the request.
 */
export function fakeOllama(script = [], { installed = ["gemma4:12b", "qwen3.5:9b"], loaded = [] } = {}) {
  const calls = [];
  const queue = [...script];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: pathname, body });
    if (pathname === "/api/version") return json(200, { version: "0.40.2" });
    if (pathname === "/api/tags") return json(200, { models: installed.map((name) => ({ name })) });
    if (pathname === "/api/ps") return json(200, { models: loaded.map((name) => ({ name })) });
    if (pathname === "/api/chat") {
      if (!installed.includes(body.model)) return json(404, { error: `model '${body.model}' not found` });
      let next = queue.length ? queue.shift() : "(fake ollama) ok";
      if (typeof next === "function") next = next(body);
      return json(200, typeof next === "string" ? ollamaReply(next, { model: body.model }) : next);
    }
    return json(404, { error: "not found" });
  };
  return { fetch, calls, chats: () => calls.filter((c) => c.path === "/api/chat").map((c) => c.body) };
}
