# verify:local (Day 27, with Day 28's local RAG)

Run 2026-10-11 15:54 UTC on Apple M2, 16 GB RAM; Ollama 0.40.2 at http://localhost:11434.
The app's routes ran in-process (`createApp`) with an in-memory store, **no ANTHROPIC_API_KEY**, and a fetch guard on every non-localhost host. num_ctx 8192, num_predict ≤ 1024, think false. Each model was warmed up (not counted) and unloaded after.

**Result: FAIL** · outbound non-localhost requests: **0** · calls to the Claude provider: **0** · localhost requests: 61

Day 28: the Knowledge **With RAG** chat runs rag+rerank — EmbeddingGemma search and bge-reranker on this machine, then the router, `submit_answer` and any clarification on the local model as JSON-schema calls with num_ctx 16384 (LOCAL_RAG_NUM_CTX). Its third message says only "CMP", defined in the second: the router has to read it back from the task memory.

## Per model

| model | checks | context kept | mean TTFT | mean generation | mean model latency | mean turn latency | cold load | outbound non-localhost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `gemma4:12b` | 41/42 | 3/3 | 16.66 s | 11.0 tok/s | 35.35 s | 90.05 s | 6.72 s | 0 |
| `qwen3.5:9b` | 39/41 | 2/3 | 8.94 s | 14.2 tok/s | 21.51 s | 34.59 s | 6.24 s | 0 |

TTFT ≈ load + prompt evaluation (Ollama's timings; the call is non-streaming). Model latency = Ollama's `total_duration` for the reply call. Turn latency = the whole `POST /chat`, which for first-agent also includes the memory extractor's call (and a digest fold when one is due), all on the same local model.

Checks per reply: HTTP 200, `provider: local` with the expected model, non-empty. On the last message of each Day 27 conversation, also: the reply contains the facts from the first message.
RAG chat, per reply: the router ran locally (`routerProvider: local`), the Claude provider was not called, no possible truncation; a search reply is `answered` with ≥ 1 citation that passed verification and was not downgraded; on the last message, the standalone question says "Compose Multiplatform" and the task memory holds the CMP term.

## `gemma4:12b`

### first-agent (memory chat)

Stored on the record: `llm: local:gemma4:12b`, 3/3 replies with `provider: local`. Context check: /\bmira\b/i, /lisbon/i, /\b(five|5)\b/i.

**1. User:** Hi! I'm Mira, and I'm planning a five-day trip to Lisbon in May.

````text
It's nice to meet you, Mira! I'm ready to help you plan your trip.

To make sure the itinerary fits your preferences, I need a bit more information:

1. What is your preferred pace for the trip (e.g., packed with sightseeing, relaxed and slow-paced, or a mix)?
2. Are there any specific interests you'd like to prioritize (e.g., food/gastronomy, history/museums, nightlife, or coastal scenery)?

I am assuming you will be staying within the city of Lisbon and its immediate surroundings unless you specify otherwise.
````

✓ · local · `gemma4:12b` · TTFT 7.80 s · 10.6 tok/s · model 19.75 s · turn 77.22 s · 513 prompt / 126 output tokens · +1 memory call(s)

**2. User:** Suggest two neighbourhoods to stay in there, one line each.

````text
Chiado is a central hub known for its elegant boutiques, historic architecture, and easy access to major landmarks.

Alfama is a traditional, atmospheric neighborhood perfect for those who want a slower pace and a more authentic, old-world feel.
````

✓ · local · `gemma4:12b` · TTFT 6.39 s · 9.1 tok/s · model 11.76 s · turn 69.60 s · 878 prompt / 49 output tokens · +1 memory call(s)

**3. User:** Remind me: what's my name, which city am I visiting, and for how many days?

````text
Your name is Mira, you are visiting Lisbon, and you are staying for five days.
````

✓ · local · `gemma4:12b` · TTFT 1.54 s · 11.5 tok/s · model 3.11 s · turn 9.59 s · 959 prompt / 18 output tokens · +1 memory call(s)

### Knowledge, Without RAG

Stored on the record: `llm: local:gemma4:12b`, 3/3 replies with `provider: local`. Context check: /tidepool/i, /android/i, /\bios\b/i.

**1. User:** I'm building a Kotlin Multiplatform app called Tidepool that targets Android and iOS.

````text
That sounds like an exciting project! Building a Kotlin Multiplatform (KMP) app is a great way to share logic while maintaining a native feel on both Android and iOS.

Since you are starting out with **Tidepool**, here is a quick roadmap of the core concepts and tools you will likely be interacting with:

### 1. The Core Architecture
In a KMP project, your code is typically divided into three layers:
*   **Shared Module:** This is where your "Source of Truth" lives. It contains the business logic, data models, networking (Ktor), and database (SQLDelight).
*   **Android App:** A standard Android project using Jetpack Compose.
*   **iOS App:** A native project (Swift/SwiftUI) that consumes the shared logic.

### 2. Key Technologies to Use
To make Tidepool successful, you will likely want to use these industry-standard KMP libraries:
*   **Networking:** [Ktor](https://ktor.io/) (The standard for making API calls).
*   **Database:** [SQLDelight](https://sqldelight.github.io/) (Type-safe SQL database).
*   **Dependency Injection:** [Koin](https://insert-koin.io/) (Very popular in the KMP ecosystem).
*   **Serialization:** [Kotlinx.serialization](https://github.com/Kotlin/kotlinx.serialization) (For converting JSON to Kotlin objects).
*   **Image Loading:** [Coil3](https://coil-dev.com/) (Now supports KMP).

### 3. UI Strategy
You have two main paths for the user interface:
1.  **Compose Multiplatform (Recommended):** You write your UI in Jetpack Compose, and it renders natively on both Android and iOS. This allows for maximum code sharing.
2.  **Native UI:** You write the UI separately in **Jetpack Compose** (Android) and **SwiftUI** (iOS), but they both call the same shared logic.

### 4. Pro-Tips for Success
*   **Expect/Actual:** This is the core mechanism of KMP. Use it when you need to access platform-specific APIs (like getting the device's battery level or unique ID).
*   **Keep Logic Pure:** Try to keep as much as possible in "Pure Kotlin." The more code you can write without using `expect/actual`, the easier your app will be to maintain.
*   **Use a Repository Pattern:** Ensure your UI doesn't talk directly to the database or network. Use a Repository layer to handle data fetching and caching.

**How can I help you specifically today?**
*   Are you looking for help setting up the **project structure**?
*   Do you need help choosing a **database** or **networking** library?
*   Are you trying to solve a specific **bug** or **platform-specific** issue?
````

✓ · local · `gemma4:12b` · TTFT 1.03 s · 12.5 tok/s · model 50.79 s · turn 50.81 s · 69 prompt / 624 output tokens

**2. User:** Which library would you use for HTTP networking in it? One short paragraph.

````text
I recommend using **Ktor** because it is the industry standard for Kotlin Multiplatform. It is developed by JetBrains, provides a multiplatform-first approach, and integrates seamlessly with **Kotlinx.serialization** for handling JSON data. It allows you to write your networking logic once in the shared module while automatically handling the underlying platform-specific engines (like OkHttp for Android and Darwin for iOS).
````

✓ · local · `gemma4:12b` · TTFT 10.21 s · 11.5 tok/s · model 17.27 s · turn 17.28 s · 718 prompt / 81 output tokens

**3. User:** What's my app called, and which two platforms does it target?

````text
Your app is called **Tidepool**, and it targets **Android** and **iOS**.
````

✓ · local · `gemma4:12b` · TTFT 2.01 s · 13.0 tok/s · model 3.49 s · turn 3.50 s · 824 prompt / 19 output tokens

### Knowledge, With RAG (rag+rerank) — Day 28

Stored on the record: `llm: local:gemma4:12b`, 3/3 replies with `provider: local`. Context check: /\bCMP\b/, /compose multiplatform/i.

**1. User:** We're deciding whether to build our iOS app's UI with Compose Multiplatform instead of SwiftUI. To start: is Compose Multiplatform for iOS actually stable now?

````text
Yes, Compose Multiplatform for iOS is Stable [c1]. The release of Compose Multiplatform 1.8.0 brings Compose for iOS to Stable [c3]. Version 1.8.0 finalizes the core API surface and all major APIs are now officially stable, with strong compatibility guarantees and minimal breaking changes expected in the future [c2].
````

✓ · local · `gemma4:12b` · TTFT 36.48 s · 13.2 tok/s · model 101.58 s · turn 248.07 s · 5098 prompt / 751 output tokens

Router (local): **search** → "We're deciding whether to build our iOS app's UI with Compose Multiplatform instead of SwiftUI. To start: is Compose Multiplatform for iOS actually stable now?" · 138.31 s · rag+rerank · retrieval 2.16 s · rerank 5.63 s · answered · 3 citation(s) · retried → verified

- [c1] "Compose Multiplatform for iOS is Stable." — `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:5`
- [c3] "Today marks a major milestone in the Kotlin Multiplatform journey: the release of Compose Multiplatform 1.8.0, which brings Compose for iOS to Stable." — `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:0`
- [c2] "Version 1.8.0 finalizes the core API surface and brings targeted improvements to accessibility and navigation, along with a wide range of bug fixes and performance improvements (see the details in the 1.8.0 What’s New). All major APIs are now officially stable, with strong compatibility guarantees and minimal breaking changes expected in the future." — `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:1`

Task memory after: goal null · constraints []

**2. User:** From now on, keep every answer to at most 3 sentences. And when I write CMP, I mean Compose Multiplatform.

````text
I don't know. I understand that you would like me to limit my responses to a maximum of three sentences and that CMP refers to Compose Multiplatform. Could you please provide a question regarding CMP or any other topic you would like me to address?
````

✗ failed: verifiedCitations · local · `gemma4:12b` · TTFT 42.85 s · 7.1 tok/s · model 52.67 s · turn 238.18 s · 2428 prompt / 69 output tokens

Router (local): **search** → "From now on, keep every answer to at most 3 sentences. And when I write CMP, I mean Compose Multiplatform." · 175.44 s · rag+rerank · retrieval 5.48 s · rerank 4.45 s · dont_know · 0 citation(s) · verified

Task memory after: goal null · constraints []

**3. User:** How much does CMP add to the app size compared with a pure SwiftUI app?

````text
Compose Multiplatform adds only about 9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets [c1].
````

✓ · local · `gemma4:12b` · TTFT 41.64 s · 10.4 tok/s · model 57.74 s · turn 96.22 s · 2840 prompt / 167 output tokens

Router (local): **search** → "How much does Compose Multiplatform add to the app size compared with a pure SwiftUI app?" · 30.46 s · rag+rerank · retrieval 3.06 s · rerank 4.84 s · answered · 1 citation(s) · verified

- [c1] "Compose Multiplatform adds only ~9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets." — `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:3`

Task memory after: goal "Determine if Compose Multiplatform is a viable alternative to SwiftUI for the iOS app's UI." · constraints ["answers at most 3 sentences","'CMP' = Compose Multiplatform"]

## `qwen3.5:9b`

### first-agent (memory chat)

Stored on the record: `llm: local:qwen3.5:9b`, 3/3 replies with `provider: local`. Context check: /\bmira\b/i, /lisbon/i, /\b(five|5)\b/i.

**1. User:** Hi! I'm Mira, and I'm planning a five-day trip to Lisbon in May.

````text
Hi Mira! That sounds like a great plan. To make sure the itinerary fits your style, could you clarify:

1.  **Travel style:** Are you looking for a relaxed pace with lots of downtime, or do you prefer a packed schedule with many activities?
2.  **Specific interests:** Do you have a preference for history (castles, museums), food/wine tours, beach time, or perhaps day trips to nearby areas like Sintra or Évora?

Once I know these two things, we can start building the plan!
````

✓ · local · `qwen3.5:9b` · TTFT 5.04 s · 15.2 tok/s · model 12.40 s · turn 46.26 s · 486 prompt / 112 output tokens · +1 memory call(s)

**2. User:** Suggest two neighbourhoods to stay in there, one line each.

````text
Based on your need for a mix of vibes:

*   **Alfama:** Choose this if you want historic charm, narrow streets, and authentic Fado music, though expect fewer modern amenities.
*   **Bairro Alto / Chiado:** Choose this for a lively atmosphere with great nightlife, shopping, and central location, perfect if you want to be in the middle of everything.
````

✓ · local · `qwen3.5:9b` · TTFT 1.56 s · 14.8 tok/s · model 6.99 s · turn 39.82 s · 622 prompt / 80 output tokens · +1 memory call(s)

**3. User:** Remind me: what's my name, which city am I visiting, and for how many days?

````text
*   **Name:** Mira
*   **City:** Lisbon
*   **Duration:** 5 days

Everything's clear — we can switch to execution now. Or add more details if you want to refine it first.
````

✓ · local · `qwen3.5:9b` · TTFT 7.55 s · 17.5 tok/s · model 10.19 s · turn 16.37 s · 744 prompt / 46 output tokens · +1 memory call(s)

### Knowledge, Without RAG

Stored on the record: `llm: local:qwen3.5:9b`, 3/3 replies with `provider: local`. Context check: /tidepool/i, /android/i, /\bios\b/i.

**1. User:** I'm building a Kotlin Multiplatform app called Tidepool that targets Android and iOS.

````text
That sounds like an exciting project! Building a **Kotlin Multiplatform (KMP)** app named **Tidepool** for both Android and iOS is a great choice, as it allows you to share up to 90% of your business logic while maintaining native UIs.

To help you get started or solve specific challenges, here are a few common areas where KMP shines:

*   **Shared Code**: You can write core features (like data models, networking, and business logic) in Kotlin that run on both platforms.
*   **UI Strategy**: Since you're targeting native Android and iOS, you likely have separate UI codebases (Jetpack Compose for Android, SwiftUI or UIKit for iOS), while sharing the underlying logic.
*   **Dependencies**: Managing shared libraries (like `kotlinx-coroutines`, `okhttp`, or database drivers) efficiently across platforms.

**How can I assist you?**
*   Do you need help setting up the project structure?
*   Are you looking for best practices on sharing code between Android and iOS?
*   Do you have a specific technical question about dependencies, testing, or deployment?
````

✓ · local · `qwen3.5:9b` · TTFT 0.65 s · 14.1 tok/s · model 17.62 s · turn 17.64 s · 68 prompt / 239 output tokens

**2. User:** Which library would you use for HTTP networking in it? One short paragraph.

````text
For a Kotlin Multiplatform app targeting both Android and iOS, **Ktor** is the most robust and widely adopted choice because it offers native support for both platforms with a single codebase, avoiding the need for platform-specific wrappers like Retrofit (Android-only) or URLSession (iOS-only). While **OkHttp** works on Android via KMP plugins, it lacks official iOS support, making Ktor the superior option for true cross-platform consistency and long-term maintainability.
````

✓ · local · `qwen3.5:9b` · TTFT 3.48 s · 11.5 tok/s · model 11.58 s · turn 11.61 s · 332 prompt / 93 output tokens

**3. User:** What's my app called, and which two platforms does it target?

````text
Your app is called **Tidepool**, and it targets **Android** and **iOS**.
````

✓ · local · `qwen3.5:9b` · TTFT 1.68 s · 11.4 tok/s · model 3.35 s · turn 3.36 s · 449 prompt / 19 output tokens

### Knowledge, With RAG (rag+rerank) — Day 28

Stored on the record: `llm: local:qwen3.5:9b`, 3/3 replies with `provider: local`. Context check: /\bCMP\b/, /compose multiplatform/i.

**1. User:** We're deciding whether to build our iOS app's UI with Compose Multiplatform instead of SwiftUI. To start: is Compose Multiplatform for iOS actually stable now?

````text
Yes, Compose Multiplatform for iOS is now stable and production-ready. The release of version 1.8.0 marks a major milestone where Compose for iOS reached stability status [c2].
````

✗ failed: verifiedCitations · local · `qwen3.5:9b` · TTFT 22.81 s · 14.6 tok/s · model 74.20 s · turn 103.19 s · 4916 prompt / 671 output tokens

Router (local): **search** → "Is Compose Multiplatform for iOS actually stable now, given that we are deciding whether to build our iOS app's UI with it instead of SwiftUI?" · 18.99 s · rag+rerank · retrieval 5.10 s · rerank 4.79 s · answered · 1 citation(s) · retried → verified

- [c2] "Today marks a major milestone in the Kotlin Multiplatform journey: the release of Compose Multiplatform 1.8.0, which brings Compose for iOS to Stable." — `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:0`

Task memory after: goal null · constraints []

**2. User:** From now on, keep every answer to at most 3 sentences. And when I write CMP, I mean Compose Multiplatform.

````text
Got it. Answers will be limited to 3 sentences, and 'CMP' will refer to Compose Multiplatform.
````

✓ · local · `qwen3.5:9b` · TTFT 11.14 s · 14.8 tok/s · model 19.03 s · turn 19.05 s · 1114 prompt / 117 output tokens

Router (local): **memory_only** · 19.03 s

Task memory after: goal null · constraints []

**3. User:** How much does CMP add to the app size compared with a pure SwiftUI app?

````text
Compose Multiplatform adds about ~9 MB to the size of an iOS app compared to a fully native SwiftUI app [c1]. This increase applies when using the same UI logic and assets in both frameworks [c1].
````

✗ failed: usesMemory · local · `qwen3.5:9b` · TTFT 26.56 s · 14.3 tok/s · model 38.22 s · turn 54.04 s · 2658 prompt / 166 output tokens

Router (local): **search** → "How much does Compose Multiplatform add to the app size compared with a pure SwiftUI app?" · 8.36 s · rag+rerank · retrieval 1.06 s · rerank 6.35 s · answered · 1 citation(s) · verified

- [c1] "Compose Multiplatform adds only ~9 MB to the size of an iOS app compared to a fully native SwiftUI app with the same UI logic and assets." — `kb/compose-multiplatform-1.8.0-released-compose-multiplatform-for-ios-is-stable-and-production-ready-the-jetbrains-blog.html:structural:3`

Task memory after: goal null · constraints []
