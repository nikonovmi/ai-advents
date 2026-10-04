import { blind } from "./judge.js";
import { renderMemory } from "./taskMemory.js";

/**
 * **The two judges `eval:chat` adds (Day 25).** Each is one forced call at
 * temperature 0.
 *
 * - **Memory checkpoint** (`submit_memory_check`): sees the user's messages so
 *   far, the task memory after the turn, and the statements the memory must
 *   reflect. Per statement: reflected or not. It also lists stale items —
 *   ones that no longer apply after what the user said (a corrected detail,
 *   the focus left behind by a change of direction) — and items that are not
 *   the user's at all (facts from the documents).
 * - **On track** (`submit_on_track`): sees the goal and constraints, the last
 *   few messages, the user's message, the resolved question and the answer.
 *   Does the answer address the resolved question, in this conversation,
 *   consistent with the goal and constraints? Whether its claims match its
 *   quotes is the Day 24 faithfulness judge's job, run alongside.
 */

export const MEMORY_CHECK_TOOL = {
  name: "submit_memory_check",
  description: "Say whether the task memory reflects each numbered statement, and list stale or misplaced items.",
  inputSchema: {
    type: "object",
    properties: {
      statements: {
        type: "array",
        description: "One entry per numbered statement, in order.",
        items: {
          type: "object",
          properties: {
            n: { type: "integer" },
            reflected: { type: "boolean", description: "True if the memory states this (same meaning; wording may differ)." },
            note: { type: "string" },
          },
          required: ["n", "reflected"],
        },
      },
      stale_items: {
        type: "array",
        description: "Memory items that should have been removed: contradicted or replaced by a later user message, or tied to a focus the user has left. Also items that are not the user's (facts the documents or the assistant stated).",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            must_remove: { type: "boolean", description: "True only if the item must be removed now. If on reflection it should stay, set false." },
            why: { type: "string" },
          },
          required: ["id", "must_remove", "why"],
        },
      },
    },
    required: ["statements", "stale_items"],
  },
};

export const MEMORY_CHECK_SYSTEM = [
  "You audit a chat assistant's task memory. The memory should hold only the user's goal, the details the user clarified, the constraints and terms the user set, and open clarifying questions.",
  "You see every user message so far, the memory after the latest one, and numbered statements the memory must reflect.",
  "- reflected: the memory states it (a goal, a clarified detail, a constraint or a term with that meaning). Wording may differ; meaning must match.",
  "- stale_items: list ONLY items that must be removed: a later user message corrected or replaced it, the user changed direction and the item only concerned the old focus,",
  "  or it is not something the user said (a fact from the documents or an answer). If you would keep an item, do not list it.",
  "  An item that is accurate is not stale, even if it is redundant with the goal or paraphrases what the user said. A general constraint like an answer-length limit is not stale just because the topic changed,",
  "  and neither is a detail about the user themselves (their team, platforms, app) unless they withdrew it.",
  "Call submit_memory_check exactly once.",
].join("\n");

export function memoryCheckPrompt({ userMessages, memory, statements }) {
  return [
    "User messages so far:",
    ...userMessages.map((m, i) => `${i + 1}. ${m}`),
    "",
    "Task memory after the latest message:",
    renderMemory(memory),
    "",
    "Statements the memory must reflect:",
    ...statements.map((s, i) => `${i + 1}. ${s}`),
  ].join("\n");
}

export function parseMemoryCheck(completion, statements, memory) {
  const call = (completion?.content ?? []).find((block) => block?.type === "tool_use" && block.name === MEMORY_CHECK_TOOL.name);
  if (!call) throw new Error("the judge did not call submit_memory_check");
  const given = Array.isArray(call.input?.statements) ? call.input.statements : [];
  const results = statements.map((statement, i) => {
    const entry = given.find((g) => Number(g?.n) === i + 1) ?? given[i];
    return { statement, reflected: entry?.reflected === true, note: String(entry?.note ?? "") };
  });
  const ids = new Set(["clarified", "constraints", "open_questions"].flatMap((k) => (memory?.[k] ?? []).map((x) => x.id)));
  const stale = (Array.isArray(call.input?.stale_items) ? call.input.stale_items : [])
    .filter((s) => s?.must_remove === true)
    .map((s) => ({ id: String(s?.id ?? "").replace(/^\[|\]$/g, ""), why: String(s?.why ?? "") }))
    .filter((s) => ids.has(s.id) || s.id === "goal");
  return { statements: results, stale, passed: results.every((r) => r.reflected) && stale.length === 0 };
}

export async function judgeMemory({ provider, model, userMessages, memory, statements }) {
  const completion = await provider.complete({
    system: MEMORY_CHECK_SYSTEM,
    messages: [{ role: "user", content: memoryCheckPrompt({ userMessages, memory, statements }) }],
    tools: [MEMORY_CHECK_TOOL],
    toolChoice: { name: MEMORY_CHECK_TOOL.name },
    temperature: 0,
    maxTokens: 800,
    ...(model ? { model } : {}),
  });
  return { ...parseMemoryCheck(completion, statements, memory), usage: completion.usage };
}

export const ON_TRACK_TOOL = {
  name: "submit_on_track",
  description: "Judge whether the assistant's reply stays on track in this conversation.",
  inputSchema: {
    type: "object",
    properties: {
      addresses_question: { type: "boolean", description: "The reply answers (or, for a greeting or a constraint, appropriately acknowledges) what the user asked, as resolved." },
      consistent: { type: "boolean", description: "The reply is consistent with the user's goal and follows their constraints and defined terms." },
      note: { type: "string", description: "A few words: what is off, if anything." },
    },
    required: ["addresses_question", "consistent"],
  },
};

export const ON_TRACK_SYSTEM = [
  "You judge one assistant reply in a multi-turn chat about Kotlin and Compose Multiplatform articles.",
  "You see the user's goal and constraints, the recent messages, the user's latest message, the question it was resolved to, and the reply.",
  "- addresses_question: the reply answers the resolved question in this conversation (not a different question, not a generic answer that ignores the context).",
  "  For a greeting, thanks or a stated constraint, a short fitting acknowledgement counts. Saying honestly that part is not covered is fine.",
  "- consistent: the reply fits the goal and follows the constraints and terms (e.g. what an abbreviation means, the user's focus).",
  "  Do not count sentences or words: length limits are checked mechanically elsewhere.",
  "Judge relevance and consistency only, not factual accuracy or sourcing (both are checked elsewhere; citation markers were removed from the reply).",
  "Call submit_on_track exactly once.",
].join("\n");

export function onTrackPrompt({ memory, recent, message, standaloneQuestion, reply, sentences }) {
  return [
    "Goal and constraints (task memory):",
    renderMemory(memory, { ids: false }),
    "",
    "Recent messages:",
    ...(recent.length ? recent.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`) : ["(none)"]),
    "",
    `Latest user message: ${message}`,
    `Resolved question: ${standaloneQuestion || "(not a question)"}`,
    "",
    ...(sentences != null ? [`The reply has ${sentences} sentence${sentences === 1 ? "" : "s"} (counted mechanically).`, ""] : []),
    "Reply:",
    "<reply>",
    blind(reply),
    "</reply>",
  ].join("\n");
}

export function parseOnTrack(completion) {
  const call = (completion?.content ?? []).find((block) => block?.type === "tool_use" && block.name === ON_TRACK_TOOL.name);
  if (!call) throw new Error("the judge did not call submit_on_track");
  const addresses = call.input?.addresses_question === true;
  const consistent = call.input?.consistent === true;
  return { addressesQuestion: addresses, consistent, onTrack: addresses && consistent, note: String(call.input?.note ?? "") };
}

export async function judgeOnTrack({ provider, model, memory, recent, message, standaloneQuestion, reply, sentences }) {
  const completion = await provider.complete({
    system: ON_TRACK_SYSTEM,
    messages: [{ role: "user", content: onTrackPrompt({ memory, recent, message, standaloneQuestion, reply, sentences }) }],
    tools: [ON_TRACK_TOOL],
    toolChoice: { name: ON_TRACK_TOOL.name },
    temperature: 0,
    maxTokens: 400,
    ...(model ? { model } : {}),
  });
  return { ...parseOnTrack(completion), usage: completion.usage };
}
