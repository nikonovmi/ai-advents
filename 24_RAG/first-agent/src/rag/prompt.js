/**
 * **What the Knowledge agent sends, in both modes.**
 *
 * The two modes differ in exactly one way: RAG adds document rules to the
 * system prompt and the retrieved chunks to the latest user message. Model,
 * max tokens and temperature are the same, so the documents are the only
 * variable a comparison measures.
 *
 * The chunks go in the user message, not the system prompt: they are the
 * material for this one question, and the next question gets its own.
 */

/** The plain-mode system prompt, and the base of the RAG one. Short and neutral on purpose. */
export const BASE_SYSTEM = [
  "You are a helpful, precise assistant.",
  "Answer the user's question clearly and concisely, in plain language.",
  "Use Markdown when it makes the answer easier to read.",
].join(" ");

export const RAG_RULES = [
  "The user's message contains numbered documents inside <documents>, followed by the question.",
  "Rules for using them:",
  "- Answer only from these documents. Do not add facts from general knowledge.",
  "- Cite the document after each claim it supports, as [n] with the document's number, e.g. [2] or [1][3].",
  "- If the documents do not contain the answer, say plainly that the provided documents do not cover it, and stop there.",
  "- If they cover only part of the question, answer that part with citations and name what is missing.",
].join("\n");

export const RAG_SYSTEM = `${BASE_SYSTEM}\n\n${RAG_RULES}`;

/**
 * The reply when reranking leaves nothing above the cutoff. Fixed, and no
 * model is called: there is nothing to answer from, and the model would only
 * be tempted to answer from memory.
 */
export const DECLINE_ANSWER =
  "The provided documents do not cover this question: none of the retrieved passages was relevant enough to answer from, so no answer was generated. " +
  "The closest passages are listed below.";

/** `"` and `<` / `&` would break an attribute; the chunk body is left verbatim. */
const attr = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The latest user message in RAG mode. Pure: same chunks, same string.
 *
 * Chunk text is code and prose with `<`, `>`, `&` and quotes in it, and the
 * model reads it best as it is, so the body is not escaped. The one thing
 * changed is a literal closing tag (`</doc>`, `</documents>`), which would end
 * the document early; it becomes `<\/doc>`.
 *
 * @param {string} question
 * @param {Array<{ n: number, source: string, section?: string, title?: string, text: string }>} chunks
 */
export function buildRagPrompt(question, chunks) {
  const docs = chunks.map(
    (chunk) =>
      `<doc n="${chunk.n}" source="${attr(chunk.source)}" section="${attr(chunk.section)}" title="${attr(chunk.title)}">\n` +
      `${String(chunk.text ?? "").replace(/<\/(doc|documents)>/g, "<\\/$1>").trim()}\n` +
      "</doc>",
  );
  return ["<documents>", ...docs, "</documents>", "", `Question: ${question}`].join("\n");
}
