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
