import { agentOf } from "../agents.js";
import { estimateCost } from "../llm/pricing.js";
import { nextMessageId, normaliseUsage } from "../store/conversationStore.js";
import { answerQuestion } from "./answer.js";
import { runChatTurn } from "./chatTurn.js";
import { routeMessage } from "./router.js";
import { taskMemoryOf } from "./taskMemory.js";

/**
 * **One Knowledge chat message, answered and saved** — the body of `POST /chat`
 * for a Knowledge chat, shared by the full app (`ragRoutes.js`) and the hosted
 * service (Day 30, `src/hosted/`), so both answer and store a turn the same way.
 *
 * With RAG the turn is `runChatTurn` (router → memory patch → search or reply);
 * without, Day 22's plain answer over the last `HISTORY_MESSAGES`. The user
 * message records its route, the reply its mode, chunks, citations and timings,
 * and the record its switches, model and task memory.
 *
 * Errors from the model calls and retrieval are thrown as they are; the caller
 * decides how they look (a `RetrievalError` is a 503 in both servers).
 *
 * @param {object} o
 * @param {import("../store/conversationStore.js").ConversationStore} o.store
 * @param {string} o.sessionId
 * @param {object | null} o.record - the stored chat, or null for a new one
 * @param {string} o.message - trimmed
 * @param {"rag" | "plain"} o.mode
 * @param {{ rerank: boolean, rewrite: boolean }} o.ragOptions
 * @param {string} o.llm - `claude` or `local:<model>`
 * @param {string} [o.agent] - the agent the request named (a new chat's)
 * @param {object} o.llms - `createLlms()`'s `providerFor` / `ragProviderFor`
 * @param {object} o.settings - `ragSettings()`
 * @param {object} [o.fakes] - search / rerankScores / rewriter / log (tests)
 * @param {{ routerModel: string, historyTurns: number }} o.chat - `chatSettings()`
 * @param {number} o.historyMessages - plain mode's short-term memory
 * @param {typeof routeMessage} [o.routeTurn]
 * @param {typeof answerQuestion} [o.answer]
 * @param {(line: string) => void} [o.log]
 * @returns {Promise<{ reply: string, meta: object }>} what `POST /chat` answers with
 */
export async function answerKnowledgeMessage({
  store,
  sessionId,
  record,
  message,
  mode,
  ragOptions,
  llm,
  agent,
  llms,
  settings,
  fakes = {},
  chat,
  historyMessages,
  routeTurn = routeMessage,
  answer = answerQuestion,
  log = console.log,
}) {
  const messages = record?.messages ?? [];
  const history = messages.slice(-historyMessages).map(({ role, content }) => ({ role, content }));
  const startedAt = Date.now();
  const memoryBefore = taskMemoryOf(record?.taskMemory);
  let result;
  let turn = null;
  if (mode === "rag") {
    turn = await runChatTurn({
      message,
      messages,
      memory: memoryBefore,
      turn: messages.filter((m) => m.role === "user").length + 1,
      // Day 28: the chat's provider for every call of the turn; a local one is sized for RAG.
      provider: llms.ragProviderFor(llm),
      routerModel: chat.routerModel,
      historyTurns: chat.historyTurns,
      ragOptions: { ...settings, ...fakes, rerank: ragOptions.rerank },
      router: routeTurn,
      answer,
      log,
    });
    result = turn.result;
  } else {
    result = await answer(message, { mode, ...ragOptions, history, provider: llms.providerFor(llm), ...settings, ...fakes });
  }

  // A chat or memory_only turn made one call, the router's; a search turn the router's and the answer's.
  const routerUsage = turn?.route.routerUsage ?? null;
  const answerUsage = result?.usage ?? null;
  const inputTokens = (routerUsage?.inputTokens ?? 0) + (answerUsage?.inputTokens ?? 0);
  const outputTokens = (routerUsage?.outputTokens ?? 0) + (answerUsage?.outputTokens ?? 0);
  const routerCost = routerUsage ? estimateCost({ model: turn.route.routerModel, inputTokens: routerUsage.inputTokens, outputTokens: routerUsage.outputTokens }) : null;
  const answerCost = answerUsage ? estimateCost({ model: result.model, inputTokens: answerUsage.inputTokens, outputTokens: answerUsage.outputTokens }) : null;
  const plus = (key) => (routerCost?.[key] == null && answerCost?.[key] == null ? null : (routerCost?.[key] ?? 0) + (answerCost?.[key] ?? 0));
  const cost = { inputCost: plus("inputCost"), outputCost: plus("outputCost"), totalCost: plus("totalCost") };
  const tokens = { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens };
  const userMessage = { role: "user", content: message, id: nextMessageId(messages), ...(turn ? { route: turn.route } : {}) };
  const usage = normaliseUsage(record?.usage);
  usage.totalInputTokens += inputTokens;
  usage.totalOutputTokens += outputTokens;
  usage.totalCostUsd += cost.totalCost ?? 0;
  usage.turnCount += 1;
  const agentId = agentOf(record?.agentId ?? agent);

  if (!result) {
    // chat / memory_only: the router's reply, no documents.
    const reply = {
      role: "assistant",
      content: turn.reply,
      id: nextMessageId([...messages, userMessage]),
      tokens,
      cost: { input: cost.inputCost, output: cost.outputCost, total: cost.totalCost },
      model: turn.route.routerModel,
      ...(turn.route.routerProvider ? { provider: turn.route.routerProvider } : {}),
      ...(turn.route.routerProvider === "local" && turn.route.routerMetrics ? { localMetrics: turn.route.routerMetrics } : {}),
      ...(turn.route.possible_truncation ? { possible_truncation: true } : {}),
      ms: Date.now() - startedAt,
      stopReason: "routed",
    };
    await store.save(sessionId, [...messages, userMessage, reply], usage, { agentId, ragMode: mode, ragOptions, taskMemory: turn.memory, llm });
    return { reply: reply.content, meta: { ...reply, route: turn.route, taskMemory: turn.memory, turn: { userMessageId: userMessage.id, replyMessageId: reply.id } } };
  }
  const reply = {
    role: "assistant",
    content: result.answer,
    id: nextMessageId([...messages, userMessage]),
    tokens,
    cost: { input: cost.inputCost, output: cost.outputCost, total: cost.totalCost },
    model: result.model,
    ...(result.provider ? { provider: result.provider } : {}),
    ...(result.localMetrics ? { localMetrics: result.localMetrics } : {}),
    ...(result.possible_truncation || turn?.route.possible_truncation ? { possible_truncation: true } : {}),
    ms: Date.now() - startedAt,
    stopReason: result.stopReason,
    ...(result.stopReason === "max_tokens" ? { truncated: true } : {}),
    rag: {
      mode,
      label: result.label,
      rerank: result.rerank,
      rewrite: result.rewrite,
      queries: result.queries,
      candidates: result.candidates,
      chunks: result.chunks,
      declined: result.declined,
      rejected: result.rejected,
      ...(mode === "rag"
        ? {
            status: result.status,
            citations: result.citations,
            sources: result.sources,
            clarifyingQuestion: result.clarifyingQuestion,
            dontKnow: result.dontKnow,
            verification: result.verification,
          }
        : {}),
      timings: result.timings,
      ...(result.generation ? { generation: { invalidJson: result.generation.invalidJson, schemaFailures: result.generation.schemaFailures, calls: result.generation.calls.length } } : {}),
    },
  };
  await store.save(sessionId, [...messages, userMessage, reply], usage, {
    agentId,
    ragMode: mode,
    ragOptions,
    llm,
    ...(turn ? { taskMemory: turn.memory } : {}),
  });
  return {
    reply: result.answer,
    meta: { ...reply, ...(turn ? { route: turn.route, taskMemory: turn.memory } : {}), turn: { userMessageId: userMessage.id, replyMessageId: reply.id } },
  };
}

/** `GET /conversations/:id` for a Knowledge chat (a new id reads as an empty one). */
export function knowledgeView(record, defaults) {
  return {
    messages: record?.messages ?? [],
    agentId: "knowledge",
    kind: "knowledge",
    ragMode: record?.ragMode ?? "rag",
    rerank: record?.ragOptions?.rerank ?? defaults.rerank,
    rewrite: record?.ragOptions?.rewrite ?? defaults.rewrite,
    taskMemory: taskMemoryOf(record?.taskMemory),
    llm: record?.llm ?? null,
    forkedFrom: record?.forkedFrom ?? null,
    panel: { kind: "knowledge" },
  };
}
