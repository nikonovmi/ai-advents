# model-lab

https://github.com/user-attachments/assets/63ac387c-a2c4-4d34-8cf2-8d66c925d08a

Send one task to three Claude tiers — Haiku 4.5, Sonnet 5, Opus 5 — and put the results
side by side: latency, exact token counts, cost, and a **blind** quality ranking from a
fourth call that never sees which model wrote which answer.

## Results
The gap only appears where a task has a trap. Where the right answer is straightforward, all three tiers converge. Where it requires noticing something — an unsolvable premise, a silent side effect — the tiers separate, and the cheap tier's failure looks like a good answer rather than an obvious error.

Cost scales with how much a model thinks; quality doesn't. The rate card spread is 1:2:5, but observed cost ran up to ~16x — the extra is output tokens, mostly reasoning. On easy tasks that buys nothing: near-identical answers, ~16x the price.

## Setup

```bash
npm install
cp .env.example .env      # then paste your key into .env
npm start
```

Get a key at <https://console.anthropic.com/settings/keys>. The server reads
`ANTHROPIC_API_KEY` from the environment (via `.env`); it is never hardcoded.

Then open **<http://localhost:3000>**.

Pick a preset or type your own task, hit **Run**, and wait — one run is 3 streamed model
calls issued in parallel, plus 1 judge call once they land.

## How to read the results

**The timings are one sample each — treat them as indicative.** Each row is a single call,
so its latency is partly measuring the network between you and the API: a bad TCP
handshake or a moment of queueing lands in the number alongside the model's real speed.
Big gaps (a tier that is 5x slower) are signal; small ones are not, and they will not
reproduce run to run. Hit **Run** a few times before drawing a conclusion from a narrow
difference. The token and cost columns have no such problem — they come straight from the
API and are exact.

**The judge is blind.** The three answers are shuffled and relabelled A/B/C with no model
names attached before the ranking call goes out, and the labels are mapped back to models
only after the verdict comes home. Otherwise the judge just picks the flagship by
reputation, and you learn nothing.

**The interesting question is not who wins.** Cost per call is roughly fixed by the rate
card: the gap between the cheap tier and the expensive one is about the same multiple no
matter what you ask. Quality is not. On the easy preset the three answers should be
near-indistinguishable — you are paying 10x for nothing. On the hard reasoning and code
presets the gap should open up. Run both and watch the **quality** gap move while the
**cost** gap stays put; that ratio, per task type, is the actual decision.

## Notes on the numbers

- **Token counts are exact**, read from each response's `usage` object, never estimated.
  They will still vary between runs, because the models are sampling.
- **Thinking tokens are included.** Sonnet 5 and Opus 5 run with adaptive thinking, so
  their output token counts contain reasoning tokens. Those are billed at the output rate,
  so they are reported as-is rather than stripped out — that is a real part of what the
  tier costs.
- **Time to first token** is measured from request start to the first content delta on the
  stream. On the thinking tiers that first delta can be a reasoning delta rather than
  visible text, so TTFT there means "the model started working", not "text appeared".
- **Verify the rates.** The per-million-token rates live in one constant at the top of
  `server.js`. Published prices change and introductory pricing expires — check them
  against <https://claude.com/pricing#api> before trusting the cost column.
- **A tier can spend the whole budget thinking.** `max_tokens` is 3,000 for every call.
  On a hard prompt a thinking tier can burn all 3,000 on reasoning and get cut off before
  it writes a single word of answer — the row is flagged *hit token cap*, the empty answer
  goes to the judge as-is, and it ranks last. That is a genuine result about running that
  tier on that task under that budget, not a bug to paper over. Raise `MAX_TOKENS` in
  `server.js` if you want the tier to have room to finish.
- A failed call degrades one cell to an error string (`Promise.allSettled`) instead of
  killing the grid. The blind ranking is skipped only if some model returned nothing at
  all to rank.

## Layout

```
server.js           Express server, the 3 parallel streamed calls, and the blind judge
public/index.html   The whole frontend — plain HTML/CSS/JS, no frameworks
```
