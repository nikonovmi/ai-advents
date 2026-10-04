/**
 * **Query rewriting: the user's question → 1–3 search queries.**
 *
 * One forced `submit_queries` call at temperature 0, with the chat model.
 * People ask with filler ("so I was wondering…"), with their own words for
 * things, and with two questions in one; a vector search does best with one
 * short query per need, in the words a document would use. The rewrites only
 * steer retrieval: the answering model still gets the original question, and
 * the reranker still scores against it.
 */

export const MAX_QUERIES = 3;

export const REWRITE_TOOL = {
  name: "submit_queries",
  description: "Submit the search queries for the user's question: 1–3 standalone queries, one per distinct information need.",
  inputSchema: {
    type: "object",
    properties: {
      queries: {
        type: "array",
        minItems: 1,
        maxItems: MAX_QUERIES,
        items: { type: "string" },
        description: "Standalone search queries. Exactly one for a simple question; one per part for a multi-part question.",
      },
    },
    required: ["queries"],
  },
};

export const REWRITE_SYSTEM = [
  "You turn a user's question into search queries for a vector index of technical articles about Kotlin, Kotlin Multiplatform and Compose Multiplatform",
  "(release posts, blog articles), plus some project READMEs and source code.",
  "Rules:",
  "- Each query is standalone and short: one sentence or a keyword phrase, no filler, greetings or backstory.",
  "- Use the terms the documents themselves would use (product names, version numbers, feature names, technical vocabulary), not the user's paraphrase.",
  "- If the question asks about two or more separate things, write one query per part (at most 3).",
  "- If it asks about one thing, write exactly one query.",
  "- Do not answer the question and do not add facts you are not sure of; keep any version numbers or names the user gave.",
  "Call submit_queries exactly once.",
].join("\n");

/**
 * The tool call → the queries: trimmed, de-duplicated, at most 3. A call that
 * yields none falls back to the question itself, so retrieval always runs.
 */
export function parseQueries(completion, question) {
  const call = (completion?.content ?? []).find((block) => block?.type === "tool_use" && block.name === REWRITE_TOOL.name);
  const raw = Array.isArray(call?.input?.queries) ? call.input.queries : [];
  const queries = [];
  for (const q of raw) {
    const text = typeof q === "string" ? q.replace(/\s+/g, " ").trim() : "";
    if (text && !queries.some((seen) => seen.toLowerCase() === text.toLowerCase())) queries.push(text);
  }
  return queries.length ? queries.slice(0, MAX_QUERIES) : [question];
}

/**
 * @param {string} question
 * @param {{ provider: import("../llm/provider.js").LlmProvider, model?: string }} o
 * @returns {Promise<{ queries: string[], usage: object }>}
 */
export async function rewriteQuery(question, { provider, model }) {
  const completion = await provider.complete({
    system: REWRITE_SYSTEM,
    messages: [{ role: "user", content: `Question: ${question}` }],
    tools: [REWRITE_TOOL],
    toolChoice: { name: REWRITE_TOOL.name },
    temperature: 0,
    maxTokens: 300,
    ...(model ? { model } : {}),
  });
  return { queries: parseQueries(completion, question), usage: completion.usage };
}
