// Blind rubric judge. The judge sees an answer and an opaque id — never which
// method produced it, never the other answers, never the scores it gave before.
import { client, limit, textOf } from "./client.js";

export const JUDGE_MODEL = "claude-sonnet-5";

// Note on determinism: claude-sonnet-5 rejects `temperature` (and top_p/top_k)
// with a 400 — non-default sampling parameters were removed on this model, so
// there is no temperature 0 to set. Determinism comes instead from a frozen
// rubric, a JSON schema the response must satisfy, and a fixed effort level.
export const JUDGE_EFFORT = "medium";
export const JUDGE_MAX_TOKENS = 4000;

export const RUBRIC_CRITERIA = [
  {
    key: "problem_framing",
    label: "Problem framing",
    description:
      'notes that "worth the money" is underdefined and picks an explicit bar - what the campaign led buyers to expect, what a cessation product has to do to work at all, or what merely avoids a refund claim - instead of assuming a generic MVP',
  },
  {
    key: "tradeoff",
    label: "Tradeoff",
    description:
      "names the core tension between shipping something thin enough to finish and something substantial enough to be worth 40 GBP, rather than asserting that one of them simply wins",
  },
  {
    key: "mechanism",
    label: "Mechanism",
    description:
      "gives a causal reason why the chosen build works (what actually drives cessation or retention, why a feature can be run manually at 400 users, why one platform or stack first) rather than restating the plan",
  },
  {
    key: "legal_exposure",
    label: "Legal exposure",
    description:
      "treats the refund and consumer-protection risk concretely given that the money is already spent - pre-launch disclosure, aligning the campaign with what ships, what the terms have to say - without inventing statutes or case law",
  },
  {
    key: "concreteness",
    label: "Concreteness",
    description:
      "answers both halves - what ships and how it gets built (stack, sequencing, what is faked or run manually) - mapped onto the 8 weeks and the two-person team",
  },
  {
    key: "uncertainty",
    label: "Uncertainty",
    description:
      "flags what would change the answer, above all that what the campaign actually promised is not stated here - plus refundability under the terms, app store review time, dev velocity, jurisdiction",
  },
];

export const RUBRIC_KEYS = RUBRIC_CRITERIA.map((c) => c.key);
export const MAX_TOTAL = RUBRIC_KEYS.length * 2;

const JUDGE_SYSTEM = `You are grading anonymous answers to an open-ended product-scoping problem. There is no ground truth answer, so you grade the reasoning, not the conclusion.

You do not know how any answer was produced, and you must not speculate about it. Grade only what is on the page.

Score each of the six criteria 0, 1 or 2:
  0 — absent. The answer does not do this at all.
  1 — partial. Gestured at, asserted, or done only implicitly.
  2 — done explicitly and substantively.

The criteria:
${RUBRIC_CRITERIA.map((c, i) => `${i + 1}. ${c.key} — ${c.description}`).join("\n")}

Apply the same standard to every answer. Length is not quality: a short answer that does the thing scores 2, a long answer that circles it scores 1. Penalise invented legal specifics - named statutes, regulations, or case law cited with false precision - under "legal_exposure". Describing the shape of the risk in plain terms is correct; fabricating the law is not.

Return strict JSON only.`;

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "object",
      properties: Object.fromEntries(
        RUBRIC_KEYS.map((key) => [
          key,
          { type: "integer", enum: [0, 1, 2] },
        ])
      ),
      required: RUBRIC_KEYS,
      additionalProperties: false,
    },
    total: { type: "integer" },
    oneLineCritique: { type: "string" },
  },
  required: ["scores", "total", "oneLineCritique"],
  additionalProperties: false,
};

// Method names must never reach the judge. These tokens only ever appear as
// internal identifiers, so stripping them cannot mangle a real answer.
const METHOD_IDENTIFIERS =
  /\b(step[_-]by[_-]step|meta[_-]prompt|expert[_-]panel|expert panel|meta prompt)\b/gi;

export function stripIdentifiers(text) {
  return (text ?? "").replace(METHOD_IDENTIFIERS, "[redacted]");
}

/** Fisher-Yates, so answers reach the judge in an order unrelated to method. */
export function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Grade one anonymised answer.
 * @returns {{scores: object, total: number, oneLineCritique: string}}
 */
export async function judgeAnswer({ opaqueId, answer }) {
  const message = await limit(() =>
    client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: JUDGE_MAX_TOKENS,
      system: JUDGE_SYSTEM,
      output_config: {
        effort: JUDGE_EFFORT,
        format: { type: "json_schema", schema: JUDGE_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: `Grade submission ${opaqueId}.\n\n--- SUBMISSION ${opaqueId} ---\n${stripIdentifiers(
            answer
          )}\n--- END SUBMISSION ${opaqueId} ---`,
        },
      ],
    })
  );

  const raw = textOf(message);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Judge returned unparseable JSON: ${raw.slice(0, 200)}`);
  }

  const scores = {};
  for (const key of RUBRIC_KEYS) {
    const value = Number(parsed?.scores?.[key]);
    scores[key] = Number.isInteger(value) && value >= 0 && value <= 2 ? value : 0;
  }

  // The schema asks for `total`, but the tables are summed from the criteria so
  // a mis-added total can never make a method look better than it scored.
  const total = RUBRIC_KEYS.reduce((sum, key) => sum + scores[key], 0);

  return {
    scores,
    total,
    oneLineCritique: String(parsed?.oneLineCritique ?? "").trim(),
    judgeOutputTokens: message.usage?.output_tokens ?? 0,
  };
}
