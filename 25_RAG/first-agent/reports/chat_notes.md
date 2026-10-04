**Short version.** The routing and the memory held up. Haiku labelled all 26 turns correctly,
both clarification loops closed, and every memory checkpoint passed (11/11) on the final run. That
includes the correction in scenario 2 and the change of direction, where the memory dropped the
old focus. Scenario 1 (deep dive) passed 12 of 13 turns. Scenario 2 (comparison) passed 5 of 13.
Its failures are almost all in the answers, not in the conversation machinery: one retrieval miss,
claims that go beyond their quotes, and a strict fact judge.

### Where the conversation slipped

- **Scenario 2, turn 4 ("And the other one?")** is the one real slip and the only false "I don't
  know". The router resolved the reference correctly: what the feature list says about upgrading
  now. Retrieval then kept only the feature list's *first* chunk, not its "Should You Upgrade
  Now?" section. The router's first query contained the article's title, and chunk text carries no
  title, so a title matches only the opening chunk. The model saw no upgrade advice and correctly
  asked whether the article has any. A router rule ("describe the content, not the title") fixed
  the same miss on turn 3 but not here. The fix would be in retrieval (the title in the chunk text
  or in the reranker's passage), which this spec leaves to Day 23.
- **Claims beyond their quotes.** The on-track check fails on any claim the Day 24 faithfulness
  judge calls *unsupported*. That accounts for 5 of the 9 failing turns, and every case is the
  same pattern: a closing sentence that editorialises ("This approach is stable and
  production-ready for both Android and iOS", "This is part of the stable foundation …") and
  cites a quote that only supports the first half. Mean faithfulness is 0.63 (scenario 1) and
  0.39 (scenario 2), against 0.86 on Day 24's single questions. A conversation with a goal
  pulls the model toward conclusions for the user, and it attaches a nearby citation to them.
  Turn 7 in scenario 2 is the worst case: the feature list's garbled sentence ("The 2.4.
  Automatic Package generation. x line improved Swift export") gets quoted as if it said
  something clear.
- **Facts (scenario 2: 5/9).** Two misses are real: turn 4 (above) and turn 7, where the
  comparison's 2.4 Swift-export line wasn't retrieved and the answer talked about 2.3's enums
  instead. The other two are 0.5 partials on wording ("puts context parameters *first*",
  "particularly impactful for KMP+iOS teams"), where the answers say the substance.
- **Judge noise, still visible.** On turns 9 and 11 of scenario 2 the on-track judge objects
  that the reply "doesn't cite the articles", meaning the two Kotlin articles from before the
  change of direction, or reads a roadmap answer as contradicting the previous turn. I read
  both replies as on topic. Earlier runs also showed the judges miscounting sentences and
  listing items as "stale" while their own note said to keep them. The memory judge now
  has to mark each stale item `must_remove`, and the on-track judge is given the mechanical
  sentence count and told not to judge length. That cleared those false failures.

### Did the clarification loop work?

Yes, both times, on the final run. Scenario 1, turn 6 ("How long would the migration take for
us?"): the model said "I don't know" and asked "gradual adoption approaches, or … app size or
complexity?". Code added it as `q6`. On turn 7 the router resolved `q6`, wrote the standalone
question with the clarification applied, and stored "by migration they mean gradual adoption,
not a complete rewrite". The answer then succeeded with the 1.8.0 post's one-screen-at-a-time
and interop facts. The off-topic sourdough question (turn 11) declined at the cutoff,
added `q11`, and the router dropped `q11` on turn 12 when the user went "back to our decision".
No code override was needed on the final run.

That last part was the main fix of the day. On the **first** run the router left two open
questions in place after the user moved on (scenario 2, turns 3–4). On turn 6 the spec's
override ("open question and not chat → search") turned a memory-only correction into a search
for "the old question + (clarification: Correction: we're not Android-only…)". The override did
what it says; the router simply never closed the questions. The router prompt now says that
every open question is resolved by the next non-chat message, answered or dropped. Since then,
no turn has been forced.

### Did memory keep and drop the right things?

- **Kept:** the goal, the 3-sentence limit and "CMP" survived all 13 turns of scenario 1. Turn
  12 ("how much bigger … compared with the other option we're considering?") needs message 1,
  which is outside the 6-message window by then. The router resolved it to
  "…with Compose Multiplatform compared with SwiftUI?" from the goal alone, and the answer
  (~9 MB, cited) passed every check.
- **Correction:** "we're not Android-only" removed `d2` and added `d6` ("a Kotlin Multiplatform
  team shipping to Android and iOS") in one patch. Turn 13, seven turns later, answered "for
  your Kotlin Multiplatform app shipping to Android and iOS" without the user restating it.
- **Change of direction:** turn 9 set the new goal and removed both article names (`k2`, `k2b`)
  while keeping the team detail. This was the least stable behaviour across runs. On one
  earlier run the router left the two names in place, and on another it removed and re-added
  the team detail. An example in the prompt ("names they gave to the articles of the old
  topic") settled it.
- **Never stored document facts:** no memory item in either scenario came from an answer.

### Did the Haiku router mislabel anything?

Not on the final run: 26/26. On the first run it labelled the off-topic sourdough question
`chat` and would have answered it from its own knowledge in `reply`. The prompt now says that
any question, off-topic included, is a search, and the router never answers questions in reply.
It costs about 1.8 s and ~2.3k input tokens per message, about a fifth of a search turn's 7–8 s.
Its one consistent quirk is that it always writes 2–3 queries even for a one-part question, and
sometimes keeps the user's abbreviation ("CMP") in one of them. This hasn't cost a retrieval.

### Cost

About $0.21 for the two conversations (150k input / 12k output tokens), plus $0.15 for the
judges. Latency: router 1.8 s, a search turn 7–8 s (mostly the reranker on CPU), a chat or
memory turn 1–4 s.
