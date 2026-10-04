import { answerQuestion } from "./answer.js";
import { RAG_SYSTEM, buildRagPrompt } from "./prompt.js";
import { DEFAULT_HISTORY_TURNS, DEFAULT_ROUTER_MODEL, routeMessage, stripCitations } from "./router.js";
import { addOpenQuestion, applyPatch, memoryDiff, renderMemory, taskMemoryOf } from "./taskMemory.js";

/**
 * **One turn of the Knowledge chat with RAG on (Day 25).**
 *
 * ```
 * message → router (LLM call 1) → apply memory patch → branch on intent
 *   chat / memory_only → the router's reply                              (1 call)
 *   search → retrieve → rerank → cutoff → answer + verify                (2 calls)
 *            └ nothing relevant → "I don't know" + clarifying question   (2 calls)
 * ```
 *
 * The search branch is `answerQuestion` — Day 23's retrieval and cutoff, Day
 * 24's contract — given the router's queries instead of a rewrite, reranked
 * against the router's standalone question rather than the raw message, and
 * answered with the task memory, the recent messages and the standalone
 * question next to what the user actually typed. An "I don't know" adds its
 * clarifying question to the memory's open questions, in code, so the next
 * turn can resolve it.
 *
 * The chat route and `eval:chat` both call this, so the eval measures what the
 * chat does.
 */

export const CHAT_RULES = [
  "",
  "This is a multi-turn chat. Before the documents, the message holds <task_memory>: the user's goal, the details they clarified, and the constraints and terms they set.",
  "After the documents come the user's message as typed and the resolved Question (references in the message resolved). Answer the resolved Question.",
  "- Follow the constraints in the task memory: answer length (count every sentence of the answer), the meaning of terms they defined, their focus.",
  "- Facts from the documents need [cN] citations as before.",
  "- A statement that comes from the user's own earlier messages (their situation, their goal) is written with \"(as you said)\" and needs no citation.",
  "- The task memory is never a source: never cite it, and never present its contents as something the documents say.",
  "- A bullet or list item is its own quote: never join two list items (or a list item and the next line) into one quote.",
  "- If the user asks you to decide or recommend, set out what the documents say about each option, with citations, and leave the decision to them; that is an answer, not dont_know.",
  "- If the documents do not contain the answer to the resolved Question, use dont_know as before.",
].join("\n");

export const CHAT_RAG_SYSTEM = `${RAG_SYSTEM}\n${CHAT_RULES}`;

/** The latest user message of a search turn: memory, documents, the message as typed, the resolved question. */
export function chatRagPrompt({ message, standaloneQuestion, memory, chunks }) {
  const rag = buildRagPrompt(standaloneQuestion, chunks);
  const at = rag.lastIndexOf("\nQuestion: ");
  return [
    "<task_memory>",
    renderMemory(memory, { ids: false }),
    "</task_memory>",
    "",
    rag.slice(0, at),
    `The user's message: ${message}`,
    rag.slice(at + 1),
  ].join("\n");
}

/** The answering call's history: the last few messages, citations stripped (their chunks are not sent again). */
export function answerHistory(messages, turns = DEFAULT_HISTORY_TURNS) {
  return (messages ?? []).slice(-turns).map(({ role, content }) => ({ role: role === "assistant" ? "assistant" : "user", content: role === "assistant" ? stripCitations(content) : String(content ?? "") }));
}

const addUsage = (a, b) => ({ inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0), outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0) });

/**
 * @param {object} o
 * @param {string} o.message - the user's message, trimmed
 * @param {Array<{ role: string, content: string }>} o.messages - the chat before this message
 * @param {object} o.memory - the task memory before this turn
 * @param {number} o.turn - this user message's number, 1-based
 * @param {import("../llm/provider.js").LlmProvider} o.provider
 * @param {string} [o.routerModel]
 * @param {number} [o.historyTurns]
 * @param {object} [o.ragOptions] - passed to `answerQuestion` (rerank, settings, fakes)
 * @param {typeof routeMessage} [o.router] - tests pass a fake
 * @param {typeof answerQuestion} [o.answer]
 * @param {(line: string) => void} [o.log]
 */
export async function runChatTurn({
  message,
  messages = [],
  memory,
  turn,
  provider,
  routerModel = DEFAULT_ROUTER_MODEL,
  historyTurns = DEFAULT_HISTORY_TURNS,
  ragOptions = {},
  router = routeMessage,
  answer = answerQuestion,
  log = console.log,
}) {
  const before = taskMemoryOf(memory);
  let startedAt = Date.now();
  const route = await router({ provider, model: routerModel, message, messages, memory: before, historyTurns });
  const routerMs = Date.now() - startedAt;
  log(`[chat] turn ${turn} → ${route.intent}${route.override ? ` (${route.override})` : ""}${route.intent === "search" ? ` · "${route.standaloneQuestion.slice(0, 80)}" · ${route.queries.map((q) => JSON.stringify(q)).join(" · ")}` : ""}`);

  const patched = applyPatch(before, route.patch, { turn, log });
  let after = patched.memory;

  let result = null;
  let openQuestionAdded = null;
  let answerMs = 0;
  if (route.intent === "search") {
    startedAt = Date.now();
    result = await answer(message, {
      mode: "rag",
      ...ragOptions,
      rewrite: false,
      provider,
      history: answerHistory(messages, historyTurns),
      queries: route.queries,
      rerankQuestion: route.standaloneQuestion,
      system: CHAT_RAG_SYSTEM,
      buildPrompt: (chunks) => chatRagPrompt({ message, standaloneQuestion: route.standaloneQuestion, memory: after, chunks }),
      log,
    });
    answerMs = Date.now() - startedAt;
    if (result.status === "dont_know") {
      ({ memory: after, added: openQuestionAdded } = addOpenQuestion(after, { text: result.clarifyingQuestion, about: route.standaloneQuestion, turn }));
    }
  }

  const routeRecord = {
    intent: route.intent,
    routedIntent: route.routedIntent,
    override: route.override,
    standaloneQuestion: route.standaloneQuestion,
    queries: route.queries,
    reply: route.reply,
    patch: route.patch,
    applied: patched.applied,
    skipped: patched.skipped,
    openQuestionAdded,
    memoryAfter: after,
    diff: memoryDiff(before, after),
    turn,
    routerMs,
    answerMs,
    routerModel: route.model ?? routerModel,
    routerUsage: route.usage ?? null,
  };
  return {
    route: routeRecord,
    result,
    reply: result ? result.answer : route.reply,
    memory: after,
    usage: addUsage(route.usage, result?.usage),
  };
}
