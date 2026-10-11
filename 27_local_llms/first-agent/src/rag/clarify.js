import { FALLBACK_CLARIFYING_QUESTION } from "./contract.js";

/**
 * **"I don't know", before the answering model is called.**
 *
 * When reranking leaves nothing above the cutoff, there is nothing to answer
 * from, and the answering model would only be tempted to answer from memory.
 * Instead one small forced call (temperature 0) sees the question and the
 * title, section and first 150 characters of the best rejected chunks, and
 * writes a clarifying question. It may point at what the documents do cover
 * nearby ("Did you mean X or Y?"); it never answers.
 */

export const CLARIFY_TOOL = {
  name: "submit_clarification",
  description: "Submit one clarifying question for the user.",
  inputSchema: {
    type: "object",
    properties: {
      clarifying_question: {
        type: "string",
        description: "One short question to the user. It may offer the nearby topics the documents cover, e.g. 'Did you mean X or Y?'. It must not answer anything.",
      },
    },
    required: ["clarifying_question"],
  },
};

export const CLARIFY_SYSTEM = [
  "A user asked a question of a document index about Kotlin, Kotlin Multiplatform and Compose Multiplatform (release posts, blog articles, some project READMEs and code).",
  "No passage in the index was relevant enough to answer it. You see the question and the closest passages that were rejected.",
  "Write one short clarifying question that would help the user ask something the documents can answer.",
  "- If the closest passages are on a nearby topic, you may offer it: 'Did you mean X or Y?'. Name only topics the passages show.",
  "- If the question is vague, ask what exactly it refers to.",
  "- If it is about something else entirely, say in a few words that the documents cover Kotlin topics and ask what Kotlin topic they want.",
  "- Do not answer the question, do not state facts, and do not apologise.",
  "Call submit_clarification exactly once.",
].join("\n");

export const PREVIEW_CHARS = 150;

export function clarifyPrompt(question, rejected) {
  const lines = rejected.map((chunk, i) => {
    const preview = String(chunk.text ?? "").replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);
    return `${i + 1}. title: ${chunk.title || "(none)"} · section: ${chunk.section || "(none)"}\n   ${preview}${String(chunk.text ?? "").length > PREVIEW_CHARS ? "…" : ""}`;
  });
  return [`Question: ${question}`, "", "Closest rejected passages:", ...(lines.length ? lines : ["(none)"])].join("\n");
}

/**
 * @param {string} question
 * @param {object[]} rejected - the best rejected chunks (title, section, text)
 * @param {{ provider: import("../llm/provider.js").LlmProvider, model?: string }} o
 * @returns {Promise<{ clarifyingQuestion: string, usage: object | null }>}
 */
export async function clarifyQuestion(question, rejected, { provider, model }) {
  const completion = await provider.complete({
    system: CLARIFY_SYSTEM,
    messages: [{ role: "user", content: clarifyPrompt(question, rejected) }],
    tools: [CLARIFY_TOOL],
    toolChoice: { name: CLARIFY_TOOL.name },
    temperature: 0,
    maxTokens: 200,
    ...(model ? { model } : {}),
  });
  const call = (completion?.content ?? []).find((block) => block?.type === "tool_use" && block.name === CLARIFY_TOOL.name);
  const text = String(call?.input?.clarifying_question ?? "").trim();
  return { clarifyingQuestion: text || FALLBACK_CLARIFYING_QUESTION, usage: completion?.usage ?? null };
}
