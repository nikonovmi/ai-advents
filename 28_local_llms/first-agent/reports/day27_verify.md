# Day 27 — verify:local

Run 2026-10-11 14:00 UTC on Apple M2, 16 GB RAM; Ollama 0.40.2 at http://localhost:11434.
The app's routes ran in-process (`createApp`) with an in-memory store, **no ANTHROPIC_API_KEY**, and a fetch guard on every non-localhost host. num_ctx 8192, num_predict ≤ 1024, think false. Each model was warmed up (not counted) and unloaded after.

**Result: PASS** · outbound non-localhost requests: **0** · localhost requests: 40

## Per model

| model | checks | context kept | mean TTFT | mean generation | mean model latency | mean turn latency | cold load | outbound non-localhost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `gemma4:12b` | 20/20 | 2/2 | 4.37 s | 11.4 tok/s | 17.62 s | 38.23 s | 6.82 s | 0 |
| `qwen3.5:9b` | 20/20 | 2/2 | 3.16 s | 15.4 tok/s | 9.23 s | 21.43 s | 6.45 s | 0 |

TTFT ≈ load + prompt evaluation (Ollama's timings; the call is non-streaming). Model latency = Ollama's `total_duration` for the reply call. Turn latency = the whole `POST /chat`, which for first-agent also includes the memory extractor's call (and a digest fold when one is due), all on the same local model.

Checks per reply: HTTP 200, `provider: local` with the expected model, non-empty. On the last message of each conversation, also: the reply contains the facts from the first message.

## `gemma4:12b`

### first-agent (memory chat)

Stored on the record: `llm: local:gemma4:12b`, 3/3 replies with `provider: local`. Context check: /\bmira\b/i, /lisbon/i, /\b(five|5)\b/i.

**1. User:** Hi! I'm Mira, and I'm planning a five-day trip to Lisbon in May.

````text
Hi Mira! I'd love to help you plan your trip to Lisbon.

To make sure I build the right itinerary for you, I need a bit more information:

1. What is your preferred pace? (e.g., packed with sightseeing, relaxed and leisurely, or a mix?)
2. Do you have any specific interests, such as food/wine, history, nightlife, or day trips to nearby places like Sintra?

**Assumptions:**
* I will assume a moderate budget unless you specify otherwise.
* I will assume you are interested in both the historic Alfama/Baixa areas and the trendy neighborhoods like Bairro Alto.
````

✓ · local · `gemma4:12b` · TTFT 7.85 s · 10.8 tok/s · model 20.48 s · turn 77.83 s · 513 prompt / 136 output tokens · +1 memory call(s)

**2. User:** Suggest two neighbourhoods to stay in there, one line each.

````text
**Alfama** is perfect for a traditional, historic experience with narrow streets and easy access to the water.

**Bairro Alto** is ideal if you prefer a vibrant atmosphere with many bars and a lively nightlife scene.
````

✓ · local · `gemma4:12b` · TTFT 3.52 s · 11.8 tok/s · model 7.33 s · turn 67.52 s · 683 prompt / 45 output tokens · +1 memory call(s)

**3. User:** Remind me: what's my name, which city am I visiting, and for how many days?

````text
Your name is Mira, you are visiting Lisbon, and your trip is for five days.
````

✓ · local · `gemma4:12b` · TTFT 1.52 s · 11.3 tok/s · model 3.12 s · turn 9.21 s · 760 prompt / 18 output tokens · +1 memory call(s)

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
You have two main choices for how to handle the user interface:
1.  **Compose Multiplatform:** You write your UI in Kotlin for *both* platforms. This is the fastest way to develop if you want a consistent look.
2.  **Native UI:** You write the UI in **Jetpack Compose** (Android) and **SwiftUI** (iOS), but they both call the same shared logic. This is better if you need very specific, platform-native behaviors.

### 4. Pro-Tips for Success
*   **Expect/Actual:** This is the core mechanism of KMP. Use it when you need to access platform-specific APIs (like getting the device's battery level or unique ID).
*   **Keep Logic Pure:** Try to keep as much as possible in the `commonMain` source set. The more code you can write without using `expect/actual`, the easier your life will be.
*   **Use a Good IDE:** Ensure you have **Android Studio** installed and the **Kotlin Multiplatform Mobile** plugin configured.

**How can I help you specifically today?**
*   Are you looking for help setting up the initial project structure?
*   Do you need help choosing a specific library for a feature (like authentication or local storage)?
*   Are you stuck on a specific `expect/actual` implementation?
````

✓ · local · `gemma4:12b` · TTFT 1.03 s · 12.1 tok/s · model 53.09 s · turn 53.12 s · 69 prompt / 630 output tokens

**2. User:** Which library would you use for HTTP networking in it? One short paragraph.

````text
I would recommend **Ktor** because it is the industry standard for Kotlin Multiplatform. It is developed by JetBrains, provides a multiplatform-first approach, and integrates seamlessly with **Kotlinx.serialization** for handling JSON data. It allows you to write your networking logic once in the `commonMain` source set while automatically handling the underlying platform-specific engines (like OkHttp for Android and Darwin for iOS).
````

✓ · local · `gemma4:12b` · TTFT 10.16 s · 11.0 tok/s · model 17.87 s · turn 17.89 s · 724 prompt / 85 output tokens

**3. User:** What's my app called, and which two platforms does it target?

````text
Your app is called **Tidepool**, and it targets **Android** and **iOS**.
````

✓ · local · `gemma4:12b` · TTFT 2.11 s · 11.3 tok/s · model 3.82 s · turn 3.83 s · 834 prompt / 19 output tokens

## `qwen3.5:9b`

### first-agent (memory chat)

Stored on the record: `llm: local:qwen3.5:9b`, 3/3 replies with `provider: local`. Context check: /\bmira\b/i, /lisbon/i, /\b(five|5)\b/i.

**1. User:** Hi! I'm Mira, and I'm planning a five-day trip to Lisbon in May.

````text
Hi Mira! That sounds like a wonderful plan. Lisbon in May is perfect for exploring.

To get started on your itinerary, could you tell me:
1. **Do you prefer a mix of sightseeing, food, and culture, or are you leaning more towards relaxation?**
2. **Will this be a solo trip, with a partner, or a group?**

Once I have those details, I can start sketching out a day-by-day plan for you!
````

✓ · local · `qwen3.5:9b` · TTFT 5.15 s · 15.1 tok/s · model 11.56 s · turn 45.41 s · 486 prompt / 97 output tokens · +1 memory call(s)

**2. User:** Suggest two neighbourhoods to stay in there, one line each.

````text
Here are two great options:
*   **Bairro Alto:** Perfect for nightlife and vibrant energy, though it gets very crowded on weekends.
*   **Alfama:** Ideal for history and quiet mornings, but expect narrow, winding streets.

Everything's clear — we can switch to execution now. Or add more details if you want to refine it first.
````

✓ · local · `qwen3.5:9b` · TTFT 1.29 s · 15.4 tok/s · model 6.17 s · turn 39.55 s · 607 prompt / 75 output tokens · +1 memory call(s)

**3. User:** Remind me: what's my name, which city am I visiting, and for how many days?

````text
*   **Name:** Mira
*   **City:** Lisbon
*   **Duration:** 5 days
````

✓ · local · `qwen3.5:9b` · TTFT 7.39 s · 15.3 tok/s · model 8.83 s · turn 14.74 s · 724 prompt / 22 output tokens · +1 memory call(s)

### Knowledge, Without RAG

Stored on the record: `llm: local:qwen3.5:9b`, 3/3 replies with `provider: local`. Context check: /tidepool/i, /android/i, /\bios\b/i.

**1. User:** I'm building a Kotlin Multiplatform app called Tidepool that targets Android and iOS.

````text
That sounds like an exciting project! Building a **Kotlin Multiplatform (KMP)** app named **Tidepool** for both Android and iOS is a great choice, as it allows you to share up to 90% of your business logic while maintaining native UIs.

To help you get started or solve specific challenges, here are a few common areas where KMP shines:

*   **Shared Code**: You can write core features (like data models, networking, and business logic) in Kotlin that run on both platforms.
*   **UI Strategy**: Since you're targeting native Android and iOS, you likely have separate UI codebases (Jetpack Compose for Android, SwiftUI or UIKit for iOS), while sharing the underlying logic.
*   **Dependencies**: Managing shared libraries with Gradle (Android) and CocoaPods/Carthage (iOS).

**How can I assist you?**
*   Do you need help setting up the project structure?
*   Are you looking for best practices on how to share specific modules (e.g., Room database, Retrofit networking)?
*   Do you have questions about handling platform-specific differences?
````

✓ · local · `qwen3.5:9b` · TTFT 0.66 s · 15.3 tok/s · model 16.11 s · turn 16.14 s · 68 prompt / 237 output tokens

**2. User:** Which library would you use for HTTP networking in it? One short paragraph.

````text
For a Kotlin Multiplatform app targeting both Android and iOS, **Ktor** is the most widely recommended choice because it offers a single, unified API that works seamlessly across all platforms without requiring platform-specific wrappers. While **OkHttp** is excellent for Android, it lacks native iOS support, and **URLSession** is native to iOS but not Kotlin Multiplatform; Ktor bridges this gap by providing a consistent client implementation (often using OkHttp on Android and URLSession on iOS internally) that lets you write one networking layer for the entire app.
````

✓ · local · `qwen3.5:9b` · TTFT 2.91 s · 15.5 tok/s · model 9.95 s · turn 9.96 s · 330 prompt / 109 output tokens

**3. User:** What's my app called, and which two platforms does it target?

````text
Your app is called **Tidepool**, and it targets **Android** and **iOS**.
````

✓ · local · `qwen3.5:9b` · TTFT 1.56 s · 15.9 tok/s · model 2.76 s · turn 2.77 s · 463 prompt / 19 output tokens
