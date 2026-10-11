import { findQuote, wordCount } from "./quotes.js";

/**
 * **The answer contract: an answer, its citations, and sources derived by code.**
 *
 * Every RAG answer is one forced `submit_answer` call:
 *
 * ```
 * { status: "answered" | "dont_know",
 *   answer: "Text with [c1] after each claim.",          // empty for dont_know
 *   citations: [{ id: "c1", chunk_id, quote }],          // quote: verbatim from that chunk
 *   clarifying_question: "…" }                           // required for dont_know
 * ```
 *
 * The model never writes the source list: `deriveSources` builds it from the
 * chunk_ids that were actually cited, so a source cannot be invented. After the
 * call, `verifySubmission` checks five rules in code:
 *
 * 1. `answered` has ≥ 1 citation; `dont_know` has a clarifying question.
 * 2. Every `[cN]` is a citation, and every citation is used.
 * 3. Every chunk_id is one of the chunks that were sent.
 * 4. Every quote is in its chunk (`findQuote`); one that is not is **fabricated**.
 * 5. A quote is 4–60 words.
 *
 * Any failure gets one retry with the errors (the planner's pattern). A second
 * failure keeps what is valid: bad citations are dropped, and so is every
 * sentence that relied only on them; with no valid citation left, the answer
 * becomes `dont_know`.
 */

export const ANSWER_TOOL_NAME = "submit_answer";
export const MIN_QUOTE_WORDS = 4;
export const MAX_QUOTE_WORDS = 60;
/** What every "I don't know" answer starts with, whichever way it was reached. */
export const IDK = "I don't know.";
export const DONT_KNOW_REASONS = ["low_relevance", "model", "verification_failed"];
/** Used only when the model gave none: a downgraded answer still asks something. */
export const FALLBACK_CLARIFYING_QUESTION = "Could you say more specifically what you would like to know, for example which release, feature or platform you mean?";

export const ANSWER_TOOL = {
  name: ANSWER_TOOL_NAME,
  description: "Submit the answer to the question, with a citation for every claim, or say that the documents do not contain the answer.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["answered", "dont_know"],
        description: "answered: the documents contain the answer (or part of it). dont_know: they do not; ask a clarifying question instead.",
      },
      answer: {
        type: "string",
        description: "The answer, with a citation marker like [c1] right after each factual claim. Empty for dont_know.",
      },
      citations: {
        type: "array",
        description: "One entry per marker used in the answer. Empty for dont_know.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "The marker's id: c1, c2, …" },
            chunk_id: { type: "string", description: "The chunk_id attribute of the document the quote is from, copied exactly." },
            quote: { type: "string", description: "One or two sentences copied verbatim from that document (4–60 words): the part that supports the claim." },
          },
          required: ["id", "chunk_id", "quote"],
        },
      },
      clarifying_question: {
        type: "string",
        description: "For dont_know: one short question that would let you answer, e.g. naming what the documents do cover nearby. Empty when answered.",
      },
    },
    required: ["status", "answer", "citations"],
  },
};

// ---- reading the call -----------------------------------------------------------

/** `[c1, c2]` → `[c1][c2]`, so every marker has one spelling. */
export const normalizeMarkers = (text) =>
  String(text ?? "").replace(/\[\s*(c\d+(?:\s*,\s*c\d+)+)\s*\]/gi, (_, group) => group.split(",").map((id) => `[${id.trim().toLowerCase()}]`).join(""));

/** Marker ids in an answer, in order of first use. */
export function markersIn(text) {
  const out = [];
  for (const [, id] of normalizeMarkers(text).matchAll(/\[(c\d+)\]/gi)) if (!out.includes(id.toLowerCase())) out.push(id.toLowerCase());
  return out;
}

/**
 * The tool call → a submission. `use` and `content` are kept for the retry,
 * which answers the call with a tool_result.
 */
export function parseSubmission(completion) {
  const content = completion?.content ?? [];
  const use = content.find((block) => block?.type === "tool_use" && block.name === ANSWER_TOOL_NAME) ?? null;
  const input = use?.input ?? {};
  const citations = (Array.isArray(input.citations) ? input.citations : [])
    .filter((c) => c && typeof c === "object")
    .map((c) => ({ id: String(c.id ?? "").trim().toLowerCase(), chunk_id: String(c.chunk_id ?? "").trim(), quote: String(c.quote ?? "").trim() }));
  return {
    called: Boolean(use),
    use,
    content,
    text: completion?.text ?? "",
    status: input.status,
    answer: normalizeMarkers(String(input.answer ?? "").trim()),
    citations,
    clarifyingQuestion: String(input.clarifying_question ?? "").trim(),
  };
}

// ---- the five rules ---------------------------------------------------------------

/**
 * @param {ReturnType<typeof parseSubmission>} sub
 * @param {Array<{ chunk_id: string, text: string }>} chunks - what was sent
 * @returns {{ valid: boolean, errors: string[], bad: Map<string, string>, fabricated: object[], unknownMarkers: string[], unused: string[] }}
 *   `bad`: citation id → why it is invalid (rules 3–5, duplicates); `fabricated`: rule-4 failures.
 */
export function verifySubmission(sub, chunks) {
  const errors = [];
  const bad = new Map();
  const fabricated = [];
  const result = (extra = {}) => ({ valid: errors.length === 0, errors, bad, fabricated, unknownMarkers: [], unused: [], ...extra });
  if (!sub.called) {
    errors.push(`You did not call ${ANSWER_TOOL_NAME}. Call it exactly once.`);
    return result();
  }
  if (sub.status !== "answered" && sub.status !== "dont_know") {
    errors.push(`status must be "answered" or "dont_know", got ${JSON.stringify(sub.status ?? null)}.`);
    return result();
  }
  if (sub.status === "dont_know") {
    if (!sub.clarifyingQuestion) errors.push("Rule 1: a dont_know answer needs a non-empty clarifying_question.");
    return result();
  }

  if (!sub.answer) errors.push("An answered status needs a non-empty answer.");
  if (!sub.citations.length) errors.push("Rule 1: an answered status needs at least one citation.");
  const byId = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
  const seen = new Set();
  for (const c of sub.citations) {
    const label = c.id || "(no id)";
    if (!/^c\d+$/.test(c.id)) {
      bad.set(c.id, "bad id");
      errors.push(`Citation ${label}: id must look like c1, c2, ….`);
      continue;
    }
    if (seen.has(c.id)) {
      bad.set(c.id, "duplicate id");
      errors.push(`Citation ${label}: the id is used twice; give each citation its own id.`);
      continue;
    }
    seen.add(c.id);
    const chunk = byId.get(c.chunk_id);
    if (!chunk) {
      bad.set(c.id, "unknown chunk_id");
      errors.push(`Rule 3: citation ${label} names chunk_id "${c.chunk_id}", which is not one of the documents you were given.`);
      continue;
    }
    if (!findQuote(chunk.text, c.quote)) {
      bad.set(c.id, "fabricated quote");
      fabricated.push({ id: c.id, chunk_id: c.chunk_id, quote: c.quote });
      errors.push(`Rule 4: citation ${label}'s quote is not in chunk "${c.chunk_id}": "${c.quote.slice(0, 160)}". Copy the sentence exactly as it appears in that document.`);
      continue;
    }
    const words = wordCount(c.quote);
    if (words < MIN_QUOTE_WORDS || words > MAX_QUOTE_WORDS) {
      bad.set(c.id, words < MIN_QUOTE_WORDS ? "quote too short" : "quote too long");
      errors.push(`Rule 5: citation ${label}'s quote is ${words} words; it must be ${MIN_QUOTE_WORDS}–${MAX_QUOTE_WORDS} (one or two whole sentences).`);
    }
  }
  const markers = markersIn(sub.answer);
  const ids = new Set(sub.citations.map((c) => c.id));
  const unknownMarkers = markers.filter((id) => !ids.has(id));
  const unused = [...seen].filter((id) => !markers.includes(id));
  for (const id of unknownMarkers) errors.push(`Rule 2: the answer uses [${id}], but there is no citation with id ${id}.`);
  for (const id of unused) errors.push(`Rule 2: citation ${id} is never used in the answer; put [${id}] after the claim it supports, or remove it.`);
  if (sub.answer && !markers.length) errors.push("Rule 2: the answer has no citation markers; put [cN] after every factual claim.");
  return result({ unknownMarkers, unused });
}

// ---- claims ------------------------------------------------------------------------

const ABBREVIATIONS = /(?:^|[\s(])(?:e\.g|i\.e|vs|etc|approx|ca|cf|no|fig|incl|v)\.$/i;

/**
 * The answer cut into sentences — a claim is a sentence with its markers —
 * as raw spans, so a sentence can be removed without disturbing the rest.
 * A boundary is a newline, or `.`/`!`/`?` (then any markers) followed by
 * whitespace; `3.6`, `e.g.` and a list's `1.` are not boundaries.
 *
 * @returns {Array<{ start: number, end: number, raw: string }>}
 */
export function sentenceSpans(text) {
  const s = String(text ?? "");
  const spans = [];
  let start = 0;
  const cut = (end) => {
    if (end > start) spans.push({ start, end, raw: s.slice(start, end) });
    start = end;
  };
  const re = /\n|[.!?]+((?:\s*\[c\d+\])*)(?=\s|$)/gi;
  for (const m of s.matchAll(re)) {
    const end = m.index + m[0].length;
    if (m[0] !== "\n") {
      const before = s.slice(start, m.index + 1);
      const lineStart = before.slice(before.lastIndexOf("\n") + 1);
      if (ABBREVIATIONS.test(before) || /^\s*\d+\.$/.test(lineStart)) continue;
    }
    cut(end);
  }
  cut(s.length);
  return spans;
}

/** Markers out; one between two words leaves a space, so "in[c1]Compose" reads "in Compose". */
const stripMarkers = (text) =>
  String(text)
    .replace(/\s*\[c\d+\]\s*/gi, " ")
    .replace(/\s+([.,;:!?])/g, "$1");
/** A sentence as a reader sees it: no markers, no list bullet or heading hashes. */
const plainClaim = (raw) =>
  stripMarkers(raw)
    .replace(/^\s*(?:[-*+]|\d+\.|#{1,6})\s+/, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The answer's claims: each sentence with letters in it, its text without
 * markers, and the citation ids it carries.
 *
 * @returns {Array<{ text: string, markers: string[] }>}
 */
export function claimsOf(answer) {
  return sentenceSpans(normalizeMarkers(answer))
    .map((span) => ({ text: plainClaim(span.raw), markers: markersIn(span.raw) }))
    .filter((claim) => /\p{L}/u.test(claim.text));
}

// ---- after a second failure ------------------------------------------------------

/**
 * Keep what is valid. Citations that broke rules 3–5, or that the answer never
 * uses, are dropped; markers pointing at no valid citation are removed; and a
 * sentence whose markers were *all* invalid is removed with them. A sentence
 * with no markers is left alone — it relied on no citation.
 *
 * @returns {{ answer: string, citations: object[], dropped: object[], droppedClaims: string[] }}
 */
export function repairSubmission(sub, check) {
  const markers = markersIn(sub.answer);
  const dropped = [];
  const citations = [];
  for (const c of sub.citations) {
    const reason = check.bad.get(c.id) ?? (!markers.includes(c.id) ? "unused" : null);
    if (reason) dropped.push({ ...c, reason });
    else if (!citations.some((kept) => kept.id === c.id)) citations.push(c);
  }
  const valid = new Set(citations.map((c) => c.id));
  const droppedClaims = [];
  const kept = [];
  const spans = sentenceSpans(sub.answer);
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const ids = markersIn(span.raw);
    if (ids.length && !ids.some((id) => valid.has(id))) {
      const claim = plainClaim(span.raw);
      if (claim) droppedClaims.push(claim);
      const ownLine = (span.start === 0 || sub.answer[span.start - 1] === "\n") && (spans[i + 1]?.raw === "\n" || span.raw.endsWith("\n"));
      // A sentence that was a whole line goes with its line break; one inside a line keeps it.
      if (ownLine && spans[i + 1]?.raw === "\n") i++;
      else if (!ownLine && span.raw.endsWith("\n")) kept.push("\n");
      continue;
    }
    kept.push(span.raw.replace(/\s*\[(c\d+)\]/gi, (marker, id) => (valid.has(id.toLowerCase()) ? marker : "")));
  }
  const answer = kept
    .join("")
    .split("\n")
    .filter((line, i, lines) => !/^\s*(?:[-*+]|\d+\.)\s*$/.test(line) && !(line.trim() === "" && lines[i - 1]?.trim() === ""))
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { answer, citations, dropped, droppedClaims };
}

// ---- sources ------------------------------------------------------------------------

/**
 * The source list, from the cited chunks only: one entry per chunk, in the
 * order the answer first cites it. Never written by the model.
 *
 * @param {Array<{ id: string, chunk_id: string }>} citations - valid ones
 * @param {Array<{ chunk_id: string, source: string, section?: string, title?: string, n?: number }>} chunks
 * @param {string} [answer] - for the order of first use; citation order without it
 */
export function deriveSources(citations, chunks, answer = "") {
  const byChunk = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
  const order = markersIn(answer);
  const ranked = [...citations].sort((a, b) => rankOf(order, a.id) - rankOf(order, b.id));
  const out = [];
  for (const c of ranked) {
    const chunk = byChunk.get(c.chunk_id);
    if (!chunk || out.some((s) => s.chunk_id === c.chunk_id)) continue;
    out.push({
      chunk_id: chunk.chunk_id,
      source: chunk.source,
      section: chunk.section ?? "",
      title: chunk.title ?? "",
      n: chunk.n ?? null,
      label: `${chunk.source}${chunk.section ? ` › ${chunk.section}` : ""} · ${chunk.chunk_id}`,
      citations: citations.filter((x) => x.chunk_id === chunk.chunk_id).map((x) => x.id),
    });
  }
  return out;
}
const rankOf = (order, id) => (order.includes(id) ? order.indexOf(id) : order.length + Number(id.slice(1)));

/** A valid citation as the page shows it: where it is from, and where the quote sits in the chunk. */
export function enrichCitations(citations, chunks) {
  const byChunk = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
  return citations.map((c) => {
    const chunk = byChunk.get(c.chunk_id);
    const at = chunk ? findQuote(chunk.text, c.quote) : null;
    return { ...c, n: chunk?.n ?? null, source: chunk?.source ?? "", section: chunk?.section ?? "", ...(at ? { start: at.start, end: at.end } : {}) };
  });
}

// ---- the whole step ---------------------------------------------------------------

const addUsage = (a, b) => ({ inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0), outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0) });

/**
 * One forced `submit_answer` call, verified; one retry with the errors if it
 * fails; then repair or downgrade.
 *
 * @param {object} o
 * @param {import("../llm/provider.js").LlmProvider} o.provider
 * @param {string} o.system
 * @param {object[]} o.messages - history plus the latest user message
 * @param {object[]} o.chunks - the chunks in that message
 * @returns {Promise<{ status: "answered" | "dont_know", answer: string, citations: object[], sources: object[], clarifyingQuestion: string,
 *   dontKnow: { reason: string } | null, verification: object, usage: object, model: string | null, stopReason: string | null, attempts: number }>}
 */
export async function answerWithContract({ provider, system, messages, chunks, model, maxTokens, temperature = 0 }) {
  const call = (msgs) =>
    provider.complete({
      system,
      messages: msgs,
      tools: [ANSWER_TOOL],
      toolChoice: { name: ANSWER_TOOL_NAME },
      temperature,
      maxTokens,
      ...(model ? { model } : {}),
    });

  let completion = await call(messages);
  let usage = addUsage(null, completion.usage);
  let sub = parseSubmission(completion);
  let check = verifySubmission(sub, chunks);
  const first = { errors: check.errors, fabricated: check.fabricated, status: sub.status ?? null, citations: sub.citations.length };
  let retried = false;

  if (!check.valid) {
    retried = true;
    const problems =
      `The answer did not pass verification:\n${check.errors.map((e) => `- ${e}`).join("\n")}\n\n` +
      `Fix every problem and call ${ANSWER_TOOL_NAME} again with the whole corrected answer. ` +
      "Quotes must be copied exactly from the cited document. If the documents do not contain the answer, use dont_know.";
    const retry = sub.use
      ? [...messages, { role: "assistant", content: sub.content }, { role: "user", content: [{ type: "tool_result", toolUseId: sub.use.id, content: problems, isError: true }] }]
      : [...messages, { role: "assistant", content: sub.text || "(no answer)" }, { role: "user", content: problems }];
    completion = await call(retry);
    usage = addUsage(usage, completion.usage);
    sub = parseSubmission(completion);
    check = verifySubmission(sub, chunks);
  }

  const verification = {
    firstAttemptValid: first.errors.length === 0,
    retried,
    droppedCitations: [],
    droppedClaims: [],
    downgraded: false,
    firstAttemptCitations: first.status === "answered" ? first.citations : 0,
    firstAttemptErrors: first.errors,
    fabricatedFirstAttempt: first.fabricated,
    finalErrors: check.valid ? [] : check.errors,
  };
  const base = { usage, model: completion.model ?? null, stopReason: completion.stopReason ?? null, attempts: retried ? 2 : 1, verification };
  const dontKnow = (reason, question) => ({
    ...base,
    status: "dont_know",
    answer: "",
    citations: [],
    sources: [],
    clarifyingQuestion: question || FALLBACK_CLARIFYING_QUESTION,
    dontKnow: { reason },
  });

  if (sub.status === "dont_know") return dontKnow("model", sub.clarifyingQuestion);
  let { answer, citations } = sub;
  if (!check.valid) {
    if (!sub.called || sub.status !== "answered") {
      verification.downgraded = true;
      return dontKnow("verification_failed", "");
    }
    const repaired = repairSubmission(sub, check);
    verification.droppedCitations = repaired.dropped;
    verification.droppedClaims = repaired.droppedClaims;
    ({ answer, citations } = repaired);
    if (!citations.length || !answer) {
      verification.downgraded = true;
      return dontKnow("verification_failed", "");
    }
  }
  return {
    ...base,
    status: "answered",
    answer,
    citations: enrichCitations(citations, chunks),
    sources: deriveSources(citations, chunks, answer),
    clarifyingQuestion: "",
    dontKnow: null,
  };
}

/** The text a reader (and the chat history) sees for a dont_know result. */
export const dontKnowText = (clarifyingQuestion) => `${IDK} ${clarifyingQuestion}`.trim();
