# RAG vs plain: 10 questions, both modes

Generated 2026-10-04T01:52:46.259Z by `npm run eval:rag`. Answer model `claude-haiku-4-5-20251001` (both modes, temperature 0, max 1024 tokens);
judge `claude-haiku-4-5-20251001` (forced `submit_grade`, temperature 0, blind to the mode, `[n]` markers stripped).
Retrieval: doc_index `search()`, strategy `structural`, k = 5, collections all, minScore off.
Raw results: [`rag_results.json`](rag_results.json). Questions: [`../eval/rag/questions.md`](../eval/rag/questions.md).

## Summary

| | plain | rag |
| --- | ---: | ---: |
| mean fact score (9 answerable) | 0.21 | 0.89 |
| passed (score ≥ 0.75, no hallucination; unanswerable: declined) | 2/10 | 9/10 |
| answers with a hallucination | 4 | 0 |
| unanswerable declined | 1/1 | 1/1 |
| mean latency | 4.0 s | 2.6 s (retrieval 0.2 s) |
| mean input tokens | 72 | 1486 |
| mean output tokens | 336 | 193 |
| hit@5 (questions with expected sources) | | 8/8 (mean rank 1.0) |
| citations all valid | | 10/10 |
| cites an expected source | | 8/8 |
| RAG failures: retrieval miss / generation miss | | 0 / 0 |
| RAG failures: unanswerable not declined / general not in corpus | | 0 / 1 |

## Per question

| id | type | question | plain | rag | rank | rag outcome | verdict |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| [q01](#q01) | corpus | After moving to Compose Multiplatform 1.7 with Kotlin 2.0.20, how much faster did iOS rendering get in JetBrains' benchmarks, and did GC pauses improve too? | 0.00 | 1.00 | 1 | pass | RAG better (+1.00) |
| [q02](#q02) | corpus | Is Compose Multiplatform for iOS production-ready yet, and how much does it add to app size compared with a pure SwiftUI app? | 0.00 ⚠ | 1.00 | 1 | pass | RAG better (+1.00) · hallucination: plain |
| [q03](#q03) | corpus | I know Kotlin and want to enter this year's RevenueCat Shipaton in the JetBrains category. What can I win, and when does it run? | 0.00 | 1.00 | 1 | pass | RAG better (+1.00) |
| [q04](#q04) | corpus | Can an AI coding agent work with my running Compose app through hot reload? What exactly can it do there? | 0.13 ⚠ | 1.00 | 1 | pass | RAG better (+0.88) · hallucination: plain |
| [q05](#q05) | corpus | Which well-known companies have given KotlinConf talks about running KMP in production, and how much code did the fintech one end up sharing? | 0.00 | 1.00 | 1 | pass | RAG better (+1.00) |
| [q06](#q06) | corpus | Which compiler flags turn on context parameters and context-sensitive resolution in Kotlin 2.2.0, and is there a Kotlin/Native switch that reduces string memory? | 0.00 ⚠ | 1.00 | 1 | pass | RAG better (+1.00) · hallucination: plain |
| [q07](#q07) | corpus | How is Compose for Web supposed to run on older browsers that lack newer WebAssembly features? | 0.13 ⚠ | 1.00 | 1 | pass | RAG better (+0.88) · hallucination: plain |
| [q08](#q08) | general | What is Kotlin Multiplatform, and which parts of an app is it usually worth sharing across platforms? | 1.00 | 1.00 | 1 | pass | same (+0.00) |
| [q09](#q09) | general | How are Kotlin coroutines different from threads, and what does the suspend keyword actually do? | 0.67 | 0.00 | — | not in corpus | RAG worse (-0.67) |
| [q10](#q10) | unanswerable | What were the headline features of Compose Multiplatform 1.9.0? | 1.00 | 1.00 | — | pass | same: both declined |

⚠ = the judge flagged a hallucination.

## Findings

*Hand-written from the run of 2026-10-04 (Haiku 4.5 for answers and judge, structural chunks, k = 5, all collections). If the tables above have moved since then, trust the tables.*

**Sample size first.** There are 10 questions, so one question is worth 10 points, and each mode was run once at temperature 0. The gap is wide enough that this doesn't change the conclusion, but don't read anything into a 0.1 difference.

**Where RAG helped: every corpus question, by a lot.** On the 7 corpus questions, plain scored 0.00–0.13 and RAG scored 1.00 on all of them (mean fact score 0.21 → 0.89 over the 9 answerable questions, passes 2 → 9). Plain failed in two different ways, and the difference matters:
- **It said it didn't know (q01, q03, q05).** This is the honest failure: "I don't have specific benchmark data…". It scores 0, with no hallucination.
- **It answered confidently and got it wrong (q02, q04, q06, q07, all 4 hallucination flags).** q02 says Compose for iOS is "not officially production-ready" and adds "+30–50 MB" (the post says Stable and ~9 MB). q06 gives `-Xcontext-receivers` for context parameters. q07 says there is "no graceful degradation" when the roadmap describes a Kotlin/JS fallback. q04 read "Compose" as *Docker* Compose and explained volume mounts. RAG had **0** hallucinations. In this run, the documents fixed wrong answers more often than they filled in missing ones.

**Retrieval was not the bottleneck.** hit@5 was 8/8, and the expected source ranked **1st every time**. All 10 RAG answers had valid citations (no `[n]` outside 1–5), and all 8 with an expected source cited it. So there were 0 retrieval misses and 0 generation misses. Two caveats make this look better than it will in general:
- Each corpus question targets one short blog post whose vocabulary matches it.
- Code and the Transformer paper (the `projects` and `downloads` collections) never crowded out the articles. Day 21's README questions show they do crowd out project docs.

**Where RAG hurt: q09, the general question with no document.** Plain gave a good coroutines-vs-threads answer (0.67). RAG followed its rules exactly: it said the documents don't cover it and pointed to two passing mentions of `suspend` [1][3]. That scored 0.00. This is the cost of "answer only from the documents": for textbook knowledge the corpus doesn't hold, strict RAG is worse than no RAG. q08 (KMP, which *is* in an article) tied at 1.00, so RAG doesn't hurt when the corpus covers the topic.

**The unanswerable question (q10, Compose Multiplatform 1.9.0).** Retrieval returned the 1.7, 1.8 and 1.10 release posts at scores 0.60–0.62. RAG did not borrow their features. It said 1.9.0 isn't covered and listed which versions are. Contrary to the prediction in the question notes, **plain declined too** ("I don't have specific information about … 1.9.0"), so the result is "same: both declined". The difference is in *why*: plain declined because of its training cutoff, and RAG declined because the documents didn't cover it. On a version newer than the cutoff, only RAG would still decline correctly.

**Cost and latency.** RAG sends ~21× the input tokens (1,486 vs 72 on average), but answers were *faster* (2.6 s vs 4.0 s on average). Grounded answers were shorter (193 vs 336 output tokens), and output tokens dominate latency. Retrieval itself averaged 0.16 s once the embedding model was loaded (the first load took 1.3–3 s).

**Judge caveat.** In the first run, the Haiku judge flagged a hallucination in RAG's q06 answer: a "30% memory reduction" claim that *is* in the article, which the judge can't see. It also left `declined` false on q10 answers its own fact notes called declines. I tightened both definitions in `src/rag/judge.js` and moved `declined` first in the tool schema, then re-ran everything. These tables are from the second run. A judge that never sees the sources can only check facts against the expected list. It can't catch a true but unexpected detail, and it can't catch an unsupported one either.

**Changes for next time.**
1. **Let RAG fall back on general knowledge, clearly labelled.** Change the rule to: "if the documents don't cover it, say so, then you may answer from general knowledge, marked as not from the documents." That should recover q09 without bringing back the confident errors on q02, q06 and q07, which the documents contradict. Re-run this eval to check that hallucinations stay at 0.
2. **Keep minScore off for now. A single threshold can't do this job.** The unanswerable q10 retrieved its top chunk at 0.62, which is higher than correctly retrieved answers for q05 (0.55) and q04 (0.62). A cut-off that drops q10's chunks would also drop real answers. k = 5 was more than enough (every first hit ranked 1st), so k = 3 would save about 40% of the input tokens for the same answers on this set. That should be tested with harder, multi-document questions before changing it.

## q01

**corpus** — After moving to Compose Multiplatform 1.7 with Kotlin 2.0.20, how much faster did iOS rendering get in JetBrains' benchmarks, and did GC pauses improve too?

*Why:* Four exact benchmark numbers from one post. A model without the post may know iOS got faster but will guess or omit the figures; a wrong number is a hallucination.

Expected sources: `Compose Multiplatform 1.7.0 Released - The JetBrains Blog`

### Without RAG — score 0.00, declined

92 in · 234 out · 2.9 s

> I don't have specific benchmark data about iOS rendering performance improvements in Compose Multiplatform 1.7 with Kotlin 2.0.20.
> 
> While JetBrains has released both Compose Multiplatform 1.7 and Kotlin 2.0.20, I don't have access to detailed performance benchmarks comparing rendering speed or garbage collection pause improvements between versions.
> 
> To find this information, I'd recommend:
> 
> 1. **Check the official release notes** for Compose Multiplatform 1.7 and Kotlin 2.0.20 on JetBrains' website
> 2. **Look for blog posts** from JetBrains announcing these releases, which often include performance highlights
> 3. **Search the Kotlin/Compose forums or issue trackers** where developers discuss performance improvements
> 4. **Check JetBrains' official YouTube channel** for release announcements with benchmark discussions
> 
> If you've seen specific benchmark numbers, I'd be happy to help you interpret them or discuss what they mean for iOS development!

| expected fact | grade | note |
| --- | --- | --- |
| The VisualEffects benchmark runs 3.6 times faster | missing | Answer declines to provide specific benchmark data |
| Average CPU time per 1000 frames dropped from 8.8 s to 2.4 s | missing | Answer declines to provide specific benchmark data |
| LazyGrid scrolling is about 9% faster on average | missing | Answer declines to provide specific benchmark data |
| With concurrent GC marking, the worst p25 GC pause fell from 1.7 ms to 0.4 ms | missing | Answer declines to provide specific benchmark data |

### With RAG — score 1.00

1779 in · 301 out · 5.0 s · rank 1 · cited [1][5] · pass

> # iOS Performance Improvements with Compose Multiplatform 1.7.0 and Kotlin 2.0.20
> 
> ## Rendering Performance
> 
> According to JetBrains' benchmarks comparing Compose Multiplatform 1.6.11 with Kotlin 2.0.0 to version 1.7.0 with Kotlin 2.0.20, iOS rendering improvements varied by benchmark [1]:
> 
> - **LazyGrid benchmark** (scrolling): ~9% faster on average, with significantly reduced missed frames
> - **VisualEffects benchmark** (rendering many components): **3.6 times faster** – CPU time per 1000 frames dropped from 8.8 to 2.4 seconds
> - **AnimatedVisibility benchmark** (image animations): ~6% faster rendering
> 
> ## Garbage Collection Improvements
> 
> Yes, GC pauses improved significantly [1]:
> 
> - With concurrent marking enabled in Kotlin 2.0.20, the number of missed frames was **cut in half**
> - The worst p25 GC pause time for the LazyGrid benchmark dropped from **1.7 ms to 0.4 ms**
> 
> The concurrent marking feature allows the garbage collector's marking phase to run simultaneously with application threads, which shortens GC pauses and improves overall responsiveness [5].

| expected fact | grade | note |
| --- | --- | --- |
| The VisualEffects benchmark runs 3.6 times faster | present | Explicitly stated: 'VisualEffects benchmark (rendering many components): 3.6 times faster' |
| Average CPU time per 1000 frames dropped from 8.8 s to 2.4 s | present | Explicitly stated: 'CPU time per 1000 frames dropped from 8.8 to 2.4 seconds' |
| LazyGrid scrolling is about 9% faster on average | present | Explicitly stated: 'LazyGrid benchmark (scrolling): ~9% faster on average' |
| With concurrent GC marking, the worst p25 GC pause fell from 1.7 ms to 0.4 ms | present | Explicitly stated: 'The worst p25 GC pause time for the LazyGrid benchmark dropped from 1.7 ms to 0.4 ms' |

Retrieved chunks:

| n | score | source | section | text |
| ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.807 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog | Performance improvements on iOS | Performance improvements on iOS In Kotlin 2.0.20, the Kotlin/Native team contributed significantly to making Compose apps on iOS perform faster and smoother. The Compose Multiplatform 1.7.0 release m… |
| 2 ✓ | 0.630 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.7.0 Released Compose Multiplatform is a declarative UI framework built by JetBrains that allows developers to share UI implementations across differen… |
| 3 | 0.625 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious | 2. Compose Multiplatform Gets Serious Multiplatform Jetpack Compose was also promising but also buggy. Compose for iOS is stabilized in Kotlin 2.3 with improvements performance wise that makes it usa… |
| 4 | 0.587 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Performance that’s ready for production | Performance that’s ready for production A great user experience comes down to more than just UI behavior; it’s about performance, too. Smooth, responsive interactions are key to user satisfaction. Th… |
| 5 | 0.565 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Main Features | Main Features Kotlin 2.0.20 boasts concurrent marking for the garbage collector, which allows the marking phase to run simultaneously with application threads. This should significantly shorten GC pa… |

## q02

**corpus** — Is Compose Multiplatform for iOS production-ready yet, and how much does it add to app size compared with a pure SwiftUI app?

*Why:* The stable version may be known to a strong model; the ~9 MB size cost and the 96% survey figure are specific to the post. A different size figure is a hallucination.

Expected sources: `Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog`

### Without RAG — score 0.00, hallucination

74 in · 376 out · 5.1 s

> # Compose Multiplatform for iOS: Production Readiness
> 
> ## Status
> **Not officially production-ready** as of my last update (April 2024). JetBrains still marks it as in active development, though it's increasingly stable. Some companies use it in production, but it's not officially recommended for critical apps yet.
> 
> ## App Size Impact
> 
> This is a significant consideration:
> 
> - **SwiftUI app baseline**: ~5-10 MB (minimal)
> - **Compose Multiplatform iOS app**: typically **+30-50 MB** additional overhead
> 
> The overhead comes from:
> - Kotlin runtime and standard library
> - Compose runtime
> - Skiko (rendering engine)
> - Additional dependencies
> 
> So a simple app might be 40-60 MB instead of 10 MB.
> 
> ## Practical Considerations
> 
> **Pros:**
> - Code sharing across iOS/Android/Desktop
> - Familiar API for Android developers
> - Improving performance with each release
> 
> **Cons:**
> - Larger app size (significant for users on limited storage)
> - Less native feel than SwiftUI
> - Smaller ecosystem and fewer third-party libraries
> - Debugging can be more complex
> 
> ## Recommendation
> 
> - **Use SwiftUI** if building iOS-only apps
> - **Consider Compose Multiplatform** if you need significant code sharing across platforms and can accept the size/performance tradeoffs
> - **Wait** if production stability is critical for your use case
> 
> Check the [official Compose Multiplatform roadmap](https://www.jetbrains.com/help/kotlin-multiplatform-dev/compose-multiplatform-roadmap.html) for the latest status.

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform 1.8.0 made Compose for iOS Stable | missing | Answer states it's 'not officially production-ready' and only 'increasingly stable', contradicting the expected fact about 1.8.0 achieving Stable status. |
| It adds only about 9 MB to an iOS app compared with a native SwiftUI app | contradicted | Answer claims '+30-50 MB additional overhead', which directly contradicts the expected 9 MB figure. |
| Over 96% of teams using it on iOS report no major performance concerns | missing | No mention of any team survey or performance concern statistics. |

Hallucination: The answer claims Compose Multiplatform for iOS is 'not officially production-ready' and adds '30-50 MB' overhead, both of which contradict the expected facts (1.8.0 made it Stable, and it adds only ~9 MB).

### With RAG — score 1.00

1670 in · 193 out · 2.8 s · rank 1 · cited [4][2][1] · pass

> Yes, Compose Multiplatform for iOS is production-ready. According to the documents, Compose Multiplatform 1.8.0 brings "Compose for iOS to Stable" and is described as "Production-ready and easy to adopt" with "stable APIs, great performance, a native feel, and modern tooling." [4][2]
> 
> Regarding app size, Compose Multiplatform adds only **~9 MB to the size of an iOS app** compared to a fully native SwiftUI app with the same UI logic and assets. [1]
> 
> The documents also note that over 96% of teams using Compose Multiplatform on iOS report no major performance concerns, and several large-scale apps including Markaz, Wrike, Feres, and Physics Wallah are already integrating it into their applications. [1][2]

| expected fact | grade | note |
| --- | --- | --- |
| Compose Multiplatform 1.8.0 made Compose for iOS Stable | present | Answer states 'Compose Multiplatform 1.8.0 brings "Compose for iOS to Stable"' |
| It adds only about 9 MB to an iOS app compared with a native SwiftUI app | present | Answer explicitly states '~9 MB to the size of an iOS app' compared to 'fully native SwiftUI app' |
| Over 96% of teams using it on iOS report no major performance concerns | present | Answer directly states 'over 96% of teams using Compose Multiplatform on iOS report no major performance concerns' |

Retrieved chunks:

| n | score | source | section | text |
| ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.710 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Performance that’s ready for production | Performance that’s ready for production A great user experience comes down to more than just UI behavior; it’s about performance, too. Smooth, responsive interactions are key to user satisfaction. Th… |
| 2 ✓ | 0.633 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Production-ready and easy to adopt | Production-ready and easy to adopt Compose Multiplatform for iOS now gives you the full package: stable APIs, great performance, a native feel, and modern tooling. Your users will feel right at home … |
| 3 ✓ | 0.620 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Apps that feel truly native | Apps that feel truly native Smooth, native behavior is what iOS users expect – and notice. Compose Multiplatform for iOS focuses on getting the details right, so apps feel familiar and responsive on … |
| 4 ✓ | 0.577 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  | Multiplatform Compose Multiplatform 1.8.0 Released: Compose Multiplatform for iOS Is Stable and Production-Ready Today marks a major milestone in the Kotlin Multiplatform journey: the release of Com… |
| 5 | 0.565 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious | 2. Compose Multiplatform Gets Serious Multiplatform Jetpack Compose was also promising but also buggy. Compose for iOS is stabilized in Kotlin 2.3 with improvements performance wise that makes it usa… |

## q03

**corpus** — I know Kotlin and want to enter this year's RevenueCat Shipaton in the JetBrains category. What can I win, and when does it run?

*Why:* A 2026 event, after most model training data: plain mode cannot know the amounts or dates. Day 21 found that structural chunking splits the intro and the prize section, so watch the retrieval rank.

Expected sources: `Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog`

### Without RAG — score 0.00, declined

80 in · 213 out · 2.7 s

> I don't have current information about RevenueCat's Shipaton competition for this year, including specific details about:
> 
> - The JetBrains category prizes
> - The exact dates it runs
> - Current eligibility requirements
> 
> To get accurate, up-to-date information, I'd recommend:
> 
> 1. **Visit RevenueCat's official website** - Check their blog or events page for Shipaton details
> 2. **Check JetBrains announcements** - They often promote hackathons and competitions
> 3. **Look for official social media** - RevenueCat's Twitter/X, LinkedIn, or Discord community
> 4. **Contact RevenueCat directly** - Their team can provide current details about prizes and timeline
> 
> Since hackathons and competitions update their details annually, checking official sources will give you the most reliable information about what's available this year.
> 
> Is there anything else about Kotlin development or RevenueCat's SDK that I can help you with?

| expected fact | grade | note |
| --- | --- | --- |
| The JetBrains (Ship Kotlin Everywhere) award has a $30,000 prize pool | missing |  |
| It is split among three winners: $15,000, $10,000 and $5,000 | missing |  |
| Shipaton 2026 runs from August 1 to September 30 | missing |  |
| The first-place app gets a feature on a Times Square billboard | missing |  |

### With RAG — score 1.00

1560 in · 292 out · 3.3 s · rank 1 · cited [1][4][2] · pass

> # Shipaton 2026 - JetBrains Category
> 
> ## When It Runs
> The RevenueCat Shipaton 2026 runs from **August 1 to September 30** [1].
> 
> ## What You Can Win
> 
> The "Ship Kotlin Everywhere Award" has a **$30,000 prize pool** split among three winners [4]:
> - **1st place: $15,000** (plus a feature on a Times Square billboard, an invitation to RevenueCat's App Growth Annual conference in New York City on October 21, a custom Shippy trophy, and media spotlight) [4]
> - **2nd place: $10,000** [4]
> - **3rd place: $5,000** [4]
> 
> Additionally, your app stays in the running for the **$100,000 Grand Prize** and more than 20 other categories across the entire Shipaton competition, with over $1,000,000 in total prizes available [4].
> 
> ## The Challenge
> You'll need to build one brand-new app using Kotlin Multiplatform and Compose Multiplatform and bring it to multiple platforms (Android, iOS, desktop, and/or web). You don't need to hit all four platforms—judges reward effective cross-platform development [2].

| expected fact | grade | note |
| --- | --- | --- |
| The JetBrains (Ship Kotlin Everywhere) award has a $30,000 prize pool | present | Explicitly stated: '$30,000 prize pool' for the 'Ship Kotlin Everywhere Award' |
| It is split among three winners: $15,000, $10,000 and $5,000 | present | All three amounts correctly listed: 1st place $15,000, 2nd place $10,000, 3rd place $5,000 |
| Shipaton 2026 runs from August 1 to September 30 | present | Explicitly stated: 'August 1 to September 30' |
| The first-place app gets a feature on a Times Square billboard | present | Explicitly stated: 'a feature on a Times Square billboard' for 1st place |

Retrieved chunks:

| n | score | source | section | text |
| ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.669 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog |  | Multiplatform News Know Kotlin? Ship It Everywhere and Win at Shipaton 2026 Somewhere in your notes there’s an app idea waiting for a free weekend that never comes. Consider this its official deadl… |
| 2 ✓ | 0.651 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | The Ship Kotlin Everywhere Award | The Ship Kotlin Everywhere Award JetBrains is a Gold Sponsor of Shipaton this year, with our own category. The idea is simple: reuse the Kotlin you already know to build one brand-new app and bring i… |
| 3 ✓ | 0.623 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | What you get as a participant | What you get as a participant - IntelliJ IDEA Ultimate, free for 3 months for the first 1,000 builders - Access to Junie, our AI coding agent, for 2 months for 200 builders ready to build in public … |
| 4 ✓ | 0.585 | Know Kotlin_ Ship It Everywhere and Win at Shipaton 2026 - The JetBrains Blog | What you can win | What you can win The award has a $30,000 prize pool split among three winners: $15,000, $10,000, and $5,000. The first-place app also receives Shipaton’s first-place category winner package: a featur… |
| 5 | 0.414 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Key priorities | Key priorities Kotlin Multiplatform spans many areas, from language features and target-specific compilation to our IDE plugin. It’s a lot to track, so here are the three key priorities that guide ou… |

## q04

**corpus** — Can an AI coding agent work with my running Compose app through hot reload? What exactly can it do there?

*Why:* Compose Multiplatform 1.12.0 feature. Phrased without 'MCP' so retrieval has to match on meaning. A plain answer will likely describe Hot Reload in general or say it does not know of such a feature.

Expected sources: `Compose Multiplatform 1.12.0 Released - The JetBrains Blog`

### Without RAG — score 0.13, hallucination

65 in · 376 out · 4.7 s

> # AI Coding Agent with Docker Compose Hot Reload
> 
> Yes, an AI coding agent can work with your running Compose app through hot reload, but **capabilities depend on how you've set it up**.
> 
> ## What It Can Do
> 
> **With proper volume mounts:**
> - Edit source files on your host machine
> - Changes automatically reflect in the running container (if hot reload is configured)
> - Test changes immediately without rebuilding
> - Iterate quickly on code fixes and features
> 
> **Typical workflow:**
> 1. Agent modifies code files in your project directory
> 2. Hot reload detects changes (via file watchers)
> 3. App reloads without container restart
> 4. Agent can verify changes by checking logs or making requests
> 
> ## Key Requirements
> 
> For this to work, you need:
> 
> ```yaml
> # docker-compose.yml example
> services:
>   app:
>     volumes:
>       - ./src:/app/src  # Mount source code
>     environment:
>       - NODE_ENV=development  # Enable hot reload
> ```
> 
> **Language-specific setup:**
> - **Node.js**: nodemon, ts-node-dev
> - **Python**: watchdog, auto-reload
> - **Go**: air, CompileDaemon
> - **Java**: Spring DevTools
> 
> ## Limitations
> 
> - Agent can't directly execute commands in the container (unless you expose an API)
> - Can't see real-time logs unless you stream them
> - Can't interact with databases or external services directly
> - Changes must be file-based (not in-memory modifications)
> 
> ## Best Practice
> 
> Expose a **health check endpoint** or **API** so the agent can verify changes worked without manual testing.
> 
> What tech stack are you using?

| expected fact | grade | note |
| --- | --- | --- |
| Compose Hot Reload ships an experimental MCP (Model Context Protocol) server for AI agents | missing | The answer discusses Docker Compose hot reload with volume mounts but does not mention MCP server at all. |
| The agent can trigger reloads and take screenshots | missing | The answer does not mention the agent's ability to trigger reloads or take screenshots. |
| It can inspect the semantic tree and simulate clicks and text input | missing | No mention of semantic tree inspection or UI interaction capabilities like clicks and text input. |
| It can read the application logs | partial | The answer mentions 'can't see real-time logs unless you stream them' but doesn't clearly state that the agent can read logs as a capability. |

Hallucination: The answer discusses Docker Compose hot reload with volume mounts and language-specific tools (nodemon, watchdog, air, Spring DevTools), which is about general container development practices, not about Compose Multiplatform's experimental MCP server for AI agents. The question appears to be about Compose Multiplatform (a JetBrains tool for UI development), not Docker Compose. The answer conflates two entirely different technologies.

### With RAG — score 1.00

1418 in · 217 out · 3.3 s · rank 1 · cited [1] · pass

> Yes, an AI coding agent can work with your running Compose app through hot reload. [1]
> 
> Specifically, using the Model Context Protocol (MCP) server that ships with Compose Hot Reload, an agent can: [1]
> 
> - **Trigger reloads** of your application
> - **Take screenshots** to see the current state
> - **Inspect the semantic tree** of your UI
> - **Simulate clicks and text input** to interact with the app
> - **Read application logs** for debugging
> 
> The practical benefit is that the agent can verify the results of its own edits without requiring manual description. It can confirm that a reload succeeded, inspect the rendered UI, catch runtime exceptions, and iterate on changes autonomously. [1]
> 
> This MCP server capability was introduced as an experimental feature in Compose Multiplatform 1.12.0. [1] For the complete list of available tools and connection instructions, you can refer to the Compose Hot Reload documentation. [1]

| expected fact | grade | note |
| --- | --- | --- |
| Compose Hot Reload ships an experimental MCP (Model Context Protocol) server for AI agents | present | Clearly stated that MCP server ships with Compose Hot Reload |
| The agent can trigger reloads and take screenshots | present | Both capabilities explicitly listed |
| It can inspect the semantic tree and simulate clicks and text input | present | Both capabilities explicitly listed |
| It can read the application logs | present | Explicitly stated in the bullet list |

Retrieved chunks:

| n | score | source | section | text |
| ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.624 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | MCP server for AI agents in Compose Hot Reload | MCP server for AI agents in Compose Hot Reload Compose Hot Reload now ships with an experimental Model Context Protocol (MCP) server that connects AI coding agents to your running application. Using… |
| 2 | 0.527 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload | Compose Hot Reload Compose Hot Reload is designed to speed up UI iteration by letting you instantly see changes without restarting the application: The Compose Hot Reload plugin is now stable – chec… |
| 3 | 0.495 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency | Development tools that boost your efficiency To make building Compose Multiplatform apps faster, smoother, and more enjoyable, we’re actively improving the KMP tooling. A new KMP plugin is coming soo… |
| 4 ✓ | 0.479 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.12.0 Released Compose Multiplatform 1.12.0 is out! This version brings new tooling for AI assistants, improvements to web resource management, and fin… |
| 5 | 0.409 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.10.0: Unified @Preview, Navigation 3, and Stable Compose Hot Reload Compose Multiplatform 1.10.0 has been released! We’re continually developing our m… |

## q05

**corpus** — Which well-known companies have given KotlinConf talks about running KMP in production, and how much code did the fintech one end up sharing?

*Why:* Names and numbers from the curated talk list. A plain answer may name other companies (Netflix, Cash App, …) that are real KMP users but not in this list; those are not wrong, but the 55% / 130 figures are needed.

Expected sources: `The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog`

### Without RAG — score 0.00, declined

75 in · 228 out · 2.7 s

> I don't have specific information about which companies have given KotlinConf talks about running Kotlin Multiplatform (KMP) in production, or details about a fintech company's code-sharing metrics from such a talk.
> 
> To find this information, I'd recommend:
> 
> 1. **Checking KotlinConf's official resources** - Visit the KotlinConf website or YouTube channel where talks are typically recorded and archived
> 2. **Searching Kotlin's blog** - JetBrains often publishes summaries of notable talks
> 3. **Looking at talk abstracts** - Conference schedules usually list speaker names and companies
> 4. **Checking the Kotlin Slack or forums** - The community often discusses notable talks
> 
> If you remember any other details about the fintech talk (year, speaker name, or company), that would help narrow down the search. Alternatively, if you have a link to the talk or more context, I'd be happy to help you find the specific code-sharing percentage or other details you're looking for.

| expected fact | grade | note |
| --- | --- | --- |
| StoneCo (a fintech) reached 55% shared code | missing |  |
| StoneCo trained 130 mobile engineers for the shift | missing |  |
| Duolingo ships weekly to 40M+ daily users with KMP | missing |  |
| McDonald's uses KMP to drive navigation state while the UI stays native | missing |  |

### With RAG — score 1.00

1679 in · 154 out · 1.9 s · rank 1 · cited [2] · pass

> Based on the documents, the well-known companies that have given KotlinConf talks about running KMP in production are: [2]
> 
> 1. **Duolingo** - Ships weekly to 40M+ daily users across Android, iOS, and Web [2]
> 2. **McDonald's** - Uses KMP to drive navigation state in their app [2]
> 3. **StoneCo** - A fintech company serving 4 million users [2]
> 
> The fintech company, **StoneCo, achieved 55% code sharing** across two massive apps after two years with KMP. This involved training 130 mobile engineers to shift their development paradigm. [2]

| expected fact | grade | note |
| --- | --- | --- |
| StoneCo (a fintech) reached 55% shared code | present | Explicitly stated: 'StoneCo, achieved 55% code sharing' |
| StoneCo trained 130 mobile engineers for the shift | present | Explicitly stated: 'training 130 mobile engineers' |
| Duolingo ships weekly to 40M+ daily users with KMP | present | Explicitly stated: 'Ships weekly to 40M+ daily users' |
| McDonald's uses KMP to drive navigation state while the UI stays native | present | Explicitly stated: 'Uses KMP to drive navigation state in their app' |

Retrieved chunks:

| n | score | source | section | text |
| ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.548 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ?️ Part 2: Getting Your Hands Dirty | ?️ Part 2: Getting Your Hands Dirty Okay, you’re inspired. Now let’s look at the code. Compose Multiplatform for iOS: Ready for Production \| Sebastian Aigner (2025)Compose Multiplatform is no longer… |
| 2 ✓ | 0.546 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog | ? Part 1: Production Case Studies | ? Part 1: Production Case Studies Theory is nice, but does it scale? These teams proved it does. Duolingo + KMP: A Case Study in Productivity \| John Rodriguez & Johnny Ye (2025)Duolingo ships weekly… |
| 3 ✓ | 0.525 | The Ultimate KMP Watchlist_ Level Up Your Skills in 10 Talks - The JetBrains Blog |  | Multiplatform The Ultimate KMP Watchlist: Level Up Your Skills in 10 Talks The best way to skip the “beginner mistakes” phase is to learn from the teams who have already solved them at scale. For W… |
| 4 | 0.524 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | The Real-World Impact | The Real-World Impact In an article about their migration to KMP with Kotlin 2.3, Basecamp reported that code duplication was reduced by 40%. Auth, data sync, and API networking — one validation — ev… |
| 5 | 0.499 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways | Key Takeaways - Real KMP pain points solved for Kotlin 2.3 — better iOS interop, stable Compose, better tooling - Compose Multiplatform If you need to share corner of your UI across platforms, it’s … |

## q06

**corpus** — Which compiler flags turn on context parameters and context-sensitive resolution in Kotlin 2.2.0, and is there a Kotlin/Native switch that reduces string memory?

*Why:* Exact flag and property names. A strong model may know the two -X flags; the Latin-1 property and the 50% figure come from the article. A made-up property name is a hallucination.

Expected sources: `Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium`

### Without RAG — score 0.00, hallucination

78 in · 348 out · 4.0 s

> # Kotlin 2.2.0 Compiler Flags
> 
> ## Context Parameters and Context-Sensitive Resolution
> 
> In Kotlin 2.2.0, context parameters are controlled by:
> 
> **`-Xcontext-receivers`**
> 
> This flag enables context receiver support, which allows functions and classes to declare implicit context parameters that are resolved based on the types in scope.
> 
> Example usage:
> ```bash
> kotlinc -Xcontext-receivers myfile.kt
> ```
> 
> In Gradle:
> ```kotlin
> kotlin {
>     compilerOptions {
>         freeCompilerArgs.add("-Xcontext-receivers")
>     }
> }
> ```
> 
> ## Kotlin/Native String Memory Optimization
> 
> For Kotlin/Native, there isn't a single dedicated flag specifically named for "reducing string memory." However, relevant optimizations include:
> 
> - **`-Xoptimize`** - Enables optimizations (including string handling)
> - **`-Xgc=`** - Controls garbage collection strategy, which affects memory usage
> - **`-Xallocator=`** - Selects memory allocator (can impact string memory efficiency)
> 
> For more aggressive memory optimization in Kotlin/Native, you might also consider:
> - Using `-opt` (optimization level)
> - Configuring the binary type appropriately
> 
> **Note:** If you're looking for a specific string interning or memory pooling feature, it may not have a dedicated flag in 2.2.0. Check the official Kotlin release notes or documentation for the most current memory optimization options.

| expected fact | grade | note |
| --- | --- | --- |
| Context parameters are enabled with -Xcontext-parameters | contradicted | Answer states -Xcontext-receivers, not -Xcontext-parameters |
| Context-sensitive resolution is enabled with -Xcontext-sensitive-resolution | missing | Not mentioned in the answer at all |
| kotlin.native.binary.latin1Strings=true enables Latin-1 strings on Kotlin/Native | missing | Answer mentions -Xoptimize, -Xgc, -Xallocator but not the specific latin1Strings property |
| Latin-1 strings use about 50% less memory | missing | Not mentioned in the answer |

Hallucination: The answer claims -Xcontext-receivers enables context parameters, but the expected fact specifies -Xcontext-parameters. These are different flags with different purposes.

### With RAG — score 1.00

1407 in · 195 out · 2.1 s · rank 1 · cited [4][2] · pass

> Based on the documents provided:
> 
> **Compiler flags for context features:**
> - Context parameters are enabled with the `-Xcontext-parameters` flag [4]
> - Context-sensitive resolution is enabled with the `-Xcontext-sensitive-resolution` flag [4]
> 
> **Kotlin/Native switch for string memory reduction:**
> Yes, there is a Kotlin/Native setting that reduces string memory. You can enable Latin-1 string optimization by adding the following to gradle.properties [2]:
> 
> ```
> kotlin.native.binary.latin1Strings=true
> ```
> 
> This optimization reduces memory usage by 50% for strings containing only Latin-1 characters [2]. According to the documents, enabling this optimization (along with per-object memory allocation) reduced memory usage by approximately 30% for text-heavy operations in a production Kotlin Multiplatform project with iOS targets [2].

| expected fact | grade | note |
| --- | --- | --- |
| Context parameters are enabled with -Xcontext-parameters | present | Correctly stated in the answer |
| Context-sensitive resolution is enabled with -Xcontext-sensitive-resolution | present | Correctly stated in the answer |
| kotlin.native.binary.latin1Strings=true enables Latin-1 strings on Kotlin/Native | present | Correctly stated with proper configuration syntax |
| Latin-1 strings use about 50% less memory | present | Explicitly stated: 'reduces memory usage by 50% for strings containing only Latin-1 characters' |

Retrieved chunks:

| n | score | source | section | text |
| ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.642 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements › Per-Object Memory Allocation | 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements The Kotlin/Native improvements in 2.2.0 are substantial, especially for production applications. Per-Object Memory Allocation // gradl… |
| 2 ✓ | 0.621 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🚀 Kotlin/Native Gets Serious: LLVM 19 and Memory Improvements › Latin-1 String Optimization | Latin-1 String Optimization // gradle.properties kotlin.native.binary.latin1Strings=true // Strings with Latin-1 characters now use 50% less memory class TextProcessor { fun processASCIIFiles(fil… |
| 3 ✓ | 0.603 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🔮 What This Means for Your Daily Development | 🔮 What This Means for Your Daily Development After using these features for several weeks, here’s what I’ve noticed: Code Quality: My codebases are cleaner and more maintainable. Context parameters… |
| 4 ✓ | 0.601 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🚀 Getting Started Today | 🚀 Getting Started Today Ready to upgrade? Here’s your migration checklist: - Update your Kotlin version to 2.2.0 in build.gradle.kts - Enable context parameters with -Xcontext-parameters - Try co… |
| 5 ✓ | 0.579 | Kotlin 2.2.0_ Game-Changing Features That Will Transform Your Development Workflow _ by praveen sharma _ Medium | 🎯 Context-Sensitive @all Annotation Target | 🎯 Context-Sensitive @all Annotation Target This small feature saves enormous amounts of time when working with annotations. // Before: Tedious and error-prone class User( @field:JsonProperty("u… |

## q07

**corpus** — How is Compose for Web supposed to run on older browsers that lack newer WebAssembly features?

*Why:* A roadmap item from the August 2025 update. Plain mode may guess (polyfills, 'not supported') rather than name the Kotlin/JS fallback.

Expected sources: `What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog`

### Without RAG — score 0.13, hallucination

63 in · 371 out · 4.2 s

> # Compose for Web and Older Browser Support
> 
> Compose for Web (Jetpack Compose for Web) has **limited support for older browsers** because it relies on WebAssembly, which has varying levels of support across browser versions.
> 
> ## The Reality
> 
> - **Modern browsers only**: Compose for Web is designed for browsers with solid WebAssembly support (Chrome 57+, Firefox 52+, Safari 14.1+, Edge 79+)
> - **No graceful degradation**: There's no built-in fallback mechanism for browsers lacking WebAssembly features
> - **Older browsers will fail**: If a browser doesn't support the required WebAssembly features, the application simply won't run
> 
> ## Why This Limitation Exists
> 
> 1. **Kotlin/JS compilation**: Compose for Web compiles Kotlin to WebAssembly, which is the primary target
> 2. **Feature requirements**: Modern Compose features depend on WebAssembly capabilities that older browsers don't have
> 3. **Development focus**: JetBrains prioritizes modern browser support rather than backward compatibility
> 
> ## If You Need Older Browser Support
> 
> Your options are limited:
> 
> - **Use a different framework**: Consider web frameworks designed for broader compatibility (React, Vue, Angular)
> - **Polyfills**: Limited effectiveness; WebAssembly itself can't be meaningfully polyfilled
> - **Browser upgrade messaging**: Inform users they need a modern browser
> - **Kotlin/JS without Compose**: Use Kotlin/JS directly for more control, though this loses Compose's benefits
> 
> **Bottom line**: Compose for Web is a modern-first solution and isn't suitable if you need to support legacy browsers.

| expected fact | grade | note |
| --- | --- | --- |
| A compatibility mode falls back to Kotlin/JS | contradicted | The answer explicitly states 'There's no built-in fallback mechanism' and 'No graceful degradation', directly contradicting the expected fact about a compatibility mode fallback. |
| Compose for Web defaults to Kotlin/Wasm for performance | partial | The answer mentions 'compiles Kotlin to WebAssembly' but doesn't explicitly state that Kotlin/Wasm is the default or that this is for performance reasons. |
| The fallback targets browsers without Wasm garbage collection or exception handling | missing | The answer states there is no fallback mechanism at all, so this specific detail about what the fallback targets is not mentioned. |
| It comes as part of the Compose for Web Beta | missing | The answer does not mention that this is part of a Beta release or any version information. |

Hallucination: The answer claims 'There's no built-in fallback mechanism for browsers lacking WebAssembly features' and 'No graceful degradation', which directly contradicts the expected fact that a compatibility mode falls back to Kotlin/JS. This is a specific claim that conflicts with the expected facts about how Compose for Web handles older browsers.

### With RAG — score 1.00

1310 in · 118 out · 1.8 s · rank 1 · cited [1] · pass

> According to the documents, Compose for Web is supposed to run on older browsers that lack newer WebAssembly features through a **fallback to Kotlin/JS** [1].
> 
> Here's how it works: Compose for Web defaults to Kotlin/Wasm for performance, but as part of the Compose for Web Beta, a compatibility mode using Kotlin/JS is being introduced as a fallback. This fallback allows apps to run on older browsers that don't support modern Wasm features like garbage collection or exception handling [1].

| expected fact | grade | note |
| --- | --- | --- |
| A compatibility mode falls back to Kotlin/JS | present | Explicitly stated: 'a compatibility mode using Kotlin/JS is being introduced as a fallback' |
| Compose for Web defaults to Kotlin/Wasm for performance | present | Explicitly stated: 'Compose for Web defaults to Kotlin/Wasm for performance' |
| The fallback targets browsers without Wasm garbage collection or exception handling | present | Explicitly stated: 'older browsers that don't support modern Wasm features like garbage collection or exception handling' |
| It comes as part of the Compose for Web Beta | present | Explicitly stated: 'as part of the Compose for Web Beta, a compatibility mode using Kotlin/JS is being introduced' |

Retrieved chunks:

| n | score | source | section | text |
| ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.645 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Kotlin/JS › Fallback to Kotlin/JS for Compose for Web | Kotlin/JS Fallback to Kotlin/JS for Compose for Web As part of the Compose for Web Beta, we will be introducing a compatibility mode using Kotlin/JS as a fallback. This broadens browser support for … |
| 2 | 0.518 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Compose Multiplatform beyond mobile | Compose Multiplatform beyond mobile Compose Multiplatform for the web is also evolving rapidly. With 1.8.0, the Navigation library now supports browser back and forward buttons, making web apps feel … |
| 3 ✓ | 0.454 | What’s Next for Kotlin Multiplatform and Compose Multiplatform – August 2025 Update - The JetBrains Blog | Compose Multiplatform › Release Compose Multiplatform for Web in Beta | Compose Multiplatform Release Compose Multiplatform for Web in Beta This Beta version embodies our commitment to support and evolve the existing APIs of Compose Multiplatform for Web. Most essential… |
| 4 | 0.445 | Compose Multiplatform 1.12.0 Released - The JetBrains Blog | Automatic font fallback for web | Automatic font fallback for web Compose Multiplatform for web now handles characters that your application’s fonts don’t cover. When it encounters an unresolved character during rendering, it downloa… |
| 5 | 0.424 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What Actually Changed › 2. Compose Multiplatform Gets Serious | 2. Compose Multiplatform Gets Serious Multiplatform Jetpack Compose was also promising but also buggy. Compose for iOS is stabilized in Kotlin 2.3 with improvements performance wise that makes it usa… |

## q08

**general** — What is Kotlin Multiplatform, and which parts of an app is it usually worth sharing across platforms?

*Why:* General knowledge a strong model answers well; one article (the Kotlin 2.3 multiplatform post, saved under a 2.4.20 file name) also has a 'share this / keep platform-specific' list. RAG should at least not hurt.

Expected sources: `Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium`

### Without RAG — score 1.00

65 in · 404 out · 4.8 s

> # Kotlin Multiplatform
> 
> Kotlin Multiplatform (KMP) is a framework that lets you write code once in Kotlin and share it across multiple platforms (Android, iOS, web, desktop, etc.). The shared code compiles to each platform's native format.
> 
> ## How It Works
> 
> - **Shared code**: Business logic written in Kotlin that compiles to all platforms
> - **Platform-specific code**: Native implementations for UI and platform-specific features
> - **Expect/Actual**: A mechanism to define interfaces in shared code and provide platform-specific implementations
> 
> ## What's Usually Worth Sharing
> 
> ### ✅ **Highly Recommended**
> - **Business logic** - Data processing, calculations, algorithms
> - **Data models** - Classes representing your app's core entities
> - **Networking** - API calls and data serialization (using Ktor Client)
> - **Database logic** - Data persistence layer (using SQLDelight)
> - **Validation rules** - Input validation, business rules
> - **State management** - App state and logic (Redux, MVI patterns)
> 
> ### ⚠️ **Conditionally Worth Sharing**
> - **Utilities** - Helper functions, extensions
> - **Analytics/Logging** - Core tracking logic (with platform-specific implementations)
> - **Authentication** - Token management, login logic
> 
> ### ❌ **Usually Not Worth Sharing**
> - **UI/Presentation** - Use platform-native UI frameworks (SwiftUI, Jetpack Compose)
> - **Platform-specific APIs** - Camera, location, notifications (use expect/actual)
> - **Performance-critical code** - May need native optimization
> 
> ## Key Benefit
> 
> You typically share **30-70% of code** depending on app complexity, eliminating duplication of business logic while keeping native UI experiences.

| expected fact | grade | note |
| --- | --- | --- |
| It shares Kotlin code across platforms such as Android, iOS and the backend | present | Answer explicitly states KMP lets you 'write code once in Kotlin and share it across multiple platforms (Android, iOS, web, desktop, etc.)' |
| Business logic and validation are good candidates to share | present | Answer lists both 'Business logic' and 'Validation rules' under 'Highly Recommended' to share |
| Networking / API clients are commonly shared | present | Answer explicitly lists 'Networking - API calls and data serialization (using Ktor Client)' as highly recommended to share |
| Platform APIs such as camera or notifications usually stay platform-specific | present | Answer states under 'Usually Not Worth Sharing': 'Platform-specific APIs - Camera, location, notifications (use expect/actual)' |

### With RAG — score 1.00

1128 in · 262 out · 2.9 s · rank 1 · cited [5][2][1][4] · pass

> # Kotlin Multiplatform (KMP)
> 
> Based on the documents, Kotlin Multiplatform is an approach to code sharing across iOS, Android, and backend platforms using Kotlin. [5]
> 
> ## What's Worth Sharing Across Platforms
> 
> According to the practical guidance in the documents, you should share: [2]
> 
> - **Business logic and validation**
> - **API client implementations** (GraphQL clients, Ktor)
> - **Data models and serialization**
> - **Authentication flows**
> - **Analytics and logging**
> 
> ## What Should Stay Platform-Specific
> 
> Keep these as native implementations: [1]
> 
> - **UI components** (though Compose Multiplatform can be used for common UI when needed)
> - **Platform APIs** (camera, notifications, HealthKit)
> - **Deep navigation patterns**
> - **Performance-critical animations**
> 
> ## The Key Philosophy
> 
> The documents emphasize that Kotlin 2.3 enables a pragmatic approach: "sharing what is really valuable and being native when it matters." [4] Rather than trying to share everything, the recommendation is to start gradually by exposing business logic first, then UI only when needed. [4]

| expected fact | grade | note |
| --- | --- | --- |
| It shares Kotlin code across platforms such as Android, iOS and the backend | present | Clearly stated: 'code sharing across iOS, Android, and backend platforms using Kotlin' |
| Business logic and validation are good candidates to share | present | Explicitly listed under 'What's Worth Sharing': 'Business logic and validation' |
| Networking / API clients are commonly shared | present | Covered by 'API client implementations' and 'GraphQL clients, Ktor' in the shared section |
| Platform APIs such as camera or notifications usually stay platform-specific | present | Explicitly stated under 'What Should Stay Platform-Specific': 'Platform APIs (camera, notifications, HealthKit)' |

Retrieved chunks:

| n | score | source | section | text |
| ---: | ---: | --- | --- | --- |
| 1 ✓ | 0.678 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What You Should Actually Share › Keep Platform-Specific: | Keep Platform-Specific: - UI components (if necessary use Compose Multiplatform for common UI) - Platform APIs (camera, notifications, HealthKit) - Deep navigation patterns - Performance-critical … |
| 2 ✓ | 0.675 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | What You Should Actually Share › Share This: | What You Should Actually Share Not everything should go in shared code. Here’s the practical breakdown: Share This: - Business logic and validation - API client implementations (GraphQL clients, K… |
| 3 ✓ | 0.651 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Getting Started Without the Hype | Getting Started Without the Hype Don’t rewrite your entire app. Start small: - Move Business Logic of a Feature Into a Shared Module - Expose your network layer and API models - Integrate a Compos… |
| 4 ✓ | 0.626 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium | Key Takeaways | Key Takeaways - Real KMP pain points solved for Kotlin 2.3 — better iOS interop, stable Compose, better tooling - Compose Multiplatform If you need to share corner of your UI across platforms, it’s … |
| 5 ✓ | 0.610 | Kotlin 2.4.20 Release_ What's New & Why It Matters (2026) _ Medium |  | Kotlin 2.3 Is Making Multiplatform Development Actually Work AndroidLab by Andre3 min readFeb 2, 2026 How the latest Kotlin release is finally delivering on the promise of true code sharing across i… |

## q09

**general** — How are Kotlin coroutines different from threads, and what does the suspend keyword actually do?

*Why:* Textbook Kotlin that no article in the corpus explains. Plain mode should score well; strict RAG rules may make RAG decline, which would be RAG hurting a general question. Record which happens.

Expected sources: none

### Without RAG — score 0.67

62 in · 621 out · 7.0 s

> # Kotlin Coroutines vs Threads
> 
> ## Key Differences
> 
> | Aspect | Threads | Coroutines |
> |--------|---------|-----------|
> | **Creation cost** | Expensive (OS-level resource) | Cheap (lightweight) |
> | **Memory** | ~1-2 MB per thread | Kilobytes per coroutine |
> | **Switching** | Preemptive (OS decides) | Cooperative (code decides) |
> | **Quantity** | Hundreds practical limit | Thousands/millions possible |
> | **Blocking** | Blocks entire thread | Suspends without blocking thread |
> 
> ## What `suspend` Actually Does
> 
> The `suspend` keyword marks a function as **suspendable**—it can pause execution and resume later *without blocking the underlying thread*.
> 
> ### How it works:
> 
> ```kotlin
> // Regular function - blocks the thread
> fun regularFunction() {
>     Thread.sleep(1000)  // Thread is stuck here
>     println("Done")
> }
> 
> // Suspendable function - pauses without blocking
> suspend fun suspendFunction() {
>     delay(1000)  // Coroutine pauses, thread is FREE
>     println("Done")
> }
> ```
> 
> When `delay(1000)` is called:
> - The coroutine **suspends** (pauses)
> - The thread **continues** running other coroutines
> - After 1000ms, the coroutine **resumes** where it left off
> 
> ### Under the hood:
> 
> The Kotlin compiler transforms `suspend` functions into state machines. Simplified:
> 
> ```kotlin
> // What you write:
> suspend fun fetchData(): String {
>     val result = api.call()  // suspends here
>     return result
> }
> 
> // Roughly what happens:
> fun fetchData(continuation: Continuation<String>) {
>     when (continuation.label) {
>         0 -> {
>             continuation.label = 1
>             api.call(continuation)  // suspends
>         }
>         1 -> {
>             val result = continuation.result
>             continuation.resume(result)
>         }
>     }
> }
> ```
> 
> ## Practical Example
> 
> ```kotlin
> // Launch 10,000 coroutines (impossible with threads)
> repeat(10_000) {
>     launch {
>         delay(1000)  // Suspends, doesn't block
>         println("Coroutine $it done")
>     }
> }
> // All complete in ~1 second using maybe 1-2 threads
> ```
> 
> ## Key Takeaway
> 
> **`suspend` = "pause this coroutine, free up the thread for other work"**
> 
> This enables massive concurrency with minimal resources—the core power of coroutines.

| expected fact | grade | note |
| --- | --- | --- |
| Coroutines are lightweight: many of them can run on a few threads | present | Clearly stated in the table (cheap, kilobytes per coroutine, thousands/millions possible) and demonstrated in the practical example (10,000 coroutines on 1-2 threads) |
| A suspend function can pause without blocking the thread it runs on | present | Explicitly stated multiple times: 'pause execution and resume later without blocking the underlying thread', the delay example showing the thread continues running other coroutines, and the key takeaway |
| A suspend function can only be called from a coroutine or another suspend function | missing | This important restriction is not mentioned anywhere in the answer |

### With RAG — score 0.00, declined

1453 in · 133 out · 2.1 s · rank — · cited [1][3] · not in corpus

> The provided documents do not contain information about how Kotlin coroutines differ from threads or a detailed explanation of what the suspend keyword does.
> 
> The documents mention suspend functions in a few contexts—such as overload resolution improvements in Kotlin 2.2.20 [1] and a note about suspend function behavior changes in Kotlin 2.4 [3]—but they don't explain the fundamental differences between coroutines and threads or the mechanics of the suspend keyword itself.
> 
> To get a complete answer to your question, you would need additional resources that specifically cover Kotlin coroutines architecture and the suspend mechanism.

| expected fact | grade | note |
| --- | --- | --- |
| Coroutines are lightweight: many of them can run on a few threads | missing |  |
| A suspend function can pause without blocking the thread it runs on | missing |  |
| A suspend function can only be called from a coroutine or another suspend function | missing |  |

Retrieved chunks:

| n | score | source | section | text |
| ---: | ---: | --- | --- | --- |
| 1 | 0.504 | Kotlin 2.2.20 for Android Developers_ 5 Changes That Make Your Code Cleaner 🚀 _ by Jatin Gujjar _ Medium | 1. Smarter overload resolution with suspend function | 1. Smarter overload resolution with suspend function If you’ve ever had both a suspend and non suspend overload of the same function, you know how confusing it is, because compiler starts to show amb… |
| 2 | 0.421 | Kotlin 1.9.20 _ Medium | 2. Concurrent Programming Enhancements: › Task API: | 2. Concurrent Programming Enhancements: Task API: Kotlin 1.9.20 brings improvements to concurrent programming through the introduction of the Task API. This API provides a structured way to express … |
| 3 | 0.420 | Kotlin 2.4 vs Kotlin 2.3_ What Actually Changed_ _ Medium | Should You Upgrade Right Now? | Should You Upgrade Right Now? - First things first: check for Gradle compatibility and update Android Studio — 2.4 requires Gradle 9.5.0+ - Rewriting all your code in full to use context parameters … |
| 4 | 0.410 | Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium | Main Features | Main Features Kotlin 2.0.20 boasts concurrent marking for the garbage collector, which allows the marking phase to run simultaneously with application threads. This should significantly shorten GC pa… |
| 5 | 0.407 | Exploring Kotlin 2.1.0_ New Features _ by youssef moti _ Medium | 2. Non-Local break and continue | 2. Non-Local break and continue Before Kotlin 2.1.0: Developers used labels to handle complex loops in lambdas, leading to verbose and less readable code. fun processList(elements: List<Int>): Boole… |

## q10

**unanswerable** — What were the headline features of Compose Multiplatform 1.9.0?

*Why:* The corpus has release posts for 1.7.0, 1.8.0, 1.10.0 and 1.12.0 but not 1.9.0, so retrieval will bring neighbouring releases. RAG should say the documents do not cover it instead of borrowing 1.8 or 1.10 features. Plain mode will probably answer from memory; record that.

Expected sources: none

### Without RAG — score 1.00, declined

61 in · 185 out · 2.0 s

> # Compose Multiplatform 1.9.0 Headline Features
> 
> I don't have specific information about Compose Multiplatform 1.9.0's release notes in my training data. To get accurate details about this release, I'd recommend:
> 
> 1. **Official JetBrains Blog** - Check the Kotlin blog at blog.jetbrains.com
> 2. **GitHub Releases** - Visit the [Compose Multiplatform GitHub repository](https://github.com/JetBrains/compose-multiplatform)
> 3. **Release Notes** - Look for the official release notes on the JetBrains website
> 
> If you can share what you're trying to accomplish with Compose Multiplatform, I'd be happy to help with general questions about the framework or point you toward relevant resources.

| expected fact | grade | note |
| --- | --- | --- |
| Says the available information does not cover Compose Multiplatform 1.9.0 | present | Answer explicitly states 'I don't have specific information about Compose Multiplatform 1.9.0's release notes in my training data' |
| Does not present a list of 1.9.0 features as fact | present | No features are listed as facts; instead, the answer declines and points to resources |

### With RAG — score 1.00, declined

1456 in · 67 out · 1.2 s · rank — · cited nothing · pass

> The provided documents do not contain information about Compose Multiplatform 1.9.0. The documents cover versions 1.7.0, 1.8.0, and 1.10.0, but version 1.9.0 is not mentioned in any of them.

| expected fact | grade | note |
| --- | --- | --- |
| Says the available information does not cover Compose Multiplatform 1.9.0 | present | The answer explicitly states 'The provided documents do not contain information about Compose Multiplatform 1.9.0' |
| Does not present a list of 1.9.0 features as fact | present | The answer does not provide any features for version 1.9.0; it only explains what versions are covered |

Retrieved chunks:

| n | score | source | section | text |
| ---: | ---: | --- | --- | --- |
| 1 | 0.624 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog | Development tools that boost your efficiency | Development tools that boost your efficiency To make building Compose Multiplatform apps faster, smoother, and more enjoyable, we’re actively improving the KMP tooling. A new KMP plugin is coming soo… |
| 2 | 0.622 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.10.0: Unified @Preview, Navigation 3, and Stable Compose Hot Reload Compose Multiplatform 1.10.0 has been released! We’re continually developing our m… |
| 3 | 0.611 | Compose Multiplatform 1.7.0 Released - The JetBrains Blog |  | Multiplatform Releases Compose Multiplatform 1.7.0 Released Compose Multiplatform is a declarative UI framework built by JetBrains that allows developers to share UI implementations across differen… |
| 4 | 0.602 | Compose Multiplatform 1.10.0_ Unified @Preview, Navigation 3, and Stable Compose Hot Reload - The JetBrains Blog | Compose Hot Reload | Compose Hot Reload Compose Hot Reload is designed to speed up UI iteration by letting you instantly see changes without restarting the application: The Compose Hot Reload plugin is now stable – chec… |
| 5 | 0.598 | Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog |  | Multiplatform Compose Multiplatform 1.8.0 Released: Compose Multiplatform for iOS Is Stable and Production-Ready Today marks a major milestone in the Kotlin Multiplatform journey: the release of Com… |

## Appendix: the RAG user message for q01

Built by `buildRagPrompt(question, chunks)` in `src/rag/prompt.js`.

````text
<documents>
<doc n="1" source="knowledge_database/Compose Multiplatform 1.7.0 Released - The JetBrains Blog.html" section="Performance improvements on iOS" title="Compose Multiplatform 1.7.0 Released">
Performance improvements on iOS

In Kotlin 2.0.20, the Kotlin/Native team contributed significantly to making Compose apps on iOS perform faster and smoother. The Compose Multiplatform 1.7.0 release makes the best of these optimizations, along with performance improvements from Jetpack Compose 1.7.0.

We benchmarked Compose Multiplatform 1.6.11 paired with Kotlin 2.0.0 and Compose Multiplatform 1.7.0 paired with Kotlin 2.0.20, and the comparison shows the following improvements:

- The LazyGrid benchmark simulates LazyVerticalGrid scrolling, which is closest to real-life use cases, and performs ~9% faster on average. It also shows a significantly reduced number of missed frames. Take a look at the p1/p50 percentile graph below: It shows increased frame stability and confirms that there are now hardly any missed frames, as the average processing time is less than the standard 8.33 ms latency of a 120Hz iPhone screen.

- The VisualEffects benchmark renders many randomly placed components and works 3.6 times faster – the average CPU time per 1000 frames was reduced from 8.8 to 2.4 seconds.

- The AnimatedVisibility composable animates showing and hiding an image and demonstrates ~6% faster rendering.

Feel free to test it yourself and let us know whether your iOS app feels smoother!

On top of that, Kotlin 2.0.20 introduces experimental support for concurrent marking in the garbage collector (GC). Enabling concurrent marking shortens GC pauses and demonstrates even bigger improvements for all benchmarks. We measured only half as many missed frames as before, as well as a drop in the worst p25 GC pause time from 1.7 ms to 0.4 ms for the LazyGrid benchmark. Give it a try and share your feedback.

Update to Compose Multiplatform 1.7.0
</doc>
<doc n="2" source="knowledge_database/Compose Multiplatform 1.7.0 Released - The JetBrains Blog.html" section="" title="Compose Multiplatform 1.7.0 Released">
Multiplatform

Releases

Compose Multiplatform 1.7.0 Released

Compose Multiplatform is a declarative UI framework built by JetBrains that allows developers to share UI implementations across different platforms. The 1.7.0 release brings more components to common code, support for type-safe navigation, significant performance improvements on iOS, and changes from the latest Jetpack Compose update.

Here are the highlights of this release:

- Material3 adaptive and WindowSizeClass are now available in common code.

- Compose Multiplatform now provides compile-time safety for your navigation graph.

- Compose Multiplatform 1.7.0 paired with Kotlin 2.0.20 performs significantly faster and smoother on iOS than the combination of previous stable releases.

For the complete list of changes, refer to our What’s New page or release notes on GitHub.

Get Started with Compose Multiplatform
</doc>
<doc n="3" source="knowledge_database/Kotlin 2.4.20 Release_ What's New &amp; Why It Matters (2026) _ Medium.html" section="What Actually Changed › 2. Compose Multiplatform Gets Serious" title="Kotlin 2.3 Is Making Multiplatform Development Actually Work">
2. Compose Multiplatform Gets Serious

Multiplatform Jetpack Compose was also promising but also buggy. Compose for iOS is stabilized in Kotlin 2.3 with improvements performance wise that makes it usable:

- 60fps animations on older iPhones

- Native-feeling navigation without custom wrappers

- Non-memory leaking lifecycle handling

@Composable
fun ProfileScreen(viewModel: ProfileViewModel) {
    val state by viewModel.state.collectAsState()
    LazyColumn(
        modifier = Modifier.fillMaxSize()
    ) {
        item {
            ProfileHeader(
                user = state.user,
                onEditClick = { viewModel.editProfile() }
            )
        }
        items(state.posts) { post ->
            PostCard(post = post)
        }
    }
}

This will render the same on Android or iOS and without any platform check or conditional imports.
</doc>
<doc n="4" source="knowledge_database/Compose Multiplatform 1.8.0 Released_ Compose Multiplatform for iOS Is Stable and Production-Ready - The JetBrains Blog.html" section="Performance that’s ready for production" title="Compose Multiplatform 1.8.0 Released: Compose Multiplatform for iOS Is Stable and Production-Ready">
Performance that’s ready for production

A great user experience comes down to more than just UI behavior; it’s about performance, too. Smooth, responsive interactions are key to user satisfaction. That’s why performance was a core focus throughout this stabilization effort. With 1.8.0:

- Startup time is comparable to native apps, so your first frame arrives just as fast.

- Scrolling performance is on par with SwiftUI, even on high-refresh-rate devices.

- Compose Multiplatform adds only ~9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets.

You can find the benchmark project on GitHub. A detailed description of the methodology will be published soon at KMP Development portal.

And most importantly, this matches what developers are seeing in practice. According to our latest survey, over 96% of teams using Compose Multiplatform on iOS report no major performance concerns.
</doc>
<doc n="5" source="knowledge_database/Kotlin 2.0.20_ Major Update Brings Performance Improvements and Bug Fixes — Tech News _ by Olena Chyrkova _ Major Digest _ Medium.html" section="Main Features" title="Kotlin 2.0.20: Major Update Brings Performance Improvements and Bug Fixes — Tech News">
Main Features

Kotlin 2.0.20 boasts concurrent marking for the garbage collector, which allows the marking phase to run simultaneously with application threads. This should significantly shorten GC pause times and improve overall application responsiveness.
</doc>
</documents>

Question: After moving to Compose Multiplatform 1.7 with Kotlin 2.0.20, how much faster did iOS rendering get in JetBrains' benchmarks, and did GC pauses improve too?
````
