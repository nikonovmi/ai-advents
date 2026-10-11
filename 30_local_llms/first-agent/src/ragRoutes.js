import fs from "node:fs/promises";
import path from "node:path";

import express from "express";

import { isKnowledgeAgent } from "./agents.js";
import { CLAUDE, isLlmChoice, isLocalChoice } from "./llm/choice.js";
import { estimateCost } from "./llm/pricing.js";
import { answerQuestion, modeLabel as modeLabelOf, retrieveForQuestion } from "./rag/answer.js";
import { RAG_MAX_TOKENS, REPORTS_DIR, chatSettings, ragSettings } from "./rag/config.js";
import { chatSummaryRows } from "./rag/chatEval.js";
import { citationSummaryRows } from "./rag/citationsEval.js";
import { answerKnowledgeMessage, knowledgeView } from "./rag/knowledgeTurn.js";
import { localSummaryRows } from "./rag/localEval.js";
import { lineDiff, optQuestionRows, optSummaryRows } from "./rag/optEval.js";
import { summaryRows } from "./rag/eval.js";
import { sharedReranker } from "./rag/reranker.js";
import { RetrievalError, sharedRetriever } from "./rag/retriever.js";
import { routeMessage } from "./rag/router.js";
import { emptyMemory } from "./rag/taskMemory.js";
import { RAG_MODES, isValidSessionId } from "./store/conversationStore.js";

/**
 * **The Knowledge agent's chats, and the RAG eval page.**
 *
 * A Knowledge chat has no `Agent` and no strategy. With RAG on (Day 25) each
 * message goes through `runChatTurn`: the router (intent, standalone question,
 * queries, memory patch), then — for a search — `answerQuestion` with the
 * router's queries, reranked against the standalone question, answered with
 * the chat's task memory and the last few messages. The user message records
 * its route and the memory after it; the reply records the mode and chunks.
 * Without RAG it is Day 22's plain answer: no router, no memory. Routes that
 * the main server owns are answered here first for a Knowledge chat and passed
 * on for any other:
 *
 *   - `POST /chat` with `ragMode` (`rag` | `plain`), the `rerank` / `rewrite` switches and (Day 27) `llm`;
 *   - `GET /conversations/:id` → messages, `kind: "knowledge"`, `ragMode`, `rerank`, `rewrite`, `taskMemory`, `llm`.
 *
 * Day 27/28: a chat whose Model switch is a local model is answered by that
 * model in both modes. With RAG, every call of the turn — the router, the
 * `submit_answer` contract and the low-relevance clarification — goes to the
 * chat's local provider, built with `LOCAL_RAG_NUM_CTX`; retrieval and rerank
 * were always local. A failed local call is an error or a downgraded answer,
 * never a Claude answer: there is no path from a local chat to Claude.
 *
 * And its own:
 *
 *   - `PUT /conversations/:id/rag` `{ mode?, rerank?, rewrite? }` — the With RAG / Without RAG switch and the two RAG stages;
 *   - `DELETE /conversations/:id/task-memory` — the panel's reset button;
 *   - `POST /rag/compare` `{ question, rerank?, rewrite?, llm?, versus? }` — both modes side by side, stored nowhere;
 *     Day 28: `versus: "models"` answers one RAG question with Claude and with the local model `llm`,
 *     from one retrieval and rerank, so both get the same chunks;
 *   - `GET /rag/status` — the retrieval settings, and whether the models are loaded;
 *   - `GET /rag-report` — the eval page; `GET /rag-report/data` — its JSON (the
 *     Day 23 modes eval, the Day 24 citations eval, the Day 25 chat eval and the Day 28 local eval), read from `reports/` on every request.
 */

/** Short-term memory in plain mode: the last few exchanges, verbatim. (RAG mode: `RAG_HISTORY_TURNS`.) */
export const HISTORY_MESSAGES = 6;
/** A new Knowledge chat reranks: the low-relevance "I don't know" and the standalone-question rerank need it. */
export const DEFAULT_RAG_OPTIONS = { rerank: true, rewrite: false };
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
 *   routeTurn?: typeof routeMessage,
 *   chat?: ReturnType<typeof chatSettings>,
 *   log?: (line: string) => void,
 * }} deps - `search`, `rerankScores`, `rewriter` and `routeTurn` replace doc_index and the model calls (the tests pass fakes).
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
  routeTurn = routeMessage,
  chat = chatSettings(),
  log = console.log,
  llms = { providerFor: () => provider, ragProviderFor: () => provider, defaultChoice: async () => CLAUDE, claudeAvailable: true },
}) {
  const router = express.Router();
  const fakes = { ...(search ? { search } : {}), ...(rerankScores ? { rerankScores } : {}), ...(rewriter ? { rewriter } : {}), log };
  const ask = (question, { mode, rerank = false, rewrite = false }, history = [], using = provider) =>
    answer(question, { mode, rerank, rewrite, history, provider: using, ...settings, ...fakes });
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
      const wantedLlm = req.body?.llm;
      if (wantedLlm !== undefined && !isLlmChoice(wantedLlm)) return res.status(400).json({ error: "'llm' must be \"claude\" or \"local:<model>\"." });
      const llm = wantedLlm ?? record?.llm ?? (await llms.defaultChoice());
      const local = isLocalChoice(llm);
      if (!local && !llms.claudeAvailable) return res.status(400).json({ error: "Claude isn't available: ANTHROPIC_API_KEY is not set. Pick a local model in the Model switch." });
      const mode = ragMode ?? record?.ragMode ?? "rag";
      const ragOptions = { rerank: rerank ?? record?.ragOptions?.rerank ?? DEFAULT_RAG_OPTIONS.rerank, rewrite: rewrite ?? record?.ragOptions?.rewrite ?? DEFAULT_RAG_OPTIONS.rewrite };

      try {
        res.json(
          await answerKnowledgeMessage({
            store,
            sessionId,
            record,
            message: message.trim(),
            mode,
            ragOptions,
            llm,
            agent: req.body.agent,
            llms,
            settings,
            fakes,
            chat,
            historyMessages: HISTORY_MESSAGES,
            routeTurn,
            answer,
            log,
          }),
        );
      } catch (err) {
        return failure(res, err);
      }
    }),
  );

  router.get(
    "/conversations/:id",
    route(async (req, res, next) => {
      const record = await knowledgeChat(req.params.id, req.query?.agent);
      if (record === undefined) return next();
      res.json(knowledgeView(record, DEFAULT_RAG_OPTIONS));
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
      const ragOptions = { rerank: rerank ?? record?.ragOptions?.rerank ?? DEFAULT_RAG_OPTIONS.rerank, rewrite: rewrite ?? record?.ragOptions?.rewrite ?? DEFAULT_RAG_OPTIONS.rewrite };
      // A chat nobody has written in yet is not saved for a switch: the page
      // keeps the switches and the first message stores them.
      if (!record) return res.json({ mode, ...ragOptions, saved: false });
      await store.save(id, record.messages, undefined, { ragMode: mode, ragOptions });
      res.json({ mode, ...ragOptions, saved: true });
    }),
  );

  router.delete(
    "/conversations/:id/task-memory",
    route(async (req, res, next) => {
      const record = await knowledgeChat(req.params.id, "knowledge");
      if (record === undefined) return next();
      // Nothing written yet: nothing to clear.
      if (!record) return res.json({ taskMemory: emptyMemory(), saved: false });
      await store.save(req.params.id, record.messages, undefined, { taskMemory: emptyMemory() });
      res.json({ taskMemory: emptyMemory(), saved: true });
    }),
  );

  /** Day 28: Compare's timings, per side: the shared retrieval and rerank, then this generator's own. */
  const sideTimings = (r) => {
    const m = r.generation?.metrics ?? {};
    const generationMs = r.timings.llmMs + r.timings.clarifyMs;
    return {
      retrieveMs: r.timings.retrieveMs,
      rerankMs: r.timings.rerankMs,
      rewriteMs: r.timings.rewriteMs,
      ttftMs: m.ttftMs ?? null,
      generationMs: m.evalMs ?? null,
      answerMs: generationMs,
      totalMs: r.timings.rewriteMs + r.timings.retrieveMs + r.timings.rerankMs + generationMs,
    };
  };
  const shape = (r) => ({ ...r, cost: estimateCost({ model: r.model, inputTokens: r.usage?.inputTokens, outputTokens: r.usage?.outputTokens }).totalCost, compareTimings: sideTimings(r) });

  router.post(
    "/rag/compare",
    route(async (req, res) => {
      const question = req.body?.question;
      if (typeof question !== "string" || !question.trim()) return res.status(400).json({ error: "A non-empty 'question' is required." });
      if (question.length > MAX_QUESTION_CHARS) return res.status(400).json({ error: `A question is at most ${MAX_QUESTION_CHARS} characters.` });
      const llm = req.body?.llm;
      if (llm !== undefined && !isLlmChoice(llm)) return res.status(400).json({ error: "'llm' must be \"claude\" or \"local:<model>\"." });
      const versus = req.body?.versus ?? "modes";
      if (versus !== "modes" && versus !== "models") return res.status(400).json({ error: "'versus' must be \"modes\" or \"models\"." });
      const local = isLocalChoice(llm);
      let options;
      try {
        // The Rewrite stage is Claude's: never part of a local generator's run.
        options = { mode: "rag", rerank: switchOf(req.body, "rerank") ?? false, rewrite: local || versus === "models" ? false : (switchOf(req.body, "rewrite") ?? false) };
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      if (versus === "models") {
        if (!local) return res.status(400).json({ error: "Claude vs local needs 'llm': the local model to compare (\"local:<model>\")." });
        if (!llms.claudeAvailable) return res.status(400).json({ error: "Claude isn't available: ANTHROPIC_API_KEY is not set, so there is nothing to compare the local model with." });
        let retrieval;
        try {
          // Once, for both: the comparison isolates generation.
          retrieval = await retrieveForQuestion(question.trim(), { ...settings, ...fakes, rerank: options.rerank, rewrite: false });
        } catch (err) {
          return failure(res, err);
        }
        const claudeProvider = provider.streaming?.() ?? provider;
        const [claudeSide, localSide] = await Promise.allSettled([
          answer(question.trim(), { ...options, provider: claudeProvider, retrieval, ...settings, ...fakes }),
          answer(question.trim(), { ...options, provider: llms.ragProviderFor(llm), retrieval, ...settings, ...fakes }),
        ]);
        // Each side stands alone: a failed local call is shown as that side's error, never filled in by Claude.
        const side = (s) => (s.status === "fulfilled" ? shape(s.value) : { error: readableError(s.reason) });
        return res.json({
          question: question.trim(),
          versus,
          llm,
          label: retrieval ? modeLabelOf(options) : null,
          retrieval: { timings: retrieval.timings, chunks: retrieval.chunks.length, declined: retrieval.declined },
          claude: side(claudeSide),
          local: side(localSide),
        });
      }

      try {
        // RAG first: it is the one that can fail on retrieval, and a failure
        // should not leave a plain answer paid for and thrown away.
        const rag = await ask(question.trim(), options, [], llms.ragProviderFor(llm ?? CLAUDE));
        const plain = await ask(question.trim(), { mode: "plain" }, [], llms.providerFor(llm ?? CLAUDE));
        res.json({ question: question.trim(), versus, rag: shape(rag), plain: shape(plain) });
      } catch (err) {
        failure(res, err);
      }
    }),
  );

  router.get("/rag/status", (_req, res) => {
    res.json({ ...settings, ...chat, maxTokens: RAG_MAX_TOKENS, model: provider.model ?? null, ready: ready(), rerankerReady: rerankerReady(), localRagNumCtx: llms.settings?.ragNumCtx ?? null });
  });

  if (publicDir) router.get("/rag-report", (_req, res) => res.sendFile(path.join(publicDir, "rag-report.html")));

  router.get(
    "/rag-report/data",
    route(async (_req, res) => {
      const read = (name) => fs.readFile(path.join(reportsDir, name), "utf8").catch((err) => (err.code === "ENOENT" ? null : Promise.reject(err)));
      const [results, notes, citationResults, citationNotes, chatResults, chatNotes, localResults, localNotes, optResults, optNotes] = await Promise.all([
        read("rag_results.json"),
        read("rag_notes.md"),
        read("citations_results.json"),
        read("citations_notes.md"),
        read("chat_results.json"),
        read("chat_notes.md"),
        read("local_rag_results.json"),
        read("local_rag_notes.md"),
        read("local_opt_results.json"),
        read("local_opt_notes.md"),
      ]);
      const parsed = results ? JSON.parse(results) : null;
      // The summary tables' rows, built by the same code as the Markdown reports'.
      if (parsed?.summary?.byMode) parsed.summaryRows = summaryRows(parsed.summary);
      const citations = citationResults ? JSON.parse(citationResults) : null;
      if (citations?.summary) citations.summaryRows = citationSummaryRows(citations.summary);
      const chatParsed = chatResults ? JSON.parse(chatResults) : null;
      for (const scenario of chatParsed?.scenarios ?? []) scenario.summaryRows = chatSummaryRows(scenario.summary);
      const local = localResults ? JSON.parse(localResults) : null;
      if (local?.generators) local.summaryTable = localSummaryRows(local.generators);
      // Day 29: the optimization runs, with their tables and the v1 → v2 prompt diffs built here.
      const opt = optResults ? JSON.parse(optResults) : null;
      if (opt?.variants) {
        opt.summaryTable = optSummaryRows(opt);
        opt.questionRows = optQuestionRows(opt);
        for (const p of opt.prompts?.list ?? []) if (p.diff) p.lines = lineDiff(p.v1.text, p.v2.text);
      }
      res.json({ results: parsed, notes, citations, citationNotes, chat: chatParsed, chatNotes, local, localNotes, opt, optNotes });
    }),
  );

  return router;
}
