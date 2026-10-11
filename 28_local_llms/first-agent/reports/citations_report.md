# Citations eval: 10 questions, `rag+rerank`

Generated 2026-10-04T16:58:02.054Z by `npm run eval:citations`. Answer model `claude-haiku-4-5-20251001` through the forced `submit_answer` contract (temperature 0),
verified in code, one retry with the errors. Judges `claude-haiku-4-5-20251001`: the faithfulness judge (claims + the quotes they cite, nothing else) and Day 22's fact judge.
Rerank cutoff 0.02; k_final 5, k_retrieve 20. Raw results: [`citations_results.json`](citations_results.json).

## Summary

| | |
| --- | --- |
| answered with ≥ 1 source | 100% (6/6) |
| answered with ≥ 1 valid citation | 100% (6/6) |
| answerable questions answered with sources | 86% (6/7) |
| fabricated quotes on the first attempt | 2 of 15 quotes |
| first attempt valid | 7/9 answer calls |
| retries (fixed by the retry) | 2 (2) |
| citations dropped after the retry | 0 |
| downgraded to "I don't know" | 0 |
| mean faithfulness (supported / cited claims) | 0.86 · 14 supported, 3 partial, 0 unsupported of 17 |
| uncited factual claims | 8 |
| correct "I don't know" | 3/3 |
| false "I don't know" (answerable) | 1: q14 (model) |
| missed "I don't know" (answered instead) | 0 |
| mean fact score (7 answerable, Day 22 judge) | 0.76 |
| checks passed | has sources 6/7 · has citations 6/7 · quotes are real 5/6 · meaning matches citations 4/6 · correct "I don't know" 9/10 |
| mean latency · input / output tokens | 7.6 s · 3526 / 392 |

## Per question

| id | type | status | has sources | has citations | quotes are real | meaning matches citations | correct "I don't know" | faithfulness | fact score | verification |
| --- | --- | --- | :---: | :---: | :---: | :---: | :---: | ---: | ---: | --- |
| [q02](#q02) | corpus | answered | ✓ | ✓ | ✓ | ✓ | ✓ | 1.00 | 0.33 | verified |
| [q04](#q04) | corpus | answered | ✓ | ✓ | ✓ | ✓ | ✓ | 1.00 | 1.00 | retried → verified |
| [q06](#q06) | corpus | answered | ✓ | ✓ | ✗ | ✓ | ✓ | 1.00 | 1.00 | retried → verified |
| [q10](#q10) | unanswerable | dont_know (model) | — | — | — | — | ✓ | — | — | verified |
| [q12](#q12) | near_miss | answered | ✓ | ✓ | ✓ | ✗ | ✓ | 0.67 | 1.00 | verified |
| [q13](#q13) | off_topic | dont_know (low_relevance) | — | — | — | — | ✓ | — | — | low relevance (no answer call) |
| [q14](#q14) | paraphrased | dont_know (model) | ✗ | ✗ | — | — | ✗ | — | 0.00 | verified |
| [q15](#q15) | messy | answered | ✓ | ✓ | ✓ | ✓ | ✓ | 1.00 | 1.00 | verified |
| [q16](#q16) | multi_part | answered | ✓ | ✓ | ✓ | ✗ | ✓ | 0.50 | 1.00 | verified |
| [q17](#q17) | ambiguous | dont_know (model) | — | — | — | — | ✓ | — | — | verified |

## Findings

These findings come from the run in this report: 10 questions in `rag+rerank`, with Haiku 4.5 answering and judging. Where it says **run 1**, that's the run before one prompt change (see "Marker placement").

**Quotes are almost always copied, and the retry fixes the rest.** On the first attempt, 2 of 15 quotes were not found in their chunk. Both were in q06, and neither was invented. The model had reformatted real text. It joined two bullet lines into one sentence with an added period ("…`-Xcontext-parameters`. Try context-sensitive…"). It also turned a code block (`// gradle.properties` / `kotlin.native.binary.latin1Strings=true` / `// Strings with Latin-1…`) into prose. A third first-attempt error was q04's quote at 62 words (rule 5). 7 of the 9 answer calls passed verification on the first try. Both retries passed on their second attempt, so this run dropped no citations and downgraded nothing. In run 1, the retry fixed only 1 of 2. On q04's retry, the model split one source sentence into two ("The agent can verify the results of its own edits. It can confirm…"). That still failed, so the citation was dropped, and the rest of the answer stood. No quote across either run was a paraphrase of meaning. Every miss was punctuation or line structure, which is the kind of change the normaliser deliberately does not forgive.

**No claim was unsupported. The 3 partials are version numbers and one interpretation.** Of the 17 cited claims, 14 were supported, 3 partial and 0 unsupported, for a mean faithfulness of 0.86. Two partials are q16's "added in Compose Multiplatform 1.7.0" and "introduced in 1.10.0". The version is in the post's title, not in the sentence quoted, so the quote can't carry it. The fact judge still scores q16 at 1.00, so the claim is right but can't be quoted. The third partial is q12's "not yet fully production-ready". That's the model's reading of "one step closer to providing a polished, production-ready experience".

**Marker placement was the biggest problem, and it's only partly fixed.** In run 1, the model often put markers at the start of a sentence (`actions: [c2] Using the MCP server…`) or around a phrase (`[c1]Compose Multiplatform 1.7.0[c1]`). The claim splitter then paired each marker with the wrong sentence. Faithfulness was 0.69 (10 supported, 5 partial) with 7 uncited claims. In run 1's q04, the sentence that relied on the dropped citation stayed in the answer, because its marker belonged to the sentence before. One rule fixed most of this: put the marker at the end of the sentence, just before its punctuation, never after a colon, with an example. Faithfulness rose to 0.86. Haiku still puts a few markers after a colon. That causes most of the 8 uncited claims. In q15, `[c1]` closes "your coworker is wrong!" and leaves "Kotlin 2.4 has a stable UUID type available in common code" unmarked (4 uncited). In q04, the MCP-server sentence ends up unmarked. The others are summary sentences (q12, q16) and an intro line (q06). Code doesn't check marker placement yet. It would be the natural sixth rule.

**The "I don't know" rule fired correctly on all 3 questions that should decline, through both paths:**

- **q13 (off-topic)** took the low-relevance path. The best rerank score was 0.0008, and the 3 best rejected chunks were all source files. One clarifying call (1,130 input tokens, no answering call) asked whether the user meant a Kotlin or Compose topic.
- **q10 (unanswerable, 1.9.0)** passed the cutoff, because the 1.8.0 post scored 0.73. The model then returned `dont_know` and named what is covered: "The documents cover Compose Multiplatform versions 1.7.0 and 1.8.0…". That's the "did you mean X" form the spec asks for.
- **q17 (ambiguous, "How does it work?")** also passed the cutoff, at 0.22, but on first-agent's own source code (`comparison.js`, `runner.js`, `taskState.js`). The model correctly said `dont_know`. Its clarifying question, though, offers "comparison profiles, pipeline runs, task state transitions…", which are this repo's code and not the Kotlin articles. The question has the right form, but the topics it offers come from whatever a vague query retrieves.

**There was one false IDK: q14 (paraphrased), and it's a retrieval miss.** As on Day 23, the cross-encoder scores the paraphrased drag-and-drop question low. Only 2 chunks passed: the 1.7.0 post's intro at 0.055 and a Shipaton chunk at 0.030. The section that answers it wasn't among them, so `dont_know` was the honest reply to what the model was given. Its clarifying question is clumsy: it asks the user whether the documents discuss drag-and-drop. Under the Day 22 baseline (`rag`, no rerank) this question scored 1.00.

**Correctness held, except on one terse answer.** The mean fact score on the 7 answerable questions is 0.76. Day 23's `rag+rerank` scored 0.79 on the same 7. q06 went up (1.00 vs 0.88), and q14 is 0 in both. q02 went down (0.33 vs 0.67). Its answer cites "Compose Multiplatform 1.8.0, which brings Compose for iOS to Stable" but writes only "is production-ready", dropping the version. It also leaves out the 96% survey figure. The contract pushes the model to say only what it is quoting, and here it quoted less than it could have.

**The cost is real.** A question averages 3,526 input and 392 output tokens and 7.6 s. On Day 23, `rag+rerank` averaged 1,338 / 157 / 5.5 s on the same questions. The cost comes from the tool schema, the longer rules, a `chunk_id` on every document (and in every citation), the quotes, and the retries: q04 and q06 each cost about 6,000–6,900 input tokens because the first attempt is sent again.

## q02

**corpus** — Is Compose Multiplatform for iOS production-ready yet, and how much does it add to app size compared with a pure SwiftUI app?

Status: **answered** · verification: verified · checks 5/5

> Yes, Compose Multiplatform for iOS is production-ready. [c1] Compose Multiplatform adds only ~9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets. [c2]

Sources:

1. Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:0`
2. Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Performance that’s ready for production · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:3`

Citations:

- **[c1]** "the release of Compose Multiplatform 1.8.0, which brings Compose for iOS to Stable" — Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog
- **[c2]** "Compose Multiplatform adds only ~9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets." — Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Performance that’s ready for production

Faithfulness 1.00:

| claim | verdict | quotes cited | note |
| --- | --- | --- | --- |
| Yes, Compose Multiplatform for iOS is production-ready. | supported | [c1] "the release of Compose Multiplatform 1.8.0, which brings Compose for iOS to Stable" | The quote states Compose for iOS reached Stable status with version 1.8.0, confirming production-readiness. |
| Compose Multiplatform adds only ~9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets. | supported | [c2] "Compose Multiplatform adds only ~9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets." | The quote directly states the exact claim about the ~9 MB size addition. |

Fact score 0.33: missing — Compose Multiplatform 1.8.0 made Compose for iOS Stable; present — It adds only about 9 MB to an iOS app compared with a native SwiftUI app; missing — Over 96% of teams using it on iOS report no major performance concerns

## q04

**corpus** — Can an AI coding agent work with my running Compose app through hot reload? What exactly can it do there?

Status: **answered** · verification: retried → verified · checks 5/5

> Yes, an AI coding agent can work with your running Compose app through hot reload. [c1] Compose Hot Reload now ships with an experimental Model Context Protocol (MCP) server that connects AI coding agents to your running application.
> 
> Here's what the agent can do:
> 
> [c2] Using the MCP server, an agent can trigger reloads, take screenshots, inspect the semantic tree, simulate clicks and text input, and read application logs. [c3] The agent can verify the results of its own edits, confirm that the reload succeeded, inspect the rendered UI, catch a runtime exception, and iterate – all without you describing what's on screen.

Sources:

1. Compose Multiplatform 1.12.0 Released - The JetBrains Blog › MCP server for AI agents in Compose Hot Reload · `kb/compose-multiplatform-1.12.0-released-the-jetbrains-blog.html:structural:1`

Citations:

- **[c1]** "Compose Hot Reload now ships with an experimental Model Context Protocol (MCP) server that connects AI coding agents to your running application." — Compose Multiplatform 1.12.0 Released - The JetBrains Blog › MCP server for AI agents in Compose Hot Reload
- **[c2]** "Using the MCP server, an agent can trigger reloads, take screenshots, inspect the semantic tree, simulate clicks and text input, and read application logs." — Compose Multiplatform 1.12.0 Released - The JetBrains Blog › MCP server for AI agents in Compose Hot Reload
- **[c3]** "It can confirm that the reload succeeded, inspect the rendered UI, catch a runtime exception, and iterate – all without you describing what's on screen." — Compose Multiplatform 1.12.0 Released - The JetBrains Blog › MCP server for AI agents in Compose Hot Reload

First-attempt errors:

- Rule 5: citation c2's quote is 62 words; it must be 4–60 (one or two whole sentences).

Faithfulness 1.00:

| claim | verdict | quotes cited | note |
| --- | --- | --- | --- |
| Yes, an AI coding agent can work with your running Compose app through hot reload. | supported | [c1] "Compose Hot Reload now ships with an experimental Model Context Protocol (MCP) server that connects AI coding agents to your running application." |  |
| Using the MCP server, an agent can trigger reloads, take screenshots, inspect the semantic tree, simulate clicks and text input, and read application logs. | supported | [c2] "Using the MCP server, an agent can trigger reloads, take screenshots, inspect the semantic tree, simulate clicks and text input, and read application logs."<br>[c3] "It can confirm that the reload succeeded, inspect the rendered UI, catch a runtime exception, and iterate – all without you describing what's on screen." |  |

Uncited claims:

- Compose Hot Reload now ships with an experimental Model Context Protocol (MCP) server that connects AI coding agents to your running application.

Fact score 1.00: present — Compose Hot Reload ships an experimental MCP (Model Context Protocol) server for AI agents; present — The agent can trigger reloads and take screenshots; present — It can inspect the semantic tree and simulate clicks and text input; present — It can read the application logs

## q06

**corpus** — Which compiler flags turn on context parameters and context-sensitive resolution in Kotlin 2.2.0, and is there a Kotlin/Native switch that reduces string memory?

Status: **answered** · verification: retried → verified · checks 4/5

> In Kotlin 2.2.0, the compiler flags for enabling these features are:
> 
> - **Context parameters**: `-Xcontext-parameters` [c1]
> - **Context-sensitive resolution**: `-Xcontext-sensitive-resolution` [c1]
> 
> For Kotlin/Native, there is a switch that reduces string memory: `kotlin.native.binary.latin1Strings=true` [c2]. When enabled, strings with Latin-1 characters use 50% less memory [c2].

Sources:

1. Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium › 🚀 Getting Started Today · `kb/kotlin-2.2.0-game-changing-features-that-will-transform-your-development-workflow-by-praveen-sharma-medium.html:structural:18`
2. Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium › 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements › Latin-1 String Optimization · `kb/kotlin-2.2.0-game-changing-features-that-will-transform-your-development-workflow-by-praveen-sharma-medium.html:structural:12`

Citations:

- **[c1]** "Enable context parameters with -Xcontext-parameters - Try context-sensitive resolution with -Xcontext-sensitive-resolution" — Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium › 🚀 Getting Started Today
- **[c2]** "// gradle.properties kotlin.native.binary.latin1Strings=true // Strings with Latin-1 characters now use 50% less memory" — Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium › 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements › Latin-1 String Optimization

First-attempt errors:

- Rule 4: citation c1's quote is not in chunk "kb/kotlin-2.2.0-game-changing-features-that-will-transform-your-development-workflow-by-praveen-sharma-medium.html:structural:18": "Enable context parameters with -Xcontext-parameters. Try context-sensitive resolution with -Xcontext-sensitive-resolution". Copy the sentence exactly as it appears in that document.
- Rule 4: citation c2's quote is not in chunk "kb/kotlin-2.2.0-game-changing-features-that-will-transform-your-development-workflow-by-praveen-sharma-medium.html:structural:12": "kotlin.native.binary.latin1Strings=true. Strings with Latin-1 characters now use 50% less memory". Copy the sentence exactly as it appears in that document.

Faithfulness 1.00:

| claim | verdict | quotes cited | note |
| --- | --- | --- | --- |
| Context parameters: `-Xcontext-parameters` | supported | [c1] "Enable context parameters with -Xcontext-parameters - Try context-sensitive resolution with -Xcontext-sensitive-resolution" |  |
| Context-sensitive resolution: `-Xcontext-sensitive-resolution` | supported | [c1] "Enable context parameters with -Xcontext-parameters - Try context-sensitive resolution with -Xcontext-sensitive-resolution" |  |
| For Kotlin/Native, there is a switch that reduces string memory: `kotlin.native.binary.latin1Strings=true`. | supported | [c2] "// gradle.properties kotlin.native.binary.latin1Strings=true // Strings with Latin-1 characters now use 50% less memory" |  |
| When enabled, strings with Latin-1 characters use 50% less memory. | supported | [c2] "// gradle.properties kotlin.native.binary.latin1Strings=true // Strings with Latin-1 characters now use 50% less memory" |  |

Uncited claims:

- In Kotlin 2.2.0, the compiler flags for enabling these features are:

Fact score 1.00: present — Context parameters are enabled with -Xcontext-parameters; present — Context-sensitive resolution is enabled with -Xcontext-sensitive-resolution; present — kotlin.native.binary.latin1Strings=true enables Latin-1 strings on Kotlin/Native; present — Latin-1 strings use about 50% less memory

## q10

**unanswerable** (should be "I don't know") — What were the headline features of Compose Multiplatform 1.9.0?

Status: **dont_know** (model) · verification: verified · checks 1/1

> I don't know. The documents cover Compose Multiplatform versions 1.7.0 and 1.8.0, but do not contain information about version 1.9.0. Do you have documents about Compose Multiplatform 1.9.0?

## q12

**near_miss** — Can I ship a Compose Multiplatform web app to production yet, or is the web target still experimental?

Status: **answered** · verification: verified · checks 4/5

> Compose Multiplatform for Web is not yet fully production-ready, but it is moving in that direction. [c1] Most essential APIs will be available in the Beta version, enabling early adopters to confidently move to production with the existing feature set. [c2] However, after the Beta release, JetBrains will continue working on remaining Compose APIs and further performance improvements. [c2]
> 
> So while you can experiment with web apps and some teams may be able to ship small- to medium-sized apps, the web target is currently in Beta rather than stable like the iOS target.

Sources:

1. Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Compose Multiplatform beyond mobile · `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:6`
2. What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog › Compose Multiplatform › Release Compose Multiplatform for Web in Beta · `kb/what-s-next-for-kotlin-multiplatform-and-compose-multiplatform-august-2025-update-the-jetbrains-blog.html:structural:2`

Citations:

- **[c1]** "These updates bring Compose Multiplatform for the web one step closer to providing a polished, production-ready experience." — Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog › Compose Multiplatform beyond mobile
- **[c2]** "Most essential APIs will be available, enabling early adopters to confidently move to production with the existing feature set. After this Beta release, we will keep working on the remaining Compose APIs and further performance improvements." — What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog › Compose Multiplatform › Release Compose Multiplatform for Web in Beta

Faithfulness 0.67:

| claim | verdict | quotes cited | note |
| --- | --- | --- | --- |
| Compose Multiplatform for Web is not yet fully production-ready, but it is moving in that direction. | partial | [c1] "These updates bring Compose Multiplatform for the web one step closer to providing a polished, production-ready experience." | Quote says 'one step closer' to production-ready, not that it's 'not yet fully production-ready' (which is an interpretation). |
| Most essential APIs will be available in the Beta version, enabling early adopters to confidently move to production with the existing feature set. | supported | [c2] "Most essential APIs will be available, enabling early adopters to confidently move to production with the existing feature set. After this Beta release, we will keep working on the remaining Compose APIs and further performance improvements." |  |
| However, after the Beta release, JetBrains will continue working on remaining Compose APIs and further performance improvements. | supported | [c2] "Most essential APIs will be available, enabling early adopters to confidently move to production with the existing feature set. After this Beta release, we will keep working on the remaining Compose APIs and further performance improvements." |  |

Uncited claims:

- So while you can experiment with web apps and some teams may be able to ship small- to medium-sized apps, the web target is currently in Beta rather than stable like the iOS target.

Fact score 1.00: present — Compose Multiplatform for Web is being released as a Beta (not Stable); present — With the Beta, most essential APIs are available so early adopters can move to production with the existing feature set; present — After the Beta, JetBrains keeps working on the remaining Compose APIs and performance

## q13

**off_topic** (should be "I don't know") — How long should I proof sourdough bread in the fridge overnight, and at what temperature?

Status: **dont_know** (low_relevance) · verification: low relevance (no answer call) · checks 1/1

> I don't know. These documents cover Kotlin, Kotlin Multiplatform, and Compose Multiplatform topics. Did you mean to ask about something related to Kotlin or Compose?

Best rejected chunks:

1. 0.001 · first-agent/src/context/invariants.js › InvariantProposer
2. 0.000 · first-agent/src/context/memory.js › MemoryStrategy
3. 0.000 · first-agent/src/store/conversationStore.js › normaliseRecord

## q14

**paraphrased** — In JetBrains' cross-platform UI toolkit, can people using my app on a Windows or Mac computer grab an element with the mouse, carry it across and let go of it over another element? Which version brought that, and what do I attach to the two elements?

Status: **dont_know** (model) · verification: verified · checks 0/3

> I don't know. Do the documents discuss drag-and-drop functionality in Compose Multiplatform, or what specific features were added in particular versions?

Fact score 0.00: missing — Compose Multiplatform 1.7.0 added drag and drop on desktop; missing — The dragAndDropSource modifier marks the composable where a drag starts; missing — The dragAndDropTarget modifier marks the composable that accepts the dropped data

## q15

**messy** — hi! ok so long story — we're rewriting our notes app and my coworker insists we keep our hand-rolled ID generator in the shared module because "kotlin doesn't have UUIDs in common code", which sounds wrong to me?? we're on kotlin 2.4 btw, just upgraded last sprint. anyway: is there a stable UUID type in common code now or do we still need a library, and can we generate v4/v7 ones without opting into anything? thanks, sorry for the wall of text lol

Status: **answered** · verification: verified · checks 5/5

> Good news — your coworker is wrong! [c1] Kotlin 2.4 has a stable UUID type available in common code. You can definitely replace that hand-rolled generator.
> 
> However, there's a caveat on V4/V7 generation: [c2] V4/V7 generation functions remain experimental, so you would need to opt into experimental APIs if you want to use those specific generation methods. The stable `Uuid` type itself is ready to use without any experimental flags, but generating V4 or V7 UUIDs specifically requires opting in.
> 
> So for your notes app: you can use the stable `kotlin.uuid.Uuid` type in your shared module right away, but if you specifically need V4 or V7 generation, you'll need to handle that with experimental annotations.

Sources:

1. Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium › 4. Stable UUID API · `kb/kotlin-2.4-10-new-features-android-developers-should-know-medium.html:structural:4`

Citations:

- **[c1]** "kotlin.uuid.Uuid Common code has a stable Uuid, used for offline-first Room entities and multiplatform IDs." — Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium › 4. Stable UUID API
- **[c2]** "V4/V7 generation functions remain experimental." — Kotlin 2.4_ 10 New Features Android Developers Should Know _ Medium › 4. Stable UUID API

Faithfulness 1.00:

| claim | verdict | quotes cited | note |
| --- | --- | --- | --- |
| Good news — your coworker is wrong! | supported | [c1] "kotlin.uuid.Uuid Common code has a stable Uuid, used for offline-first Room entities and multiplatform IDs." | The quote directly states that kotlin.uuid.Uuid Common code has a stable Uuid. |
| However, there's a caveat on V4/V7 generation: V4/V7 generation functions remain experimental, so you would need to opt into experimental APIs if you want to use those specific generation methods. | supported | [c2] "V4/V7 generation functions remain experimental." | The quote directly states that V4/V7 generation functions remain experimental. |

Uncited claims:

- Kotlin 2.4 has a stable UUID type available in common code.
- You can definitely replace that hand-rolled generator.
- The stable `Uuid` type itself is ready to use without any experimental flags, but generating V4 or V7 UUIDs specifically requires opting in.
- So for your notes app: you can use the stable `kotlin.uuid.Uuid` type in your shared module right away, but if you specifically need V4 or V7 generation, you'll need to handle that with experimental annotations.

Fact score 1.00: present — Kotlin 2.4 has a stable kotlin.uuid.Uuid usable in common code; present — The V4/V7 generation functions are still experimental (need an opt-in)

## q16

**multi_part** — Which Compose Multiplatform release added type-safe navigation, and which one brought Navigation 3? What does each give me?

Status: **answered** · verification: verified · checks 4/5

> **Type-safe navigation** was added in Compose Multiplatform 1.7.0 [c1]. It provides compile-time safety for your navigation graph [c2], allowing you to rely on type safety when passing objects along a navigation route [c3].
> 
> **Navigation 3** was introduced in Compose Multiplatform 1.10.0 [c4]. It is a new library for managing navigation that lets you manipulate your navigation stack directly, making tasks like adding or removing destinations more straightforward [c5].
> 
> In summary: version 1.7.0 gave you compile-time type safety for navigation, while version 1.10.0 brought a more flexible approach with Navigation 3 that allows direct stack manipulation.

Sources:

1. Compose Multiplatform 1.7.0 Released - The JetBrains Blog · `kb/compose-multiplatform-1.7.0-released-the-jetbrains-blog.html:structural:0`
2. Compose Multiplatform 1.7.0 Released - The JetBrains Blog › Type-safe navigation · `kb/compose-multiplatform-1.7.0-released-the-jetbrains-blog.html:structural:2`
3. Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog › Navigation 3 · `kb/compose-multiplatform-1.10.0-unified-preview-navigation-3-and-stable-compose-hot-reload-the-jetbrains-blog.html:structural:2`

Citations:

- **[c1]** "Compose Multiplatform now provides compile-time safety for your navigation graph." — Compose Multiplatform 1.7.0 Released - The JetBrains Blog
- **[c2]** "You can now rely on Compose Multiplatform for compile-time safety in navigation graphs." — Compose Multiplatform 1.7.0 Released - The JetBrains Blog › Type-safe navigation
- **[c3]** "To ensure type safety, we adopted Jetpack Compose's type-safe approach to passing objects along a navigation route." — Compose Multiplatform 1.7.0 Released - The JetBrains Blog › Type-safe navigation
- **[c4]** "We've introduced support for Navigation 3, a new library for managing navigation." — Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog › Navigation 3
- **[c5]** "With Navigation 3, you can manipulate your navigation stack directly, making tasks like adding or removing destinations more straightforward." — Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog › Navigation 3

Faithfulness 0.50:

| claim | verdict | quotes cited | note |
| --- | --- | --- | --- |
| Type-safe navigation was added in Compose Multiplatform 1.7.0. | partial | [c1] "Compose Multiplatform now provides compile-time safety for your navigation graph." | Quote says type-safe navigation was added but doesn't specify version 1.7.0 |
| It provides compile-time safety for your navigation graph, allowing you to rely on type safety when passing objects along a navigation route. | supported | [c2] "You can now rely on Compose Multiplatform for compile-time safety in navigation graphs."<br>[c3] "To ensure type safety, we adopted Jetpack Compose's type-safe approach to passing objects along a navigation route." |  |
| Navigation 3 was introduced in Compose Multiplatform 1.10.0. | partial | [c4] "We've introduced support for Navigation 3, a new library for managing navigation." | Quote mentions Navigation 3 was introduced but doesn't specify version 1.10.0 |
| It is a new library for managing navigation that lets you manipulate your navigation stack directly, making tasks like adding or removing destinations more straightforward. | supported | [c5] "With Navigation 3, you can manipulate your navigation stack directly, making tasks like adding or removing destinations more straightforward." |  |

Uncited claims:

- In summary: version 1.7.0 gave you compile-time type safety for navigation, while version 1.10.0 brought a more flexible approach with Navigation 3 that allows direct stack manipulation.

Fact score 1.00: present — Compose Multiplatform 1.7.0 added type-safe navigation, with compile-time safety in navigation graphs; present — It follows Jetpack Compose's type-safe approach to passing objects along a navigation route; present — Compose Multiplatform 1.10.0 added support for Navigation 3; present — Navigation 3 lets you manipulate the navigation stack directly

## q17

**ambiguous** (should be "I don't know") — How does it work?

Status: **dont_know** (model) · verification: verified · checks 1/1

> I don't know. What specific system or feature would you like to understand? The documents cover comparison profiles, pipeline runs, task state transitions, memory management, and working memory blocks. Which one interests you?
