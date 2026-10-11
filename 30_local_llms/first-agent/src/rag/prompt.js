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

/**
 * **Day 29: the `v2` contract prompt, for local models only** (`LOCAL_PROMPT_VARIANT=v2`).
 *
 * Same rules as `RAG_RULES`, two additions and shorter: a worked example of
 * two lines cited as two quotes (qwen joined them on Day 28's q06), and one
 * sentence that a qualified answer is still an answer (its false "I don't
 * know" on q12). Rules the example now shows, or that were said twice, are
 * folded so that `v2` is not longer than `v1`. `v1` stays byte-for-byte as it
 * was, and Claude always gets it.
 */
export const RAG_RULES_V2 = [
  "The user's message holds documents in <documents>, each with a chunk_id, then the question.",
  "Answer by calling submit_answer exactly once. Rules:",
  "- Use only these documents, no outside knowledge.",
  "- End every sentence with a factual claim with its marker, before the final period: '… about 9 MB [c2].' or '… [c1][c2].'",
  "  Never at the start of a sentence, after a colon or around a phrase.",
  "- Each marker has one citation: its id, the chunk_id (copied exactly) and a verbatim quote from that document, 4–60 words. Every citation is used.",
  "- One line, one quote: never reword, shorten or join lines. The lines",
  "  The new API works on every platform.",
  "  Older versions are no longer supported.",
  "  of a chunk are two quotes, c1 the first line and c2 the second: 'It works everywhere [c1]. Old ones are gone [c2].'",
  "- A qualified answer is still an answer: if the documents say something is Beta but usable in production by early adopters, answer that and cite it; don't decline.",
  "- If the documents cover only part of it, answer that part and say what is missing.",
  "- If they don't contain the answer, set status dont_know with empty answer and citations and a short clarifying_question",
  "  (it may name what they cover nearby). Do not stretch loosely related text to fit.",
].join("\n");

export const RAG_SYSTEM_V2 = `${BASE_SYSTEM}\n\n${RAG_RULES_V2}`;

export const PROMPT_VARIANTS = ["v1", "v2"];

/**
 * Which prompt variant a provider gets: `v2` only for a local provider whose
 * settings ask for it (`LOCAL_PROMPT_VARIANT`); `v1` for everything else, so
 * Claude never sees `v2`.
 *
 * @param {{ provider?: string, settings?: { promptVariant?: string } } | null | undefined} provider
 */
export function promptVariantOf(provider) {
  return provider?.provider === "local" && provider.settings?.promptVariant === "v2" ? "v2" : "v1";
}

/** The answering system prompt (Day 24's contract) for this provider. */
export const ragSystemFor = (provider) => (promptVariantOf(provider) === "v2" ? RAG_SYSTEM_V2 : RAG_SYSTEM);

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
