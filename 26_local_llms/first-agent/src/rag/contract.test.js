import assert from "node:assert/strict";
import test from "node:test";

import { FakeProvider } from "../llm/anthropic.js";
import { answerQuestion } from "./answer.js";
import { checksOf, summarizeCitations, verificationLabel } from "./citationsEval.js";
import {
  ANSWER_TOOL_NAME,
  answerWithContract,
  claimsOf,
  deriveSources,
  markersIn,
  parseSubmission,
  repairSubmission,
  sentenceSpans,
  verifySubmission,
} from "./contract.js";
import { faithfulnessInput, judgeFaithfulness } from "./faithfulness.js";
import { findQuote, normalizeQuote, quoteInChunk, wordCount } from "./quotes.js";

/**
 * **Day 24's answer contract, offline**: the quote matcher, the five rules,
 * the retry / repair / downgrade, derived sources, the low-relevance path and
 * the faithfulness judge — with a scripted FakeProvider for both the answering
 * model and the judge.
 */

const CHUNKS = [
  {
    n: 1,
    chunk_id: "kb/cmp-1.7:structural:4",
    source: "kb/cmp-1.7.html",
    section: "Performance › iOS",
    title: "CMP 1.7",
    text: "On iOS, the VisualEffects benchmark works 3.6 times faster.\nAverage CPU time per 1000 frames was reduced from 8.8 to 2.4 seconds. We’re “really” happy — it’s a big im-\nprovement for every app.",
  },
  { n: 2, chunk_id: "kb/cmp-1.8:structural:1", source: "kb/cmp-1.8.html", section: "", title: "CMP 1.8", text: "Compose Multiplatform 1.8.0 brings Compose for iOS to Stable. It adds about 9 MB to the app." },
  { n: 3, chunk_id: "kb/other:structural:0", source: "kb/other.html", section: "Intro", title: "Other", text: "Kotlin 2.2.0 adds context parameters as a preview feature." },
];

const submission = (input) => parseSubmission({ content: [{ type: "tool_use", id: "t1", name: ANSWER_TOOL_NAME, input }] });
const GOOD = {
  status: "answered",
  answer: "The VisualEffects benchmark is 3.6 times faster [c1]. Compose for iOS is Stable [c2].",
  citations: [
    { id: "c1", chunk_id: CHUNKS[0].chunk_id, quote: "the VisualEffects benchmark works 3.6 times faster." },
    { id: "c2", chunk_id: CHUNKS[1].chunk_id, quote: "Compose Multiplatform 1.8.0 brings Compose for iOS to Stable." },
  ],
};

// ---- the quote matcher --------------------------------------------------------------

test("quote matcher: exact and normalised matches pass", () => {
  const text = CHUNKS[0].text;
  assert.ok(quoteInChunk(text, "the VisualEffects benchmark works 3.6 times faster."), "exact");
  assert.ok(quoteInChunk(text, "THE VISUALEFFECTS  benchmark works 3.6 times faster"), "case and whitespace");
  assert.ok(quoteInChunk(text, "faster. Average CPU time per 1000 frames"), "a line break read as a space");
  assert.ok(quoteInChunk(text, `We're "really" happy - it's a big improvement for every app.`), "straight quotes, a hyphen for the dash, the hyphenated word joined");
  assert.ok(quoteInChunk(text, `"Average CPU time per 1000 frames was reduced from 8.8 to 2.4 seconds…"`), "wrapping quote marks and a trailing ellipsis");
  assert.ok(quoteInChunk("Use the `-Xcontext-parameters` flag.", "Use the '-Xcontext-parameters' flag."), "backticks are quote marks");
  assert.equal(normalizeQuote("A –\tB"), "a - b");
});

test("quote matcher: a paraphrase, an edit, or a quote from another chunk fails", () => {
  const text = CHUNKS[0].text;
  assert.equal(quoteInChunk(text, "The VisualEffects benchmark runs 3.6x faster."), false, "paraphrase");
  assert.equal(quoteInChunk(text, "CPU time per 1000 frames was reduced from 8.8 to 2.0 seconds"), false, "a changed number");
  assert.equal(quoteInChunk(text, "the VisualEffects benchmark ... 3.6 times faster"), false, "an elision");
  assert.equal(quoteInChunk(text, "Compose Multiplatform 1.8.0 brings Compose for iOS to Stable."), false, "from chunk 2");
  assert.equal(quoteInChunk(text, ""), false);
});

test("quote matcher: the match maps back to raw offsets for highlighting", () => {
  const text = CHUNKS[0].text;
  const at = findQuote(text, "we're “really” happy");
  assert.equal(text.slice(at.start, at.end), "We’re “really” happy");
  const joined = findQuote(text, "a big improvement");
  assert.equal(text.slice(joined.start, joined.end), "a big im-\nprovement");
  assert.equal(wordCount("…a big — improvement, for 3.6 apps"), 6);
});

// ---- the five rules ----------------------------------------------------------------

test("contract validation: a good answer passes", () => {
  assert.deepEqual(verifySubmission(submission(GOOD), CHUNKS).errors, []);
  assert.deepEqual(verifySubmission(submission({ status: "dont_know", answer: "", citations: [], clarifying_question: "Which release?" }), CHUNKS).errors, []);
});

test("contract validation: catches each of rules 1–5", () => {
  const errors = (input) => verifySubmission(submission({ ...GOOD, ...input }), CHUNKS).errors.join("\n");
  // 1
  assert.match(errors({ answer: "It is fast.", citations: [] }), /Rule 1: an answered status needs at least one citation/);
  assert.match(errors({ status: "dont_know", answer: "", citations: [], clarifying_question: "  " }), /Rule 1: a dont_know answer needs a non-empty clarifying_question/);
  // 2
  assert.match(errors({ answer: "Fast [c1] and stable [c3]." }), /Rule 2: the answer uses \[c3\], but there is no citation with id c3/);
  assert.match(errors({ answer: "Fast [c1]." }), /Rule 2: citation c2 is never used/);
  // 3
  assert.match(errors({ citations: [GOOD.citations[0], { ...GOOD.citations[1], chunk_id: "kb/made-up:structural:9" }] }), /Rule 3: citation c2 names chunk_id "kb\/made-up:structural:9"/);
  // 4: a paraphrase, and a real sentence attributed to the wrong chunk
  const fabricated = verifySubmission(submission({ ...GOOD, citations: [{ ...GOOD.citations[0], quote: "The benchmark got 3.6x quicker on iOS." }, { ...GOOD.citations[1], chunk_id: CHUNKS[2].chunk_id }] }), CHUNKS);
  assert.equal(fabricated.fabricated.length, 2);
  assert.match(fabricated.errors.join("\n"), /Rule 4: citation c1's quote is not in chunk/);
  assert.equal(fabricated.bad.get("c2"), "fabricated quote");
  // 5
  assert.match(errors({ citations: [{ ...GOOD.citations[0], quote: "3.6 times faster" }, GOOD.citations[1]] }), /Rule 5: citation c1's quote is 3 words/);
  const long = { n: 9, chunk_id: "long", source: "l", section: "", text: Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ") };
  assert.match(verifySubmission(submission({ ...GOOD, answer: "x [c1]", citations: [{ id: "c1", chunk_id: "long", quote: long.text }] }), [long]).errors.join(), /Rule 5: citation c1's quote is 70 words/);
  // not calling the tool at all
  assert.match(verifySubmission(parseSubmission({ content: [{ type: "text", text: "hi" }] }), CHUNKS).errors[0], /did not call submit_answer/);
});

test("markers: [c1, c2] is read as [c1][c2]; order of first use", () => {
  assert.deepEqual(markersIn("a [c2] b [c1, c2] c [C3]"), ["c2", "c1", "c3"]);
  assert.equal(submission({ ...GOOD, answer: "x [c1, c2]." }).answer, "x [c1][c2].");
});

test("claims: sentences with their markers; decimals, abbreviations and list numbers are not boundaries", () => {
  const answer = "## Speed\nThe benchmark is 3.6 times faster [c1]. GC pauses fell, e.g. p25 [c1][c2].\n1. Compose for iOS is Stable [c2].\n- Uncited claim here.";
  assert.deepEqual(claimsOf(answer), [
    { text: "Speed", markers: [] },
    { text: "The benchmark is 3.6 times faster.", markers: ["c1"] },
    { text: "GC pauses fell, e.g. p25.", markers: ["c1", "c2"] },
    { text: "Compose for iOS is Stable.", markers: ["c2"] },
    { text: "Uncited claim here.", markers: [] },
  ]);
  assert.equal(sentenceSpans(answer).map((s) => s.raw).join(""), answer, "spans cover the text exactly");
});

// ---- derived sources -----------------------------------------------------------------

test("derived sources: deduplicated, in citation order, never a chunk that was not cited", () => {
  const citations = [
    { id: "c1", chunk_id: CHUNKS[1].chunk_id },
    { id: "c2", chunk_id: CHUNKS[0].chunk_id },
    { id: "c3", chunk_id: CHUNKS[1].chunk_id },
  ];
  const sources = deriveSources(citations, CHUNKS, "First [c2]. Then [c1] and [c3].");
  assert.deepEqual(sources.map((s) => s.chunk_id), [CHUNKS[0].chunk_id, CHUNKS[1].chunk_id], "c2's chunk first, as the answer cites it first; chunk 2 once");
  assert.equal(sources[0].label, "kb/cmp-1.7.html › Performance › iOS · kb/cmp-1.7:structural:4");
  assert.equal(sources[1].label, "kb/cmp-1.8.html · kb/cmp-1.8:structural:1", "no section, no ›");
  assert.deepEqual(sources[1].citations, ["c1", "c3"]);
  assert.ok(!sources.some((s) => s.chunk_id === CHUNKS[2].chunk_id), "chunk 3 was sent but not cited");
  assert.deepEqual(deriveSources([{ id: "c1", chunk_id: "not-sent" }], CHUNKS, "x [c1]"), [], "an unknown chunk is never a source");
});

// ---- retry, repair, downgrade ------------------------------------------------------------

const answerStep = (input) => ({ toolUse: [{ name: ANSWER_TOOL_NAME, input }] });
const contractCall = (provider) =>
  answerWithContract({ provider, system: "sys", messages: [{ role: "user", content: "<documents>…</documents>\n\nQuestion: q" }], chunks: CHUNKS, maxTokens: 2048 });

test("retry: a fabricated quote triggers one retry with the errors; a fixed answer is verified", async () => {
  const bad = { ...GOOD, citations: [{ ...GOOD.citations[0], quote: "The benchmark got 3.6x quicker on iOS." }, GOOD.citations[1]] };
  const provider = new FakeProvider({ delayMs: 0, script: [answerStep(bad), answerStep(GOOD)] });
  const out = await contractCall(provider);
  assert.equal(provider.toolCalls.length, 2, "one retry");
  const retry = provider.toolCalls[1].messages;
  assert.equal(retry.at(-2).role, "assistant");
  const result = retry.at(-1).content[0];
  assert.equal(result.type, "tool_result");
  assert.equal(result.isError, true);
  assert.match(result.content, /Rule 4: citation c1's quote is not in chunk/);
  assert.equal(out.status, "answered");
  assert.deepEqual(out.verification.fabricatedFirstAttempt.map((f) => f.id), ["c1"]);
  assert.equal(out.verification.firstAttemptValid, false);
  assert.equal(out.verification.retried, true);
  assert.deepEqual(out.verification.droppedCitations, []);
  assert.equal(out.verification.downgraded, false);
  assert.equal(out.citations.length, 2);
  assert.equal(out.attempts, 2);
});

test("retry: a second failure drops the bad citation and the claims that relied only on it", async () => {
  const bad = {
    status: "answered",
    answer: "The benchmark is 3.6 times faster [c1]. It got stable too [c2]. Both facts matter [c1][c2].",
    citations: [GOOD.citations[0], { id: "c2", chunk_id: CHUNKS[1].chunk_id, quote: "Compose for iOS is now production-ready." }],
  };
  const provider = new FakeProvider({ delayMs: 0, script: [answerStep(bad), answerStep(bad)] });
  const out = await contractCall(provider);
  assert.equal(provider.toolCalls.length, 2, "exactly one retry, never two");
  assert.equal(out.status, "answered");
  assert.equal(out.answer, "The benchmark is 3.6 times faster [c1]. Both facts matter [c1].");
  assert.deepEqual(out.citations.map((c) => c.id), ["c1"]);
  assert.deepEqual(out.sources.map((s) => s.chunk_id), [CHUNKS[0].chunk_id], "the dropped citation's chunk is no longer a source");
  assert.deepEqual(out.verification.droppedCitations.map((c) => [c.id, c.reason]), [["c2", "fabricated quote"]]);
  assert.deepEqual(out.verification.droppedClaims, ["It got stable too."]);
  assert.equal(out.verification.downgraded, false);
  assert.equal(verificationLabel({ verification: out.verification }), "retried, still invalid · 1 citation dropped");
});

test("retry: with no valid citation left, the answer is downgraded to dont_know", async () => {
  const bad = { status: "answered", answer: "It is 4x faster [c1].", citations: [{ id: "c1", chunk_id: CHUNKS[0].chunk_id, quote: "It is four times faster than before." }] };
  const provider = new FakeProvider({ delayMs: 0, script: [answerStep(bad), answerStep(bad)] });
  const out = await contractCall(provider);
  assert.equal(out.status, "dont_know");
  assert.deepEqual(out.dontKnow, { reason: "verification_failed" });
  assert.ok(out.clarifyingQuestion, "still asks something");
  assert.equal(out.answer, "");
  assert.deepEqual([out.citations, out.sources], [[], []]);
  assert.equal(out.verification.downgraded, true);
  assert.equal(out.verification.droppedCitations.length, 1);
});

test("retry: a model that never calls the tool is downgraded after one retry", async () => {
  const provider = new FakeProvider({ delayMs: 0, script: [{ text: "Here is an answer." }, { text: "Still prose." }] });
  const out = await contractCall(provider);
  assert.equal(provider.toolCalls.length, 2);
  assert.equal(provider.toolCalls[1].messages.at(-1).content, provider.toolCalls[1].messages.at(-1).content.toString());
  assert.match(provider.toolCalls[1].messages.at(-1).content, /did not call submit_answer/);
  assert.equal(out.status, "dont_know");
  assert.equal(out.verification.downgraded, true);
});

test("the model's own dont_know: I don't know with its clarifying question", async () => {
  const provider = new FakeProvider({ delayMs: 0, script: [answerStep({ status: "dont_know", answer: "", citations: [], clarifying_question: "Did you mean 1.8.0 or 1.10.0?" })] });
  const out = await answerQuestion("What did 1.9.0 add?", { mode: "rag", provider, search: async () => CHUNKS.map((c) => ({ ...c, score: 0.5 })), kFinal: 3, log: () => {} });
  assert.equal(out.status, "dont_know");
  assert.deepEqual(out.dontKnow, { reason: "model" });
  assert.equal(out.answer, "I don't know. Did you mean 1.8.0 or 1.10.0?");
  assert.equal(out.verification.firstAttemptValid, true);
  assert.equal(provider.toolCalls.length, 1);
});

test("repairSubmission keeps list structure and unmarked sentences", () => {
  const sub = submission({
    status: "answered",
    answer: "Two things:\n- Fast [c1].\n- Stable [c2].\nThat is all.",
    citations: [GOOD.citations[0], { id: "c2", chunk_id: "nope", quote: "x y z w" }],
  });
  const repaired = repairSubmission(sub, verifySubmission(sub, CHUNKS));
  assert.equal(repaired.answer, "Two things:\n- Fast [c1].\nThat is all.");
});

// ---- low relevance ------------------------------------------------------------------------

test("low relevance: the answering LLM is not called, and a clarifying question is returned", async () => {
  const provider = new FakeProvider({ delayMs: 0, script: [{ toolUse: [{ name: "submit_clarification", input: { clarifying_question: "Did you mean Compose Hot Reload or Kotlin/Wasm?" } }] }] });
  const out = await answerQuestion("How does it work?", {
    mode: "rag",
    rerank: true,
    provider,
    search: async () => CHUNKS.map((c) => ({ ...c, score: 0.4 })),
    rerankScores: async (_q, passages) => passages.map(() => 0.001),
    kFinal: 3,
    kRetrieve: 3,
    rerankThreshold: 0.02,
    log: () => {},
  });
  assert.equal(provider.toolCalls.length, 1);
  assert.deepEqual(provider.toolCalls[0].tools.map((t) => t.name), ["submit_clarification"]);
  assert.match(provider.toolCalls[0].messages[0].content, /CMP 1\.7 · section: Performance › iOS/);
  assert.equal(out.status, "dont_know");
  assert.deepEqual(out.dontKnow, { reason: "low_relevance" });
  assert.equal(out.answer, "I don't know. Did you mean Compose Hot Reload or Kotlin/Wasm?");
  assert.equal(out.rejected.length, 3);
  assert.equal(out.verification, null);
});

// ---- the faithfulness judge and the eval's checks ---------------------------------------------

test("faithfulness judge: sees claims and the quotes they cite, never the chunks; score = supported / cited claims", async () => {
  const answer = "The VisualEffects benchmark is 3.6 times faster [c1]. Compose for iOS is Stable and tiny [c2]. It also ships a new GC.";
  const citations = GOOD.citations.map((c) => ({ ...c, source: "s", section: "" }));
  const { prompt, cited, uncited } = faithfulnessInput(answer, citations);
  assert.equal(cited.length, 2);
  assert.equal(uncited.length, 1);
  assert.match(prompt, /1\. The VisualEffects benchmark is 3\.6 times faster\.\n {3}\[c1\] "the VisualEffects benchmark works 3\.6 times faster\."/);
  assert.ok(!prompt.includes("Average CPU time"), "no chunk text beyond the quotes");
  const judge = new FakeProvider({
    delayMs: 0,
    script: [{ toolUse: [{ name: "submit_faithfulness", input: { claims: [{ claim: 1, verdict: "supported" }, { claim: 2, verdict: "partial", note: "tiny is not in the quote" }], uncited_claims: ["It also ships a new GC."] } }] }],
  });
  const f = await judgeFaithfulness({ provider: judge, answer, citations });
  assert.equal(judge.toolCalls[0].toolChoice.name, "submit_faithfulness");
  assert.equal(f.faithfulness, 0.5);
  assert.deepEqual([f.supported, f.partial, f.unsupported], [1, 1, 0]);
  assert.deepEqual(f.uncitedClaims, ["It also ships a new GC."]);
  assert.equal(f.claims[1].quotes[0].quote, GOOD.citations[1].quote);
});

test("eval checks: answered vs expected decline, false IDKs, fabricated quotes counted on the first attempt", () => {
  const verification = { firstAttemptValid: false, retried: true, droppedCitations: [], droppedClaims: [], downgraded: false, firstAttemptCitations: 2, firstAttemptErrors: ["x"], fabricatedFirstAttempt: [{ id: "c1", chunk_id: "a", quote: "q" }], finalErrors: [] };
  const answeredRun = { status: "answered", sources: [{}], citations: [{}], clarifyingQuestion: "", dontKnow: null, verification, timings: {} };
  const idkRun = (reason) => ({ status: "dont_know", sources: [], citations: [], clarifyingQuestion: "Which?", dontKnow: { reason }, verification: null, timings: {} });
  const rows = [
    { id: "a", type: "corpus", run: answeredRun, faithfulness: { faithfulness: 1, unsupported: 0, supported: 2, partial: 0, claims: [{}, {}], uncitedClaims: [] }, grade: { score: 0.75 } },
    { id: "b", type: "messy", run: idkRun("model"), faithfulness: null, grade: { score: 0 } },
    { id: "c", type: "off_topic", expect_decline: true, run: idkRun("low_relevance"), faithfulness: null, grade: null },
  ];
  for (const row of rows) row.checks = checksOf(row);
  assert.deepEqual(rows[0].checks, { sources: true, citations: true, quotes: false, faithful: true, idk: true });
  assert.deepEqual(rows[1].checks, { sources: false, citations: false, quotes: null, faithful: null, idk: false });
  assert.deepEqual(rows[2].checks, { sources: null, citations: null, quotes: null, faithful: null, idk: true });
  const s = summarizeCitations(rows);
  assert.equal(s.fabricatedFirstAttempt, 1);
  assert.deepEqual(s.fabricated, [{ question: "a", id: "c1", chunk_id: "a", quote: "q" }]);
  assert.equal(s.retriesFixed, 1);
  assert.deepEqual(s.falseIdk, [{ id: "b", type: "messy", reason: "model" }]);
  assert.equal(s.correctIdk, 1);
  assert.equal(s.meanFactScore, 0.375);
  assert.deepEqual(s.checks.idk, { passed: 2, applied: 3 });
});

test("claims: a marker between two words leaves a space", () => {
  assert.deepEqual(claimsOf("Added in[c1]Compose 1.7.0[c1]. Fast [c2]."), [
    { text: "Added in Compose 1.7.0.", markers: ["c1"] },
    { text: "Fast.", markers: ["c2"] },
  ]);
});
