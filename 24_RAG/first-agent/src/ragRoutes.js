import fs from "node:fs/promises";
import path from "node:path";

import express from "express";

import { agentOf, isKnowledgeAgent } from "./agents.js";
import { estimateCost } from "./llm/pricing.js";
import { answerQuestion } from "./rag/answer.js";
import { RAG_MAX_TOKENS, REPORTS_DIR, ragSettings } from "./rag/config.js";
import { citationSummaryRows } from "./rag/citationsEval.js";
import { summaryRows } from "./rag/eval.js";
import { sharedReranker } from "./rag/reranker.js";
import { RetrievalError, sharedRetriever } from "./rag/retriever.js";
import { RAG_MODES, isValidSessionId, nextMessageId, normaliseUsage } from "./store/conversationStore.js";

/**
 * **The Knowledge agent's chats, and the RAG eval page.**
 *
 * A Knowledge chat is plain Q&A: no `Agent`, no strategy, no memory. Each
 * message goes through `answerQuestion` in the chat's mode, with the last few
 * messages as history and nothing else, and the reply records which mode
 * produced it and which chunks it was given. Routes that the main server owns
 * are answered here first for a Knowledge chat and passed on for any other:
 *
 *   - `POST /chat` with `ragMode` (`rag` | `plain`) and the `rerank` / `rewrite` switches;
 *   - `GET /conversations/:id` → messages, `kind: "knowledge"`, `ragMode`, `rerank`, `rewrite`.
 *
 * And its own:
 *
 *   - `PUT /conversations/:id/rag` `{ mode?, rerank?, rewrite? }` — the With RAG / Without RAG switch and the two RAG stages;
 *   - `POST /rag/compare` `{ question, rerank?, rewrite? }` — both modes side by side, stored nowhere;
 *   - `GET /rag/status` — the retrieval settings, and whether the models are loaded;
 *   - `GET /rag-report` — the eval page; `GET /rag-report/data` — its JSON (the
 *     Day 23 modes eval and the Day 24 citations eval), read from `reports/` on every request.
 */

/** Short-term memory: the last few exchanges, verbatim. Nothing older, nothing folded. */
export const HISTORY_MESSAGES = 6;
const MAX_QUESTION_CHARS = 4000;

/**
 * @param {{
 *   store: import("./store/conversationStore.js").ConversationStore,
 *   provider: import("./llm/provider.js").LlmProvider,
 *   answer?: typeof answerQuestion,
 *   search?: (question: string, o: object) => Promise<object[]>,
 *   rerankScores?: (query: string, passages: string[]) => Promise<number[]>,
 *   rewriter?: (question: string, o: object) => Promise<{ queries: string[], usage?: object }>,
 *   settings?: ReturnType<typeof ragSettings>,
 *   reportsDir?: string,
 *   publicDir?: string,
 *   readableError?: (err: unknown) => string,
 *   ready?: () => boolean,
 *   rerankerReady?: () => boolean,
 * }} deps - `search`, `rerankScores` and `rewriter` replace doc_index and the rewrite call (the tests pass fakes).
 */
export function ragRoutes({
  store,
  provider,
  answer = answerQuestion,
  search,
  rerankScores,
  rewriter,
  settings = ragSettings(),
  reportsDir = REPORTS_DIR,
  publicDir,
  readableError = (err) => String(err?.message ?? err),
  ready = () => sharedRetriever().ready(),
  rerankerReady = () => sharedReranker().ready(),
}) {
  const router = express.Router();
  const fakes = { ...(search ? { search } : {}), ...(rerankScores ? { rerankScores } : {}), ...(rewriter ? { rewriter } : {}) };
  const ask = (question, { mode, rerank = false, rewrite = false }, history = []) =>
    answer(question, { mode, rerank, rewrite, history, provider, ...settings, ...fakes });
  /** A switch from a request body: true, false, or undefined when absent. Anything else is an error. */
  const switchOf = (body, name) => {
    const value = body?.[name];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") throw Object.assign(new Error(`'${name}' must be true or false.`), { status: 400 });
    return value;
  };

  /** The record if `id` is (or, for a new id, is about to be) a Knowledge chat; else undefined. */
  async function knowledgeChat(id, wanted) {
    if (!isValidSessionId(id)) return undefined;
    const record = await store.load(id);
    if (record) return isKnowledgeAgent(record.agentId) ? record : undefined;
    return isKnowledgeAgent(wanted) ? null : undefined;
  }

  const route = (handler) => async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      console.error(`[${req.method} ${req.path}]`, err);
      res.status(500).json({ error: readableError(err) });
    }
  };

  /** A failure as the page sees it: retrieval problems say what to run, others go through the server's own wording. */
  function failure(res, err) {
    if (err instanceof RetrievalError) return res.status(503).json({ error: err.message, retrieval: true });
    console.error("[rag]", err);
    return res.status(500).json({ error: readableError(err) });
  }

  router.post(
    "/chat",
    route(async (req, res, next) => {
      const { message, sessionId, ragMode } = req.body ?? {};
      let rerank, rewrite;
      try {
        rerank = switchOf(req.body, "rerank");
        rewrite = switchOf(req.body, "rewrite");
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      const record = await knowledgeChat(sessionId, req.body?.agent);
      if (record === undefined) return next();

      if (typeof message !== "string" || !message.trim()) return res.status(400).json({ error: "A non-empty 'message' is required." });
      if (message.length > MAX_QUESTION_CHARS) return res.status(400).json({ error: `A question is at most ${MAX_QUESTION_CHARS} characters.` });
      if (ragMode !== undefined && !RAG_MODES.includes(ragMode)) return res.status(400).json({ error: "'ragMode' must be \"rag\" or \"plain\"." });
      const mode = ragMode ?? record?.ragMode ?? "rag";
      const ragOptions = { rerank: rerank ?? record?.ragOptions?.rerank ?? false, rewrite: rewrite ?? record?.ragOptions?.rewrite ?? false };

      const messages = record?.messages ?? [];
      const history = messages.slice(-HISTORY_MESSAGES).map(({ role, content }) => ({ role, content }));
      const startedAt = Date.now();
      let result;
      try {
        result = await ask(message.trim(), { mode, ...ragOptions }, history);
      } catch (err) {
        return failure(res, err);
      }

      const { inputTokens, outputTokens } = result.usage ?? {};
      const cost = estimateCost({ model: result.model, inputTokens, outputTokens });
      const tokens = { input: inputTokens, output: outputTokens, total: (inputTokens ?? 0) + (outputTokens ?? 0) };
      const userMessage = { role: "user", content: message.trim(), id: nextMessageId(messages) };
      const reply = {
        role: "assistant",
        content: result.answer,
        id: nextMessageId([...messages, userMessage]),
        tokens,
        cost: { input: cost.inputCost, output: cost.outputCost, total: cost.totalCost },
        model: result.model,
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
        },
      };
      const usage = normaliseUsage(record?.usage);
      usage.totalInputTokens += inputTokens ?? 0;
      usage.totalOutputTokens += outputTokens ?? 0;
      usage.totalCostUsd += cost.totalCost ?? 0;
      usage.turnCount += 1;
      await store.save(sessionId, [...messages, userMessage, reply], usage, { agentId: agentOf(record?.agentId ?? req.body.agent), ragMode: mode, ragOptions });

      res.json({
        reply: result.answer,
        meta: { ...reply, turn: { userMessageId: userMessage.id, replyMessageId: reply.id } },
      });
    }),
  );

  router.get(
    "/conversations/:id",
    route(async (req, res, next) => {
      const record = await knowledgeChat(req.params.id, req.query?.agent);
      if (record === undefined) return next();
      res.json({
        messages: record?.messages ?? [],
        agentId: "knowledge",
        kind: "knowledge",
        ragMode: record?.ragMode ?? "rag",
        rerank: record?.ragOptions?.rerank ?? false,
        rewrite: record?.ragOptions?.rewrite ?? false,
        forkedFrom: record?.forkedFrom ?? null,
        panel: { kind: "knowledge" },
      });
    }),
  );

  router.put(
    "/conversations/:id/rag",
    route(async (req, res) => {
      const { id } = req.params;
      if (!isValidSessionId(id)) return res.status(400).json({ error: "Not a valid conversation id." });
      let rerank, rewrite;
      try {
        rerank = switchOf(req.body, "rerank");
        rewrite = switchOf(req.body, "rewrite");
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      const given = req.body?.mode;
      if (given !== undefined && !RAG_MODES.includes(given)) return res.status(400).json({ error: "'mode' must be \"rag\" or \"plain\"." });
      if (given === undefined && rerank === undefined && rewrite === undefined) return res.status(400).json({ error: "Send 'mode', 'rerank' or 'rewrite'." });
      const record = await knowledgeChat(id, "knowledge");
      const mode = given ?? record?.ragMode ?? "rag";
      const ragOptions = { rerank: rerank ?? record?.ragOptions?.rerank ?? false, rewrite: rewrite ?? record?.ragOptions?.rewrite ?? false };
      // A chat nobody has written in yet is not saved for a switch: the page
      // keeps the switches and the first message stores them.
      if (!record) return res.json({ mode, ...ragOptions, saved: false });
      await store.save(id, record.messages, undefined, { ragMode: mode, ragOptions });
      res.json({ mode, ...ragOptions, saved: true });
    }),
  );

  router.post(
    "/rag/compare",
    route(async (req, res) => {
      const question = req.body?.question;
      if (typeof question !== "string" || !question.trim()) return res.status(400).json({ error: "A non-empty 'question' is required." });
      if (question.length > MAX_QUESTION_CHARS) return res.status(400).json({ error: `A question is at most ${MAX_QUESTION_CHARS} characters.` });
      let options;
      try {
        options = { mode: "rag", rerank: switchOf(req.body, "rerank") ?? false, rewrite: switchOf(req.body, "rewrite") ?? false };
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      try {
        // RAG first: it is the one that can fail on retrieval, and a failure
        // should not leave a plain answer paid for and thrown away.
        const rag = await ask(question.trim(), options);
        const plain = await ask(question.trim(), { mode: "plain" });
        const shape = (r) => ({ ...r, cost: estimateCost({ model: r.model, inputTokens: r.usage?.inputTokens, outputTokens: r.usage?.outputTokens }).totalCost });
        res.json({ question: question.trim(), rag: shape(rag), plain: shape(plain) });
      } catch (err) {
        failure(res, err);
      }
    }),
  );

  router.get("/rag/status", (_req, res) => {
    res.json({ ...settings, maxTokens: RAG_MAX_TOKENS, model: provider.model ?? null, ready: ready(), rerankerReady: rerankerReady() });
  });

  if (publicDir) router.get("/rag-report", (_req, res) => res.sendFile(path.join(publicDir, "rag-report.html")));

  router.get(
    "/rag-report/data",
    route(async (_req, res) => {
      const read = (name) => fs.readFile(path.join(reportsDir, name), "utf8").catch((err) => (err.code === "ENOENT" ? null : Promise.reject(err)));
      const [results, notes, citationResults, citationNotes] = await Promise.all([
        read("rag_results.json"),
        read("rag_notes.md"),
        read("citations_results.json"),
        read("citations_notes.md"),
      ]);
      const parsed = results ? JSON.parse(results) : null;
      // The summary tables' rows, built by the same code as the Markdown reports'.
      if (parsed?.summary?.byMode) parsed.summaryRows = summaryRows(parsed.summary);
      const citations = citationResults ? JSON.parse(citationResults) : null;
      if (citations?.summary) citations.summaryRows = citationSummaryRows(citations.summary);
      res.json({ results: parsed, notes, citations, citationNotes });
    }),
  );

  return router;
}
