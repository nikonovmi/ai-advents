import { MAX_QUERIES } from "./rewrite.js";
import { MEMORY_OPS, renderMemory, taskMemoryOf } from "./taskMemory.js";

/**
 * **The router: one forced `route` call per user message (Day 25).**
 *
 * It decides what kind of message this is, resolves references against the
 * recent history and the task memory, writes the search queries, and proposes
 * a patch to the task memory:
 *
 * ```js
 * { intent: "search" | "memory_only" | "chat",
 *   standalone_question: "…",   // search: the full question, references resolved
 *   queries: ["…"],             // search: 1–3 short search queries
 *   reply: "…",                 // chat / memory_only: the short reply shown
 *   memory_patch: [ … ] }       // operations, see taskMemory.js
 * ```
 *
 * It sees the new message, the last `historyTurns` messages (assistant ones cut
 * to ~300 characters, citations stripped) and the task memory — never the
 * retrieved chunks. Code then overrides two things: a missing or invalid
 * intent is `search`, and while a clarifying question is open, anything that
 * is not `chat` is `search`.
 */

export const INTENTS = ["search", "memory_only", "chat"];
export const DEFAULT_ROUTER_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_HISTORY_TURNS = 6;
/** How much of an earlier assistant message the router sees. */
export const ASSISTANT_PREVIEW_CHARS = 300;

export const ROUTE_TOOL = {
  name: "route",
  description: "Classify the user's new message, resolve it into a standalone question with search queries when it asks about content, and propose task-memory operations.",
  inputSchema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        enum: INTENTS,
        description: "search: asks about content. memory_only: only sets a constraint, correction, preference or term definition. chat: greeting, thanks, acknowledgement.",
      },
      standalone_question: {
        type: "string",
        description: "search only: the full question the user is asking, understandable without the conversation (pronouns and references resolved, clarifications applied).",
      },
      queries: {
        type: "array",
        maxItems: MAX_QUERIES,
        items: { type: "string" },
        description: "search only: 1–3 short standalone search queries, one per distinct information need.",
      },
      reply: {
        type: "string",
        description: "chat / memory_only only: the short reply to show the user (one or two sentences). Empty for search.",
      },
      memory_patch: {
        type: "array",
        description: "Operations on the task memory. Empty when nothing changes.",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: MEMORY_OPS },
            text: { type: "string", description: "set_goal, add_clarified, add_constraint: the item's text." },
            id: { type: "string", description: "remove, resolve_question: the id of an existing item, e.g. k2 or q6." },
          },
          required: ["op"],
        },
      },
    },
    required: ["intent", "memory_patch"],
  },
};

export const ROUTER_SYSTEM = [
  "You route messages in a chat about a document index of Kotlin, Kotlin Multiplatform and Compose Multiplatform articles (release posts, blog articles).",
  "For each new user message, call route exactly once.",
  "",
  "Intent:",
  "- search: anything that asks about content, including follow-ups like \"why?\", \"tell me more\", \"and the second one?\", and questions on other topics (the search decides whether the documents cover them).",
  "- memory_only: the message only sets a constraint, a correction, a preference, or defines a term, and asks nothing.",
  "- chat: greetings, thanks and acknowledgements, with no question.",
  "- Any question is search, even one clearly outside Kotlin (cooking, travel, …) or introduced with \"unrelated\": the search finds nothing and the user gets an honest \"I don't know\". Never answer a question yourself in reply.",
  "- A message that mixes several kinds (e.g. a new goal or constraint plus a question) is search.",
  "- A reply to an open clarifying question (listed in the task memory) is search, and standalone_question is the original question with the clarification applied.",
  "- When unsure, choose search.",
  "",
  "For search:",
  "- standalone_question: the full question, understandable on its own. Resolve pronouns and references (\"it\", \"that\", \"the other one\", \"before that\") from the recent messages and the task memory, and apply the user's defined terms (write the full name, not the abbreviation).",
  "- queries: 1–3 short search queries, one per distinct information need. Each is standalone: one sentence or a keyword phrase, no filler.",
  "  Use the terms the documents would use (product names, version numbers, feature names); keep version numbers and names the user gave.",
  "  When the user asks what a named article says, describe the content in words its paragraphs would use (e.g. \"should you upgrade now, required Gradle version\"),",
  "  not the article's title: a title only matches the article's first chunk.",
  "  Queries contain the resolved subject and any clarified terms. They do NOT repeat the goal or the constraints (no \"in at most 3 sentences\", no \"for our decision\").",
  "- reply: empty.",
  "",
  "For chat and memory_only: reply is a short, friendly sentence (acknowledge the constraint or term, or answer the greeting). Do not answer content questions here.",
  "",
  "Task memory (memory_patch): it holds only the user's goal, the details they clarified, and the constraints and terms they set. Operations:",
  "- set_goal {text}: when the user states what they are trying to achieve, or changes direction. One sentence, in the user's terms.",
  "- add_clarified {text}: a detail the user clarified about their situation or what they mean (e.g. \"the team ships to Android and iOS\", \"by migration they mean gradual adoption\").",
  "- add_constraint {text}: a rule or term the user set (e.g. \"answers at most 3 sentences\", \"'CMP' = Compose Multiplatform\").",
  "- remove {id}: an item that no longer applies.",
  "- resolve_question {id}: an open question the user has now answered — or has dropped by moving on to something else.",
  "Rules:",
  "- Every open question gets resolve_question unless the message is chat: if the message answers it, resolve it (and apply the clarification);",
  "  if the message asks something else, sets a constraint or corrects something, the user has dropped it — resolve it too. An open question never stays open past a non-chat message.",
  "- A correction replaces the item it corrects: remove the old id and add the new text.",
  "- When the user changes direction, set the new goal and remove the clarified details and terms that only applied to the old focus",
  "  (e.g. names they gave to the articles of the old topic). Keep general constraints (like answer length) and facts about the user themselves (their team, platforms) unless they drop them.",
  "- Never store what the documents or the assistant said. Never store the question itself. Only the user's goal, clarifications and constraints.",
  "- Do not add an item that is already in the memory. Use only ids that exist in the memory.",
  "- Most messages need no operations: an empty memory_patch is normal.",
].join("\n");

/** `[c1]`, `[c1][c2]`, `[1]` out; whitespace folded. */
export const stripCitations = (text) =>
  String(text ?? "")
    .replace(/\s*\[c\d+(?:\s*,\s*c\d+)*\]/gi, "")
    .replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The last `turns` messages as the router reads them: a user message whole, an
 * assistant one cut to ~300 characters with citations stripped.
 *
 * @param {Array<{ role: string, content: string }>} messages - the stored chat, oldest first
 */
export function routerHistory(messages, turns = DEFAULT_HISTORY_TURNS) {
  return (messages ?? []).slice(-turns).map(({ role, content }) => {
    if (role !== "assistant") return { role: "user", content: String(content ?? "") };
    const flat = stripCitations(content);
    return { role: "assistant", content: flat.length > ASSISTANT_PREVIEW_CHARS ? flat.slice(0, ASSISTANT_PREVIEW_CHARS).replace(/\s+\S*$/, "") + " …" : flat };
  });
}

/** The router's one user message: memory, recent history, then the new message last. */
export function routerPrompt({ message, history, memory }) {
  const lines = history.length ? history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`) : ["(no earlier messages)"];
  return ["<task_memory>", renderMemory(memory), "</task_memory>", "", "<recent_messages>", ...lines, "</recent_messages>", "", "New message:", message].join("\n");
}

const clean = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

/**
 * The tool call → a route, with the code overrides applied.
 *
 * @param {object} completion
 * @param {{ message: string, memory: object }} o - the memory *before* this turn's patch
 * @returns {{ intent: string, routedIntent: string | null, override: string | null, standaloneQuestion: string, queries: string[], reply: string, patch: object[], called: boolean }}
 */
export function parseRoute(completion, { message, memory }) {
  const call = (completion?.content ?? []).find((block) => block?.type === "tool_use" && block.name === ROUTE_TOOL.name);
  const input = call?.input ?? {};
  const routedIntent = typeof input.intent === "string" ? input.intent : null;
  let intent = routedIntent;
  let override = null;
  if (!INTENTS.includes(intent)) {
    intent = "search";
    override = routedIntent == null ? "missing intent → search" : `invalid intent "${routedIntent}" → search`;
  }
  const open = taskMemoryOf(memory).open_questions;
  if (open.length && intent !== "chat" && intent !== "search") {
    override = `open question ${open.map((q) => q.id).join(", ")} → search`;
    intent = "search";
  }

  let standaloneQuestion = "";
  let queries = [];
  if (intent === "search") {
    const last = open.at(-1);
    standaloneQuestion = clean(input.standalone_question) || (last?.question ? `${last.question} (clarification: ${clean(message)})` : clean(message));
    for (const q of Array.isArray(input.queries) ? input.queries : []) {
      const t = clean(q);
      if (t && !queries.some((seen) => seen.toLowerCase() === t.toLowerCase())) queries.push(t);
    }
    queries = queries.slice(0, MAX_QUERIES);
    if (!queries.length) queries = [standaloneQuestion];
  }
  const reply = intent === "search" ? "" : clean(input.reply) || (intent === "chat" ? "You're welcome — ask me anything about the Kotlin articles." : "Noted.");
  return {
    intent,
    routedIntent,
    override,
    standaloneQuestion,
    queries,
    reply,
    patch: Array.isArray(input.memory_patch) ? input.memory_patch : [],
    called: Boolean(call),
  };
}

/**
 * @param {object} o
 * @param {import("../llm/provider.js").LlmProvider} o.provider
 * @param {string} [o.model] - RAG_ROUTER_MODEL
 * @param {string} o.message
 * @param {Array<{ role: string, content: string }>} o.messages - the stored chat so far
 * @param {object} o.memory - before this turn
 * @param {number} [o.historyTurns]
 */
export async function routeMessage({ provider, model, message, messages, memory, historyTurns = DEFAULT_HISTORY_TURNS }) {
  const history = routerHistory(messages, historyTurns);
  const completion = await provider.complete({
    system: ROUTER_SYSTEM,
    messages: [{ role: "user", content: routerPrompt({ message, history, memory }) }],
    tools: [ROUTE_TOOL],
    toolChoice: { name: ROUTE_TOOL.name },
    temperature: 0,
    maxTokens: 800,
    ...(model ? { model } : {}),
  });
  return { ...parseRoute(completion, { message, memory }), usage: completion?.usage ?? null, model: completion?.model ?? model ?? null };
}
