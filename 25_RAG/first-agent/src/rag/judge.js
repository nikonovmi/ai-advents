/**
 * **The eval's judge: one forced `submit_grade` call per answer.**
 *
 * It sees the question, its type, the expected facts and the answer, never the
 * mode. `[n]` citation markers are stripped from the answer first, because
 * they would tell it which mode wrote the answer just as plainly as a label.
 *
 * Score = (present + 0.5 × partial) / facts.
 */

export const GRADES = ["present", "partial", "missing", "contradicted"];

export const GRADE_TOOL = {
  name: "submit_grade",
  description: "Submit the grade for one answer: one entry per expected fact, in the given order, plus the two flags.",
  inputSchema: {
    type: "object",
    properties: {
      // First, so it is decided on its own before the facts are graded.
      declined: {
        type: "boolean",
        description:
          "True if the answer says it does not have the information asked for — e.g. 'the documents do not contain…', 'I don't have information about…' — " +
          "instead of answering it, even if it then points to where to look, suggests other resources, or describes what the documents do cover. " +
          "Declining is judged on its own: it can be the correct, expected behaviour, so do not leave it false just because declining was right.",
      },
      facts: {
        type: "array",
        description: "One entry per expected fact, in the same order as listed.",
        items: {
          type: "object",
          properties: {
            fact: { type: "string", description: "The expected fact, copied." },
            grade: {
              type: "string",
              enum: GRADES,
              description: "present: stated correctly. partial: only part of it, or vaguely. missing: not stated. contradicted: the answer states something incompatible with it.",
            },
            note: { type: "string", description: "A few words of justification." },
          },
          required: ["fact", "grade"],
        },
      },
      hallucination: {
        type: "boolean",
        description:
          "True if the answer makes a specific claim (a number, name, date, flag, API or feature) that contradicts an expected fact or is clearly false. " +
          "You do not see the answerer's sources: an extra specific detail that is plausible and does not conflict with the expected facts is not a hallucination.",
      },
      hallucination_note: { type: "string", description: "Which claim, if hallucination is true." },
    },
    required: ["declined", "facts", "hallucination"],
  },
};

export const JUDGE_SYSTEM = [
  "You grade one answer to a question about Kotlin, Kotlin Multiplatform and Compose Multiplatform.",
  "You are given the question, its type, a list of expected facts, and the answer.",
  "For each expected fact, decide whether the answer states it: present, partial, missing, or contradicted.",
  "Judge meaning, not wording; a number must match to count as present.",
  "Then flag hallucination only for specific claims that contradict the expected facts or are clearly false — vague or generic statements,",
  "and plausible extra details you cannot check, are not hallucinations.",
  "Set declined if the answer says it does not have the requested information instead of answering, even when it adds where to look.",
  "Question types: corpus, near_miss, paraphrased, messy and multi_part (details from specific articles; messy questions have filler around them,",
  "multi_part ones need facts from two articles), general (well-known Kotlin knowledge),",
  "unanswerable and off_topic (the reference material does not cover it; the expected behaviour is to say so rather than invent an answer),",
  "ambiguous (too vague to answer; the expected behaviour is to say so and ask a clarifying question).",
  "Call submit_grade exactly once.",
].join(" ");

/** The answer as the judge sees it: no `[n]` or `[cN]` markers. */
export function blind(answer) {
  return String(answer ?? "")
    .replace(/\s?\[\d+(?:\s*[,–-]\s*\d+)*\]/g, "")
    .replace(/\s?\[c\d+(?:\s*,\s*c\d+)*\]/gi, "")
    .trim();
}

export function judgePrompt({ question, type, expectedFacts, answer }) {
  return [
    `Question type: ${type}`,
    `Question: ${question}`,
    "",
    "Expected facts:",
    ...expectedFacts.map((fact, i) => `${i + 1}. ${fact}`),
    "",
    "Answer:",
    "<answer>",
    blind(answer),
    "</answer>",
  ].join("\n");
}

/**
 * The tool call → per-fact grades and a score. Grades are matched to the
 * expected facts by position; a fact the judge skipped counts as missing.
 *
 * @param {{ content?: Array<object> }} completion
 * @param {string[]} expectedFacts
 */
export function parseGrade(completion, expectedFacts) {
  const call = (completion?.content ?? []).find((block) => block?.type === "tool_use" && block.name === GRADE_TOOL.name);
  if (!call) throw new Error("the judge did not call submit_grade");
  const input = call.input ?? {};
  const given = Array.isArray(input.facts) ? input.facts : [];
  const facts = expectedFacts.map((fact, i) => {
    const entry = given[i];
    const grade = GRADES.includes(entry?.grade) ? entry.grade : "missing";
    return { fact, grade, note: String(entry?.note ?? "") };
  });
  const count = (grade) => facts.filter((f) => f.grade === grade).length;
  return {
    facts,
    score: facts.length ? (count("present") + 0.5 * count("partial")) / facts.length : 0,
    hallucination: input.hallucination === true,
    hallucinationNote: String(input.hallucination_note ?? ""),
    declined: input.declined === true,
  };
}

/**
 * @param {object} o
 * @param {import("../llm/provider.js").LlmProvider} o.provider
 * @param {string} [o.model]
 */
export async function judgeAnswer({ provider, model, question, type, expectedFacts, answer }) {
  const completion = await provider.complete({
    system: JUDGE_SYSTEM,
    messages: [{ role: "user", content: judgePrompt({ question, type, expectedFacts, answer }) }],
    tools: [GRADE_TOOL],
    toolChoice: { name: GRADE_TOOL.name },
    temperature: 0,
    maxTokens: 1024,
    ...(model ? { model } : {}),
  });
  return { ...parseGrade(completion, expectedFacts), usage: completion.usage, model: completion.model };
}
