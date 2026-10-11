import { claimsOf } from "./contract.js";

/**
 * **Does the answer say what its quotes say?** The `eval:citations` judge.
 *
 * One forced `submit_faithfulness` call at temperature 0. It sees the answer
 * cut into claims (sentences, with their markers), and for each cited claim the
 * quotes it cites — not the full chunks, and not the expected facts, so it
 * judges support, not correctness. Per cited claim: `supported | partial |
 * unsupported`. It also lists `uncited_claims`: factual statements in the
 * answer that carry no marker.
 *
 * Faithfulness = supported / cited claims.
 */

export const VERDICTS = ["supported", "partial", "unsupported"];

export const FAITHFULNESS_TOOL = {
  name: "submit_faithfulness",
  description: "Submit a verdict for each numbered cited claim, and list the factual statements that carry no citation.",
  inputSchema: {
    type: "object",
    properties: {
      claims: {
        type: "array",
        description: "One entry per numbered cited claim, in the given order.",
        items: {
          type: "object",
          properties: {
            claim: { type: "integer", description: "The claim's number." },
            verdict: {
              type: "string",
              enum: VERDICTS,
              description: "supported: the quotes state it. partial: they support part of it, or it goes beyond them. unsupported: they do not support it.",
            },
            note: { type: "string", description: "A few words: what is missing or extra." },
          },
          required: ["claim", "verdict"],
        },
      },
      uncited_claims: {
        type: "array",
        items: { type: "string" },
        description: "Factual statements among the uncited sentences, copied. Leave out headings, transitions and sentences that only say what is missing.",
      },
    },
    required: ["claims", "uncited_claims"],
  },
};

export const FAITHFULNESS_SYSTEM = [
  "You check whether an answer's claims are supported by the quotes it cites.",
  "Each numbered cited claim comes with the quotes it cites, copied from source documents. Judge only against those quotes:",
  "not your own knowledge, and not whether the claim is true in general.",
  "- supported: the quotes state the claim (the same meaning; numbers and names must match).",
  "- partial: the quotes support part of it, or the claim adds a detail, a generalisation or a conclusion the quotes do not state.",
  "- unsupported: the quotes do not support it, or say something different.",
  "Then read the uncited sentences and list those that make a factual claim (about a product, version, number, feature, behaviour).",
  "Headings, transitions, and sentences that only say what the documents do not cover are not factual claims.",
  "Call submit_faithfulness exactly once.",
].join("\n");

/**
 * The judge's input: numbered cited claims with their quotes, then the
 * uncited sentences.
 *
 * @param {string} answer
 * @param {Array<{ id: string, quote: string }>} citations
 */
export function faithfulnessInput(answer, citations) {
  const byId = new Map(citations.map((c) => [c.id, c]));
  const claims = claimsOf(answer);
  const cited = claims.filter((c) => c.markers.length);
  const uncited = claims.filter((c) => !c.markers.length);
  const lines = ["Cited claims:", ""];
  cited.forEach((claim, i) => {
    lines.push(`${i + 1}. ${claim.text}`);
    for (const id of claim.markers) {
      const c = byId.get(id);
      lines.push(`   [${id}] ${c ? `"${c.quote}"` : "(no such citation)"}`);
    }
  });
  if (!cited.length) lines.push("(none)");
  lines.push("", "Uncited sentences:", "", ...(uncited.length ? uncited.map((c) => `- ${c.text}`) : ["(none)"]));
  return { prompt: lines.join("\n"), cited, uncited };
}

/** The tool call → a verdict per cited claim (a skipped claim counts as unsupported) and the score. */
export function parseFaithfulness(completion, cited, citations) {
  const call = (completion?.content ?? []).find((block) => block?.type === "tool_use" && block.name === FAITHFULNESS_TOOL.name);
  if (!call) throw new Error("the judge did not call submit_faithfulness");
  const given = Array.isArray(call.input?.claims) ? call.input.claims : [];
  const byId = new Map(citations.map((c) => [c.id, c]));
  const claims = cited.map((claim, i) => {
    const entry = given.find((g) => Number(g?.claim) === i + 1) ?? given[i];
    return {
      claim: claim.text,
      markers: claim.markers,
      quotes: claim.markers.map((id) => ({ id, quote: byId.get(id)?.quote ?? null, source: byId.get(id)?.source ?? null, section: byId.get(id)?.section ?? null })),
      verdict: VERDICTS.includes(entry?.verdict) ? entry.verdict : "unsupported",
      note: String(entry?.note ?? ""),
    };
  });
  const supported = claims.filter((c) => c.verdict === "supported").length;
  return {
    claims,
    uncitedClaims: (Array.isArray(call.input?.uncited_claims) ? call.input.uncited_claims : []).map(String).filter((s) => s.trim()),
    supported,
    partial: claims.filter((c) => c.verdict === "partial").length,
    unsupported: claims.filter((c) => c.verdict === "unsupported").length,
    faithfulness: claims.length ? supported / claims.length : null,
  };
}

/**
 * @param {{ provider: import("../llm/provider.js").LlmProvider, model?: string, answer: string, citations: Array<{ id: string, quote: string }> }} o
 */
export async function judgeFaithfulness({ provider, model, answer, citations }) {
  const { prompt, cited } = faithfulnessInput(answer, citations);
  const completion = await provider.complete({
    system: FAITHFULNESS_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    tools: [FAITHFULNESS_TOOL],
    toolChoice: { name: FAITHFULNESS_TOOL.name },
    temperature: 0,
    maxTokens: 1500,
    ...(model ? { model } : {}),
  });
  return { ...parseFaithfulness(completion, cited, citations), usage: completion.usage, model: completion.model };
}
