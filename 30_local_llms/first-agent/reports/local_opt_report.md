# Optimizing qwen3.5:9b for the Knowledge RAG chat (Day 29)

Generated 2026-10-11T20:30:29.342Z by `npm run opt:local` on Apple M2, 16 GB RAM, Ollama 0.40.2. Raw results: [`local_opt_results.json`](local_opt_results.json). Findings: [`local_opt_notes.md`](local_opt_notes.md).

Three variants of the same model, run in this order with a cooldown between them, each on the 10 `citations` questions (`eval:local`, from Day 28's cached retrieval, so every variant answers from the same chunks; judged by Claude) and then on the Knowledge RAG conversation of `verify:local` (fully local, live retrieval):

| variant | num_ctx (all calls) | prompts |
| --- | --- | --- |
| `baseline` | 16384 RAG / 8192 plain | v1 |
| `ctx8k` | 8192 | v1 |
| `ctx8k+prompt` | 8192 | v2 |

Claude Haiku 4.5's column is Day 28's run (2026-10-11T15:35:50.279Z), not re-run: a reference only.

## Decision

**Adopted: `ctx8k`.**

- Experiment 1, `ctx8k`: **adopted**.
- Experiment 2, `ctx8k+prompt`: **not adopted** — failed: no new false "I don't know"; verify:local's memory check passes.

| rule | result | ✓ |
| --- | --- | --- |
| ctx8k: 0 possible truncations (eval + verify:local) | 0 | ✓ |
| ctx8k: answered with a valid citation: not worse by more than one question | 5 → 5 | ✓ |
| ctx8k: answerable questions answered: not worse by more than one question | 5 → 5 | ✓ |
| ctx8k: fabricated quotes on the first attempt: not worse by more than one question | 1 → 1 | ✓ |
| ctx8k: retries: not worse by more than one question | 1 → 1 | ✓ |
| ctx8k: dropped citations: not worse by more than one question | 1 → 1 | ✓ |
| ctx8k: downgrades: not worse by more than one question | 0 → 0 | ✓ |
| ctx8k: unsupported claims (faithfulness): not worse by more than one question | 0 → 0 | ✓ |
| ctx8k: correct "I don't know": not worse by more than one question | 3 → 3 | ✓ |
| ctx8k: false "I don't know": not worse by more than one question | 2 → 2 | ✓ |
| ctx8k: fact score, summed over the 7 answerable: not worse by more than one question | 3.63 → 4.63 | ✓ |
| ctx8k+prompt: ctx8k is adopted (v2 runs on top of it) | yes | ✓ |
| ctx8k+prompt: mean fact score ≥ the baseline's | 0.52 → 0.54 | ✓ |
| ctx8k+prompt: no new false "I don't know" | new: q15 | ✗ |
| ctx8k+prompt: mean faithfulness doesn't drop | 0.53 → 0.81 | ✓ |
| ctx8k+prompt: verify:local's memory check passes | failed | ✗ |

Baseline against Day 28's qwen3.5:9b column: fact score 0.66 → 0.52 (-0.14, limit ±0.1), mean latency 28.9 s → 29.5 s (+2%, limit ±30%): **the setup changed**.

## Summary

| settings | baseline | ctx8k | ctx8k+prompt | Claude Haiku 4.5 (Day 28, reference) |
| --- | --- | --- | --- | --- |
| num_ctx: RAG calls · plain chat | 16384 · 8192 | 8192 · 8192 | 8192 · 8192 | n/a (cloud) |
| prompts | v1 | v1 | v2 | v1 |
| eval started (UTC) · verify:local started | 19:49:22 · 19:54:52 | 20:00:53 · 20:06:40 | 20:15:20 · 20:23:09 | 2026-10-11 |

| quality (eval:local, 10 questions) | baseline | ctx8k | ctx8k+prompt | Claude Haiku 4.5 (Day 28, reference) |
| --- | --- | --- | --- | --- |
| answered with ≥ 1 source / valid citation | 5/5 · 5/5 | 5/5 · 5/5 | 4/4 · 4/4 | 6/6 · 6/6 |
| answerable questions answered (of 7) | 5/7 | 5/7 | 4/7 | 6/7 |
| fabricated quotes on the first attempt | 1 of 13 | 1 of 13 | 2 of 15 | 2 of 15 |
| first attempt valid | 8/9 | 8/9 | 3/9 | 7/9 |
| retries · dropped citations · downgrades | 1 (0 fixed) · 1 · 0 | 1 (0 fixed) · 1 · 0 | 6 (3 fixed) · 4 · 2 | 2 (2 fixed) · 0 · 0 |
| invalid JSON / schema failures | 0 of 11 calls · 0 | 0 of 11 calls · 0 | 0 of 16 calls · 0 | n/a (tool use) |
| faithfulness (supported / partial / unsupported) | 0.53 · 6 / 4 / 0 | 0.53 · 6 / 4 / 0 | 0.81 · 9 / 3 / 0 | 0.86 · 14 / 3 / 0 |
| uncited claims | 0 | 0 | 0 | 9 |
| correct "I don't know" · false "I don't know" | 3/3 · q12, q14 | 3/3 · q12, q14 | 3/3 · q12, q14, q15 | 3/3 · q14 |
| mean fact score (7 answerable) | 0.52 | 0.66 | 0.54 | 0.76 |
| q06 (two lines in one quote on Day 28) | answered · facts 0.13 · retried, still invalid · 1 citation dropped | answered · facts 0.13 · retried, still invalid · 1 citation dropped | answered · facts 1.00 · retried → verified | answered · facts 1.00 · retried → verified |
| q12 (Web is Beta: false IDK on Day 28) | IDK (model) · facts 0.00 · verified | IDK (model) · facts 1.00 · verified | IDK (model) · facts 0.67 · verified | answered · facts 1.00 · verified |

| router / memory (verify:local) | baseline | ctx8k | ctx8k+prompt | Claude Haiku 4.5 (Day 28, reference) |
| --- | --- | --- | --- | --- |
| verify:local checks (RAG chat) | 19/21 · failed: turn 1: verifiedCitations, turn 3: usesMemory | 19/22 · failed: turn 1: verifiedCitations, turn 2: verifiedCitations, turn 3: usesMemory | 20/21 · failed: turn 3: usesMemory | n/a |
| turn 2 (rule + term): intent · memory patch | memory_only · add_constraint 1001-ans-max-3-sentences; add_clarified 1002-cmp-compose-multiplatform | search · (empty) | memory_only · add_constraint "answers at most 3 sentences"; add_constraint "'CMP' = Compose Multiplatform" | n/a |
| turn 3 uses the task memory (CMP) | no | no | no | n/a |

| speed | baseline | ctx8k | ctx8k+prompt | Claude Haiku 4.5 (Day 28, reference) |
| --- | --- | --- | --- | --- |
| time to first token (≈ prompt processing) | 15.4 s | 16.2 s | 16.1 s | 0.71 s |
| generation tokens/s | 15.7 | 15.1 | 15.4 | 129.3 |
| answer latency incl. retry: mean · max | 29.5 s · 52.4 s | 31.3 s · 51.9 s | 43.9 s · 80.9 s | 3.88 s · 7.95 s |
| prompt tokens · output tokens (mean per question) | 1966 · 227 | 1966 · 225 | 3251 · 395 | 3526 · 392 |
| verify:local chat turns 1 · 2 · 3 (router ms in turn) | 88.0 s (15.6 s) · 20.2 s (20.2 s) · 64.6 s (8.83 s) | 86.6 s (15.6 s) · 182.3 s (141.8 s) · 63.0 s (20.7 s) | 128.1 s (12.3 s) · 18.4 s (18.3 s) · 70.0 s (20.2 s) | n/a |

| resources | baseline | ctx8k | ctx8k+prompt | Claude Haiku 4.5 (Day 28, reference) |
| --- | --- | --- | --- | --- |
| memory after the eval (/api/ps: total · on GPU · ctx) | 10.1 GB · 10.1 GB · 16384 | 9.9 GB · 9.9 GB · 8192 | 11.4 GB · 11.4 GB · 8192 | n/a (cloud) |
| memory after verify:local (/api/ps) | 9.1 GB · 9.1 GB · 8192 | 9.2 GB · 9.2 GB · 8192 | 8.8 GB · 8.8 GB · 8192 | n/a (cloud) |
| model reloads (load > 1 s after the first request): eval · verify:local | 0 · 0 | 0 · 0 | 0 · 0 | n/a (cloud) |
| num_ctx seen on local calls: eval · verify:local | 16384 · 8192/16384 | 8192 · 8192 | 8192 · 8192 | n/a (cloud) |
| possible truncations: eval · verify:local | 0 · 0 | 0 · 0 | 0 · 0 | 0 |

TTFT: Ollama's load + prompt-evaluation time of the first answer call. Latency: the answer call with its retry, or the clarifying call, without the shared retrieval. A reload is a response whose `load_duration` is over 1 s after the first request of the run (the warm-up: at the RAG window for the eval, at the plain chat's window for verify:local, as opening the app would). Memory is `/api/ps` right after the run, before the model is unloaded.

## Per question

| id | type | baseline | ctx8k | ctx8k+prompt | Claude Haiku 4.5 (Day 28, reference) |
| --- | --- | --- | --- | --- | --- |
| q02 | corpus | answered · 5/5 · facts 0.50 · 35.9 s | answered · 5/5 · facts 0.50 · 35.5 s | answered · 5/5 · facts 0.33 · 62.9 s | answered · 5/5 · facts 0.33 · 3.44 s |
| q04 | corpus | answered · 4/5 · facts 1.00 · 42.2 s | answered · 4/5 · facts 1.00 · 41.7 s | answered · 5/5 · facts 1.00 · 65.9 s | answered · 5/5 · facts 1.00 · 7.95 s |
| q06 | corpus | answered · 3/5 · facts 0.13 · 52.4 s | answered · 3/5 · facts 0.13 · 51.9 s | answered · 5/5 · facts 1.00 · 57.5 s | answered · 4/5 · facts 1.00 · 6.82 s |
| q10 | unanswerable | IDK (model) · 1/1 · 20.9 s | IDK (model) · 1/1 · 20.9 s | IDK (model) · 1/1 · 19.6 s | IDK (model) · 1/1 · 1.68 s |
| q12 | near_miss | IDK (model) · 0/3 · facts 0.00 · 23.0 s | IDK (model) · 0/3 · facts 1.00 · 21.9 s | IDK (model) · 0/3 · facts 0.67 · 21.5 s | answered · 4/5 · facts 1.00 · 4.68 s |
| q13 | off_topic | IDK (low_relevance) · 1/1 · 8.05 s | IDK (low_relevance) · 1/1 · 8.11 s | IDK (low_relevance) · 1/1 · 8.84 s | IDK (low_relevance) · 1/1 · 1.13 s |
| q14 | paraphrased | IDK (model) · 0/3 · facts 0.00 · 11.4 s | IDK (model) · 0/3 · facts 0.00 · 11.6 s | IDK (model) · 0/3 · facts 0.00 · 13.1 s | IDK (model) · 0/3 · facts 0.00 · 1.42 s |
| q15 | messy | answered · 5/5 · facts 1.00 · 25.0 s | answered · 5/5 · facts 1.00 · 25.4 s | IDK (verification_failed) · 1/4 · facts 0.00 · 46.6 s | answered · 5/5 · facts 1.00 · 4.44 s |
| q16 | multi_part | answered · 4/5 · facts 1.00 · 35.9 s | answered · 4/5 · facts 1.00 · 48.7 s | answered · 4/5 · facts 0.75 · 80.9 s | answered · 4/5 · facts 1.00 · 5.40 s |
| q17 | ambiguous | IDK (model) · 1/1 · 40.2 s | IDK (model) · 1/1 · 47.1 s | IDK (verification_failed) · 1/2 · 61.9 s | IDK (model) · 1/1 · 1.86 s |

Cells: status · checks passed · fact score (answerable questions) · answer latency.

## verify:local, turn by turn

### baseline

FAIL · 19/21 checks · outbound non-localhost 0 · Claude calls 0 · reloads 0

**1.** We're deciding whether to build our iOS app's UI with Compose Multiplatform instead of SwiftUI. To start: is Compose Multiplatform for iOS actually stable now?

Router: **search** · patch (empty) · 15.6 s · turn 88.0 s · answered · 1 citation(s) · retried · ✗ verifiedCitations

> Yes, Compose Multiplatform for iOS is now stable and production-ready. The release of version 1.8.0 marks a major milestone where Compose for iOS reached stability status [c2].

**2.** From now on, keep every answer to at most 3 sentences. And when I write CMP, I mean Compose Multiplatform.

Router: **memory_only** · patch add_constraint 1001-ans-max-3-sentences; add_clarified 1002-cmp-compose-multiplatform · 20.2 s · turn 20.2 s · ✓

> Got it. I'll keep answers to at most 3 sentences and treat 'CMP' as Compose Multiplatform.

**3.** How much does CMP add to the app size compared with a pure SwiftUI app?

Router: **search** · patch (empty) · 8.83 s · turn 64.6 s · answered · 1 citation(s) · verified · ✗ usesMemory

> Compose Multiplatform adds about ~9 MB to the size of an iOS app compared to a fully native SwiftUI app [c1].

### ctx8k

FAIL · 19/22 checks · outbound non-localhost 0 · Claude calls 0 · reloads 0

**1.** We're deciding whether to build our iOS app's UI with Compose Multiplatform instead of SwiftUI. To start: is Compose Multiplatform for iOS actually stable now?

Router: **search** · patch (empty) · 15.6 s · turn 86.6 s · answered · 1 citation(s) · retried · ✗ verifiedCitations

> Yes, Compose Multiplatform for iOS is now stable and production-ready. The release of version 1.8.0 marks a major milestone where Compose for iOS reached stability status [c2].

**2.** From now on, keep every answer to at most 3 sentences. And when I write CMP, I mean Compose Multiplatform.

Router: **search** (invalid JSON → search) · patch (empty) · 141.8 s · turn 182.3 s · dont_know · 0 citation(s) · verified · ✗ verifiedCitations

> I don't know. The documents confirm that Compose Multiplatform for iOS is stable and production-ready as of version 1.8.0, but they do not contain information about the specific term 'CMP' or any constraints on answer length. Would you like me to focus only on the stability status of Compose Multiplatform for iOS?

**3.** How much does CMP add to the app size compared with a pure SwiftUI app?

Router: **search** · patch (empty) · 20.7 s · turn 63.0 s · answered · 1 citation(s) · verified · ✗ usesMemory

> Compose Multiplatform adds about 9 MB to an iOS app compared to a fully native SwiftUI app with the same UI logic and assets [c1].

### ctx8k+prompt

FAIL · 20/21 checks · outbound non-localhost 0 · Claude calls 0 · reloads 0

**1.** We're deciding whether to build our iOS app's UI with Compose Multiplatform instead of SwiftUI. To start: is Compose Multiplatform for iOS actually stable now?

Router: **search** · patch (empty) · 12.3 s · turn 128.1 s · answered · 5 citation(s) · retried · ✓

> Compose Multiplatform for iOS is now stable and production-ready, as confirmed by the release of version 1.8.0 [c2]. This version brings Compose for iOS to Stable, making Kotlin Multiplatform a complete solution for mobile development [c2]. The ecosystem is thriving with tools ready for adoption, and many teams are already integrating it into large-scale apps [c1][c3]. Version 1.8.0 finalizes the core API surface and brings targeted improvements to accessibility and navigation, along with a wide range of bug fixes and performance improvements [c3]. Additionally, version 1.7.0 paired with Kotlin 2.0.20 performs significantly faster and smoother on iOS than previous releases [c4]. Compose for iOS is also stabilized in Kotlin 2.3 with performance improvements that make it usable, including 60fps animations on older iPhones [c5].

**2.** From now on, keep every answer to at most 3 sentences. And when I write CMP, I mean Compose Multiplatform.

Router: **memory_only** · patch add_constraint "answers at most 3 sentences"; add_constraint "'CMP' = Compose Multiplatform" · 18.3 s · turn 18.4 s · ✓

> Got it.

**3.** How much does CMP add to the app size compared with a pure SwiftUI app?

Router: **search** · patch set_goal "compare app size impact of Compose Multiplatform vs SwiftUI"; add_clarified "the user is evaluating building an iOS app with Compose Multiplatform instead of SwiftUI" · 20.2 s · turn 70.0 s · answered · 2 citation(s) · verified · ✗ usesMemory

> CMP adds only about 9 MB to the app size compared to a fully native SwiftUI app [c1]. This increase applies when using the same UI logic and assets in both approaches [c2].

## Prompts: v1 vs v2

Token counts are qwen3.5:9b's own (Ollama's `prompt_eval_count` with the prompt as the system message, minus the same call without it). Characters are what `npm test` checks offline.

| prompt | v1 tokens | v2 tokens | v1 chars | v2 chars |
| --- | ---: | ---: | ---: | ---: |
| contract prompt (`submit_answer`, eval:local) | 344 | 354 | 1425 | 1417 |
| contract prompt + chat rules (the chat's answer call) | 606 | 616 | 2599 | 2591 |
| router prompt (`route`) | 907 | 682 | 4016 | 2928 |

### contract prompt (`submit_answer`, eval:local)

```diff
 You are a helpful, precise assistant. Answer the user's question clearly and concisely, in plain language. Use Markdown when it makes the answer easier to read.
 
-The user's message contains documents inside <documents>, each with a chunk_id, followed by the question.
+The user's message holds documents in <documents>, each with a chunk_id, then the question.
 Answer by calling submit_answer exactly once. Rules:
-- Use only these documents. Do not add facts from general knowledge.
-- Put a citation marker like [c1] at the end of every sentence that makes a factual claim, just before its final punctuation:
-  'It adds about 9 MB to an iOS app [c2].' or, for two sources, '… [c1][c2].' Never put a marker at the start of a sentence,
-  after a heading, label or colon, or around a phrase: the marker belongs to the sentence it ends.
-- Each marker has one entry in citations: its id, the chunk_id of the document (copied exactly), and a quote copied verbatim from that document —
-  one or two whole sentences, 4–60 words, the part that actually supports the claim. Do not reword, shorten, join or add '...' to a quote.
-- Every citation is used in the answer.
-- If the documents cover only part of the question, answer that part with citations and say what is missing.
-- If the documents do not contain the answer, set status to dont_know, leave answer and citations empty, and write a short clarifying_question
-  (it may name what the documents do cover nearby). Do not stretch loosely related text to fit the question.
+- Use only these documents, no outside knowledge.
+- End every sentence with a factual claim with its marker, before the final period: '… about 9 MB [c2].' or '… [c1][c2].'
+  Never at the start of a sentence, after a colon or around a phrase.
+- Each marker has one citation: its id, the chunk_id (copied exactly) and a verbatim quote from that document, 4–60 words. Every citation is used.
+- One line, one quote: never reword, shorten or join lines. The lines
+  The new API works on every platform.
+  Older versions are no longer supported.
+  of a chunk are two quotes, c1 the first line and c2 the second: 'It works everywhere [c1]. Old ones are gone [c2].'
+- A qualified answer is still an answer: if the documents say something is Beta but usable in production by early adopters, answer that and cite it; don't decline.
+- If the documents cover only part of it, answer that part and say what is missing.
+- If they don't contain the answer, set status dont_know with empty answer and citations and a short clarifying_question
+  (it may name what they cover nearby). Do not stretch loosely related text to fit.
```

### router prompt (`route`)

```diff
 You route messages in a chat about a document index of Kotlin, Kotlin Multiplatform and Compose Multiplatform articles (release posts, blog articles).
 For each new user message, call route exactly once.
 
 Intent:
-- search: anything that asks about content, including follow-ups like "why?", "tell me more", "and the second one?", and questions on other topics (the search decides whether the documents cover them).
-- memory_only: the message only sets a constraint, a correction, a preference, or defines a term, and asks nothing.
+- search: anything that asks about content, including follow-ups ("why?", "and the second one?") and questions on any other topic: the search decides, and the user gets an honest "I don't know". Never answer a question yourself in reply.
+- memory_only: the message only sets a constraint, a correction, a preference or defines a term, and asks nothing.
 - chat: greetings, thanks and acknowledgements, with no question.
-- Any question is search, even one clearly outside Kotlin (cooking, travel, …) or introduced with "unrelated": the search finds nothing and the user gets an honest "I don't know". Never answer a question yourself in reply.
-- A message that mixes several kinds (e.g. a new goal or constraint plus a question) is search.
-- A reply to an open clarifying question (listed in the task memory) is search, and standalone_question is the original question with the clarification applied.
-- When unsure, choose search.
+- A message that mixes kinds (e.g. a constraint plus a question) is search. When unsure, choose search.
+- A reply to an open clarifying question (in the task memory) is search, and standalone_question is the original question with the clarification applied.
 
 For search:
-- standalone_question: the full question, understandable on its own. Resolve pronouns and references ("it", "that", "the other one", "before that") from the recent messages and the task memory, and apply the user's defined terms (write the full name, not the abbreviation).
-- queries: 1–3 short search queries, one per distinct information need. Each is standalone: one sentence or a keyword phrase, no filler.
-  Use the terms the documents would use (product names, version numbers, feature names); keep version numbers and names the user gave.
-  When the user asks what a named article says, describe the content in words its paragraphs would use (e.g. "should you upgrade now, required Gradle version"),
-  not the article's title: a title only matches the article's first chunk.
-  Queries contain the resolved subject and any clarified terms. They do NOT repeat the goal or the constraints (no "in at most 3 sentences", no "for our decision").
+- standalone_question: the full question, understandable on its own. Resolve references ("it", "the other one") from the recent messages and the task memory, and write defined terms in full.
+- queries: 1–3 short standalone queries, one per information need, in the documents' terms (product names, versions, feature names).
+  For a named article, describe its content in words its paragraphs would use, not its title. Never repeat the goal or constraints in a query.
 - reply: empty.
 
-For chat and memory_only: reply is a short, friendly sentence (acknowledge the constraint or term, or answer the greeting). Do not answer content questions here.
+For chat and memory_only: reply is one short, friendly sentence acknowledging the rule, term or greeting.
 
-Task memory (memory_patch): it holds only the user's goal, the details they clarified, and the constraints and terms they set. Operations:
-- set_goal {text}: when the user states what they are trying to achieve, or changes direction. One sentence, in the user's terms.
-- add_clarified {text}: a detail the user clarified about their situation or what they mean (e.g. "the team ships to Android and iOS", "by migration they mean gradual adoption").
-- add_constraint {text}: a rule or term the user set (e.g. "answers at most 3 sentences", "'CMP' = Compose Multiplatform").
-- remove {id}: an item that no longer applies.
-- resolve_question {id}: an open question the user has now answered — or has dropped by moving on to something else.
-Rules:
-- Every open question gets resolve_question unless the message is chat: if the message answers it, resolve it (and apply the clarification);
-  if the message asks something else, sets a constraint or corrects something, the user has dropped it — resolve it too. An open question never stays open past a non-chat message.
-- A correction replaces the item it corrects: remove the old id and add the new text.
-- When the user changes direction, set the new goal and remove the clarified details and terms that only applied to the old focus
-  (e.g. names they gave to the articles of the old topic). Keep general constraints (like answer length) and facts about the user themselves (their team, platforms) unless they drop them.
-- Never store what the documents or the assistant said. Never store the question itself. Only the user's goal, clarifications and constraints.
-- Do not add an item that is already in the memory. Use only ids that exist in the memory.
-- Most messages need no operations: an empty memory_patch is normal.
+Task memory (memory_patch) holds only the user's goal, the details they clarified, and the constraints and terms they set. Operations:
+- set_goal {text}: what the user is trying to achieve, in their terms.
+- add_clarified {text}: a detail about their situation or what they mean.
+- add_constraint {text}: a rule or term they set.
+- remove {id}: an item that no longer applies. A correction removes the old id and adds the new text.
+- resolve_question {id}: an open question the user answered, or dropped by sending any non-chat message. None stays open past a non-chat message.
+- On a change of direction, set the new goal and remove clarified details and terms tied to the old focus; keep general constraints and facts about the user.
+- Never store what the documents or the assistant said, or the question itself. No duplicates; only ids that exist.
+
+A memory_only message always has at least one operation. Examples:
+User: From now on, answer in at most 2 sentences. By KMP I mean Kotlin Multiplatform.
+→ {"intent":"memory_only","reply":"Got it.","memory_patch":[{"op":"add_constraint","text":"answers at most 2 sentences"},{"op":"add_constraint","text":"'KMP' = Kotlin Multiplatform"}]}
+User (memory has [k3] the team ships to Android and iOS): Correction, we only ship to Android.
+→ {"intent":"memory_only","reply":"Noted.","memory_patch":[{"op":"remove","id":"k3"},{"op":"add_clarified","text":"the team ships to Android only"}]}
```

## Findings

# Day 29 notes: optimizing qwen3.5:9b

Run of 2026-10-11 (19:49–20:28 UTC), Apple M2 16 GB, Ollama 0.40.2 (MLX runner), qwen3.5:9b
nvfp4. Numbers: [`local_opt_report.md`](local_opt_report.md).

## Decision

**`ctx8k` adopted, `ctx8k+prompt` not.** `LOCAL_RAG_NUM_CTX` now defaults to 8192, the same as
`LOCAL_NUM_CTX`; prompts stay v1 (`LOCAL_PROMPT_VARIANT=v2` remains available, off by default).

## Findings

- **The baseline is Day 28, but the judge isn't.** The drift check stopped `opt:local` twice
  (fact score 0.66 → 0.52, limit ±0.1; latency +2%). The whole gap is q12: qwen gives the same
  false "I don't know" as on Day 28, which Day 28's Haiku judge graded 1.00 (the declined
  answer mentions all three facts) and today's grades 0.00 (twice). One question is 1/7 = 0.14.
  The other six answerable questions score the same. The variants ran with `--force`. The same
  noise shows inside today's run: ctx8k's q12 is again an "I don't know" and gets 1.00, which is
  all of ctx8k's 0.66 vs 0.52. **The fact score moves by a question's worth on judge noise
  alone; read it together with answered / false IDK, which don't.**
- **ctx8k is free, not faster.** Same answers on all 10 questions as the baseline (same status,
  checks, citations, fabricated, retries, dropped), 0 possible truncations (largest prompt
  ≈ 3.1k tokens against 8192). Speed is within noise: TTFT 16.2 s vs 15.4 s, 15.1 vs 15.7 tok/s,
  latency 31.3 s vs 29.5 s. Memory after the eval is 9.9 GB vs 10.1 GB: qwen3.5's cache is small,
  so halving the window saves only ~0.2 GB in `/api/ps` (it would matter more on gemma4:12b,
  15.2 GB at 16k on Day 28).
- **No reloads to save.** Day 28's README expected a model reload whenever `num_ctx` changes
  (plain chat 8192 ↔ RAG 16384). On this Ollama it didn't happen: the baseline's verify:local
  went from an 8192 warm-up to 16384 calls with `load_duration` 14 ms. 0 reloads in every
  variant. The single 8k window is a simplification, not a speed-up.
- **v2's contract prompt made qwen worse.** First attempts valid fell from 8/9 to 3/9, retries
  from 1 to 6, dropped citations 1 → 4, two downgrades, and q15 (answered on v1) became a
  verification-failed "I don't know": a new false IDK, which fails the rule. Latency went up
  49% (43.9 s mean, 80.9 s max) from the retries and longer answers (395 vs 225 output tokens).
  The worked example did its narrow job — q06, the two-line quote qwen couldn't repair on Day
  28, verified with facts 1.00 — but q12 is still an "I don't know": the "a qualified answer is
  still an answer" line didn't move it. Faithfulness rose (0.53 → 0.81), mostly because the
  answers that survived carry more, verified, citations.
- **v2's router is the only one that wrote the task memory.** Turn 2 ("at most 3 sentences;
  CMP = Compose Multiplatform") is where the router has to emit a `memory_patch`:
  - baseline (v1): routed memory_only, but its two operations had an `id` and no `text`, so
    `applyMemoryPatch` applied none — the memory stayed empty;
  - ctx8k (v1): invalid JSON after 141.8 s → fell back to search → an "I don't know" about CMP;
  - ctx8k+prompt (v2): memory_only with two valid `add_constraint`s, applied.
  Still, `usesMemory` failed on turn 3 in all three: v1 expanded CMP from the history, not the
  memory, and v2 stored the term as a constraint and left "CMP" in the standalone question. The
  v1 router failed turn 2 in both runs, just differently (16384 vs 8192, with its prompt far
  below either window): at temperature 1 that reads as noise rather than a ctx8k effect, but one
  run each can't prove it.
- **The router prompt shrank, the contract prompt didn't.** qwen tokens: router 907 → 682
  (−25%), contract 344 → 354 (+10, same characters: the examples tokenize worse than the
  prose they replaced). The router is a short call, so the saving is ~1 s of prompt reading.
- **verify:local is FAIL in every variant,** as it was on Day 28: always `usesMemory` on turn 3,
  plus `verifiedCitations` on turn 1 for v1 (a retried citation). 0 non-localhost requests and 0
  Claude calls in all three.

## Not tried

- **Quantization.** qwen3.5:9b ships as nvfp4 (~7.6 GB on disk, 9.65B params) on the MLX
  runner. A q8 build would be ~10–11 GB of weights, before the KV cache and runtime, while the
  Node process holds bge-reranker-v2-m3 (q8 ONNX, ~0.6 GB) and EmbeddingGemma (~0.3 GB) and
  macOS keeps its share: above 16 GB and Metal's wired-memory limit, so it would swap or refuse
  to load. A smaller quant (q4_K_M on the llama.cpp runner) saves little against nvfp4 and
  would lose the MLX speed. Not worth a run on this machine.
- **Fewer chunks.** The answer prompt is ~2k tokens and TTFT (15 s) is mostly reading it.
  Passing 3 chunks instead of 5 would cut that by roughly a third, but it changes retrieval,
  which this experiment held fixed (one cached retrieval for every variant), and multi-part
  questions like q16 need more than one or two chunks.
- **Temperature 0.** qwen's Modelfile sets temperature 1, top_k 20, top_p 0.95, and
  **presence_penalty 1.5**, and our client sends none of them, so they apply to every call.
  Temperature 0 would make runs repeatable (the v1 router's turn 2 failed two different ways
  in two runs). presence_penalty 1.5 penalizes reusing tokens already in the
  context, which is exactly what a verbatim quote does; it may explain qwen's joined or
  shortened quotes and the retries. Both are one `options` field away; the next experiment.
