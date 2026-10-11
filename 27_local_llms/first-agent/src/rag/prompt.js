/**
 * **What the Knowledge agent sends, in both modes.**
 *
 * RAG adds document rules to the system prompt and the retrieved chunks to the
 * latest user message, and (Day 24) answers through the forced `submit_answer`
 * tool of `contract.js` instead of free text. Model and temperature are the
 * same in both modes.
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
  "The user's message contains documents inside <documents>, each with a chunk_id, followed by the question.",
  "Answer by calling submit_answer exactly once. Rules:",
  "- Use only these documents. Do not add facts from general knowledge.",
  "- Put a citation marker like [c1] at the end of every sentence that makes a factual claim, just before its final punctuation:",
  "  'It adds about 9 MB to an iOS app [c2].' or, for two sources, '… [c1][c2].' Never put a marker at the start of a sentence,",
  "  after a heading, label or colon, or around a phrase: the marker belongs to the sentence it ends.",
  "- Each marker has one entry in citations: its id, the chunk_id of the document (copied exactly), and a quote copied verbatim from that document —",
  "  one or two whole sentences, 4–60 words, the part that actually supports the claim. Do not reword, shorten, join or add '...' to a quote.",
  "- Every citation is used in the answer.",
  "- If the documents cover only part of the question, answer that part with citations and say what is missing.",
  "- If the documents do not contain the answer, set status to dont_know, leave answer and citations empty, and write a short clarifying_question",
  "  (it may name what the documents do cover nearby). Do not stretch loosely related text to fit the question.",
].join("\n");

export const RAG_SYSTEM = `${BASE_SYSTEM}\n\n${RAG_RULES}`;

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
 * @param {Array<{ n: number, chunk_id?: string, source: string, section?: string, title?: string, text: string }>} chunks
 */
export function buildRagPrompt(question, chunks) {
  const docs = chunks.map(
    (chunk) =>
      `<doc n="${chunk.n}" chunk_id="${attr(chunk.chunk_id)}" source="${attr(chunk.source)}" section="${attr(chunk.section)}" title="${attr(chunk.title)}">\n` +
      `${String(chunk.text ?? "").replace(/<\/(doc|documents)>/g, "<\\/$1>").trim()}\n` +
      "</doc>",
  );
  return ["<documents>", ...docs, "</documents>", "", `Question: ${question}`].join("\n");
}
