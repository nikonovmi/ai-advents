# Day 25 — Mini-chat with RAG + task memory

Turn the Knowledge agent in `first-agent` into a multi-turn chat. Each turn is routed;
every content question goes through the RAG pipeline from Days 22–24 and is answered
with verified citations; and a per-chat **task memory** keeps the goal, clarified
details and constraints across the conversation. Then test it with two long scripted
scenarios.

Read both READMEs and the Day 22–24 code (`src/rag/`, `eval/rag/`, `/rag-report`)
first. Reuse retrieval, rerank, cutoff, the `submit_answer` contract, quote
verification, "I don't know", the judge and the report page. Build only what this spec
asks for.

**Out of scope for this agent:** the planning → execution → validation lifecycle, the
digest, the long-term profile and project invariants. Don't enable or wire them in. If
the existing working-task memory is tied to the lifecycle, don't reuse it. Reuse only
separable parts (storage helpers, UI panel styles), and give this agent the small task
state described below.

## Per-turn flow

```
message → router (LLM call 1) → apply memory patch → branch on intent
  chat / memory_only → router's reply                                  (1 call)
  search → retrieve → rerank → cutoff → answer + verify                (2 calls)
           └ nothing relevant → "I don't know" + clarifying question   (2 calls)
```

### Router

- Make one call per user message with a forced tool `route`. The model comes from
  `RAG_ROUTER_MODEL`, default `claude-haiku-4-5-20251001`. Use temperature 0.
- Its input is the new message, the last `RAG_HISTORY_TURNS` messages (default 6),
  and the task memory. For earlier assistant messages, send only the first ~300 chars
  with citations stripped. Don't send retrieved chunks.
- Output:

```js
{
  intent: "search" | "memory_only" | "chat",
  standalone_question: "…",   // search only: the full question, with references resolved
  queries: ["…"],             // search only: 1–3 short search queries (Day 23 rules)
  reply: "…",                 // chat / memory_only only: the short reply to show
  memory_patch: [ … ]         // see Task memory; may be empty
}
```

- Rules in the router prompt:
  - **search** is for anything that asks about content, including "why?", "tell me
    more", and "and the second one?".
  - **memory_only** is for constraints, corrections, preferences, and definitions of
    terms.
  - **chat** is for greetings, thanks, and acknowledgements.
  - A message that mixes several kinds is **search**.
  - A reply to an open clarifying question is **search**, and `standalone_question` =
    the original question with the clarification applied.
  - When unsure, choose search.
  - Queries contain the resolved subject and any clarified terms. They do not repeat
    the goal or the constraints.
- **Code overrides:** if the intent is missing or invalid → search. If an open question
  exists and the intent isn't `chat` → search.

### Search turns

- Use the Day 23 pipeline with the router's `queries`. **Rerank against
  `standalone_question`**, not the raw message. Raw follow-ups like "and the second
  one?" mean nothing to a reranker. Same cutoff, same `K_RETRIEVE` / `K_FINAL`.
- Build the answering call as on Day 24 (same `submit_answer` contract and
  verification). Add three things: the task memory, the last `RAG_HISTORY_TURNS`
  messages, and `standalone_question` next to the user's actual message.
- Rules added to the answer prompt:
  - Follow the constraints in the task memory, such as length, terms, and focus.
  - Facts from documents need `[cN]` citations as before.
  - A statement that comes from the user's own earlier messages is written as
    "(as you said)" and needs no citation.
  - Task memory is never a source.
- "I don't know" works as on Day 24. In addition, **code** adds the clarifying question
  to `open_questions`, so the next turn can resolve it. Don't rely on the router for
  this.

## Task memory

Keep it per chat, stored with the chat in the existing storage:

```js
{ goal: string | null,
  clarified: [{ id, text, turn }],     // details the user has clarified
  constraints: [{ id, text, turn }],   // rules and terms the user set ("answers ≤ 5 sentences", "'model' = the embedding model")
  open_questions: [{ id, text, turn }] }
```

- The router's `memory_patch` is a list of operations: `set_goal`, `add_clarified`,
  `add_constraint`, `remove` (by id), and `resolve_question` (by id). Never send a
  full rewrite. Code validates and applies the operations. An unknown id or op is
  logged and skipped, never fatal. Nothing is removed except by an explicit op.
- Router rules for patches:
  - When the user changes direction, update the goal and remove the details that no
    longer apply.
  - A correction replaces the item it corrects.
  - Don't store things the documents said. Memory holds the user's goal, clarifications
    and constraints only.
- Each turn's result stores the patch it applied and the memory after it, so the UI
  and the eval can show how memory changed turn by turn.

## UI (Knowledge agent)

- **Intent badge:** each user message gets a small badge showing `search`, `memory`, or
  `chat`. For search turns, expanding it shows the standalone question and the queries.
- **Task memory panel:** a collapsible side panel showing the current goal, clarified
  details, constraints, and open questions. Items added or removed in the latest turn
  are highlighted. A reset button clears the memory for this chat. The panel is
  read-only otherwise.
- Keep everything from Day 24: answers with citation chips, sources, the verification
  badge, and "I don't know" with its clarifying question.

## Test: two long scenarios

Write the scenarios **after reading the corpus**. Save them as
`eval/chat/scenario-1.json` and `scenario-2.json`, each with **12–15 user messages**:

1. **Deep dive:** the user explores one topic from `knowledge_database/` step by step,
   with a stated goal.
2. **Comparison:** the user compares what two different documents say and works toward a
   decision.

Between them, the scenarios must include:

- the goal stated in one of the first 2 messages;
- a constraint (a checkable one, e.g. "max 3 sentences") and a defined term;
- pronoun or reference follow-ups ("why is that?", "and the other one?");
- a vague question that should get "I don't know" plus a clarifying question, followed
  by the user's clarification, after which the next answer should succeed;
- a correction ("no, I meant …");
- a chat-only message and an off-topic detour, after which the user returns to the topic;
- a change of direction in scenario 2, after which the memory must let go of the old
  focus;
- a late question (message 10 or later) that only makes sense with something from
  messages 1–3. By then, message 1 is outside the history window, so only the task
  memory can carry it.

Each message entry:

```json
{ "turn": 4,
  "user": "…",
  "expected_intent": "search",
  "expect": {
    "decline": false,
    "sources": ["source values, when a specific document must be used"],
    "facts": ["optional key facts, as in Day 22"]
  },
  "memory_checkpoint": ["optional statements the memory must reflect after this turn"],
  "notes": "what this turn tests" }
```

Add `"constraint_check": { "max_sentences": 3 }` (or similar) on turns where a
constraint can be checked mechanically.

### Runner

`npm run eval:chat [-- scenario-1]` replays each scenario through **the same code path
as the UI**, with real API calls and a fresh chat each run. Check every turn:

| check | how |
| --- | --- |
| intent | router intent vs `expected_intent` |
| sources + citations | search turns: at least 1 source and at least 1 verified citation, or a correct "I don't know" when `decline` is true; also count fabricated quotes on the first attempt |
| expected source used | when `expect.sources` is given: retrieved and cited |
| constraint respected | mechanical checks where defined (sentence or word count) |
| memory checkpoint | judge call: does the memory reflect each statement? Also flag stale items that should have been removed |
| on track | judge call: does the answer address the resolved question in this conversation, consistent with the goal and constraints? Reuse the Day 24 faithfulness judge for its claims |
| facts | when `expect.facts` is given: the Day 22 fact score |

Write `reports/chat_results.json` and `reports/chat_report.md`, and add a **Chat** tab
to `/rag-report` with:

- **Summary per scenario:** intent accuracy, % of search turns with sources and
  citations, fabricated quotes, correct and false declines, constraint compliance,
  memory checkpoints passed, on-track rate, and router plus answer latency per turn.
- **Turn-by-turn timeline:** user message → intent (expected vs actual) → queries →
  answer with citations → memory diff → pass/fail per check. Failing turns are
  highlighted.
- **Findings** in `reports/chat_notes.md`, written from the actual numbers: where (if
  anywhere) the conversation slipped, whether the clarification loop worked, whether
  memory kept or dropped the right things, and whether the Haiku router mislabeled
  anything.

## Tests (offline, `npm test`)

Use a fake router, provider, searcher, and reranker. Never load real models in tests.

- **Router output:** parsed correctly. A missing or invalid intent and an open question
  each force search.
- **Non-search intents:** `chat` and `memory_only` never call search or the answering
  model.
- **Memory patches:** applied correctly. An unknown op or id is skipped. Nothing
  disappears without a `remove`.
- **History window:** bounded to `RAG_HISTORY_TURNS`, and earlier assistant messages are
  shortened with citations stripped.
- **Clarification loop:** "I don't know" adds an open question; the next message is
  routed to search and resolves the question.
- **Rerank input:** uses `standalone_question`, not the raw message.
- **Scenario files:** validate against the schema, with 12–15 messages each and all
  required elements present.

## Docs

Update `first-agent/README.md` with the per-turn flow, task memory, the new env vars
(`RAG_ROUTER_MODEL`, `RAG_HISTORY_TURNS`), and `eval:chat`. Add the Day 25 line to the
root README.

## Done when

1. In the UI, a multi-turn chat shows intent badges, a task memory that updates turn by
   turn, and cited answers on every search turn. A clarification resolves an earlier
   "I don't know".
2. `npm run eval:chat` runs both scenarios and writes the report with real numbers and
   findings.
3. `npm test` passes offline in `first-agent` and `doc_index`.
4. The Chat tab on `http://localhost:3000/rag-report` shows both timelines.

Run all four yourself and fix what fails. Leave the `first-agent` server running on
port 3000 (if the port is taken, say so instead of switching ports), and check that `/`
and `/rag-report` respond. In the final message, include the summary per scenario,
every failing turn with its reason, and the two URLs.
