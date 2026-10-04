*Hand-written from the run of 2026-10-04 (q8, 768 dims, 944 fixed / 958 structural chunks). If the numbers above have moved since then, trust the tables.*

**Sample size first.** There are 20 questions, so one question is worth 5 points. Structural's
+15 points at hit@1 is 3 questions, and the hit@5 tie means both strategies found the same
16 answers somewhere in their top 5. The difference is in **ranking**, not **recall**:
structural put the answer first more often (MRR 0.74 vs 0.65). Neither strategy found an
answer the other missed completely.

**Where structural wins: answers that sit inside one section, read better alone.**
- `kb-cmp-ios-stable`: the answer is in the 1.8.0 post's opening paragraph. Structural
  embeds that intro as its own 97-token chunk and ranks it 1st. Fixed packs the same
  paragraph into a 300-token window with the bullet list that follows, and ranks it 5th,
  behind four other windows of the same post.
- `kb-karma-replacement`: structural's chunk is the whole "Testing Gets a Long-Overdue
  Refresh" section (87 tokens) and comes 1st with a wide margin (0.70 vs 0.51 for the
  next one). Fixed's top window is in that section too, but it starts just *after* the
  Playwright sentence. The sentence fell at the end of the previous window, which
  starts back in "Explicit Context Arguments" and ranks 2nd.
- `pdf-encoder-layers`: the same thing happens in the paper. Fixed's 1st window starts at
  "Each layer has two sub-layers", one sentence after "The encoder is composed of a
  stack of N = 6". The window that holds the answer begins in "2 Background" and comes
  2nd. Structural's "3.1 Encoder and Decoder Stacks" chunk starts at the heading and
  comes 1st.

These match the stats. 81% of fixed chunks start or end mid-sentence, and 44% mix two
sections. A 300-token window that is half about something else gets a blurrier vector.
Structural chunks follow the author's boundaries: 0% mid-sentence by construction, and
the 12% multi-section chunks are the merged tiny sections.

**Where fixed wins: an answer split across a heading boundary.**
- `kb-shipaton-prize`: the prize sentence opens the "What you can win" section, and the
  question says "RevenueCat hackathon", which is in the post's intro. Fixed's window
  spans intro and prize together and ranks 1st. Structural keeps them in separate
  chunks, and its "What you can win" chunk (338 tokens, mostly about other prizes and a
  testimonial) ranks 2nd.

**What both miss: the READMEs, crowded out by code.** All three README questions and
`code-stale-run` miss the top 5 in both strategies. Code is 226 of 271 estimated pages,
and for "how do I log in to Notion" or "what happens after a run fails" the code that
*implements* the answer (`server.js › panelContext`, `pipeline/repair.js › repairer`)
outscores the README sentence that *states* it. Structural still ranks the expected
chunk much higher in every one of these cases: at k = 2000, the README answers come in
at 10 / 6 / 8 for structural vs 13 / 9 / 35 for fixed, and `code-stale-run` at 16 vs 62
(the `STALE_AFTER_MS` declaration is a 73-token structural chunk, but only a slice of a
300-token fixed window over the imports). This is a corpus-balance problem more than a
chunking one. A later day could test a per-collection filter, or the breadcrumb in the
embedded text.

**Cost.** Structural embeds 18% fewer tokens (224k vs 274k: fixed repeats 50 tokens of
overlap per window) but took longer (395 s vs 247 s). The likely cause is that its sizes
vary from 4 to 500 tokens. Each batch of 16 is padded to its longest chunk, and attention
cost grows faster than linearly with length, while fixed's batches are uniform 300s.
This wasn't measured separately. Sorting chunks by length before batching would test it.

**Bottom line for this corpus.** Use structural as the default for retrieval: same recall,
better first hit, and chunks that read as whole sections when shown to a model. Fixed is
the safer choice only for answers that straddle a heading. The biggest remaining loss is
on neither strategy: the corpus mix lets code drown out the prose that explains it.
