# temp-lab


https://github.com/user-attachments/assets/407b34c0-36f2-439e-a64d-5c8c990bb1ca


A one-page bench for Claude's `temperature` parameter. You give it a prompt; it sends the
*identical* prompt 15 times — five temperatures × three runs each — and lays the answers out
in a grid so you can see the spread with your own eyes.

## Setup

```bash
npm install
cp .env.example .env    # then paste your key into .env
npm start
```

Open <http://localhost:3000>.

Two variables are read from the environment (loaded from `.env` via dotenv); neither is ever
written into the source:

- `ANTHROPIC_API_KEY` — required.
- `ANTHROPIC_WORKSPACE_ID` — required **only** if your key is org-scoped rather than scoped to
  a single workspace. Such a key must name a workspace on every request, and without it the
  API returns `This API key is not scoped to a workspace...` in all 15 cells. When set, it is
  sent as the `anthropic-workspace-id` default header; when unset it is omitted entirely.

If you already export these in your shell, you can skip the `.env` file.

## How it works

- **Model:** `claude-haiku-4-5-20251001`, `max_tokens: 300`.
- **Temperatures:** `[0, 0.35, 0.7, 1.0, 1.2]`, three runs each, all 15 fired in parallel
  from `POST /run` and collected with `Promise.allSettled` so one failure only costs you
  one cell.
- **Divergence:** each response is lowercased and split into a set of words; the server takes
  the average pairwise Jaccard similarity across the *successful* runs at that temperature and
  reports `1 - similarity` as a whole-number percentage. Fewer than two successes → `null`.
- **"identical to Run 1":** cells that are byte-for-byte equal to Run 1 in the same row get a
  tag. At temperature 0 the row usually lights up green.

## What this demonstrates

**Temperature widens the sampling distribution; it does not add creativity.** At every
temperature the model is choosing from the same ranked list of next tokens. Low temperature
sharpens that distribution toward the top candidate — at 0 you get near-greedy decoding, which
is why Run 1, 2, and 3 come back identical. Raising the temperature flattens it, so lower-ranked
tokens start getting picked. What you gain is *variance*, not insight: the brainstorm preset
gives you three different bricks, not three better ones, and the factual preset can start
drifting on numbers that were right at 0.

**The Divergence column is the measurement.** Reading three answers and feeling that they seem
different is not evidence. Jaccard distance over word sets turns that impression into a number
you can watch climb as the temperature rises — that curve is the actual output of this app.

**The 1.2 row is supposed to fail.** The Anthropic API accepts `temperature` only in
`0.0`–`1.0`. That row is not clamped, skipped, or quietly rewritten; the 400 is caught and the
error text is printed into the cells, so the boundary is visible in the table rather than
hidden in a log.

**And the parameter is on its way out.** Anthropic's newest models — Opus 4.7 and later, and
Sonnet 5 — have removed `temperature` (along with `top_p` and `top_k`) entirely; passing it
returns a 400. Response shaping on those models happens through `output_config.effort` and
adaptive thinking instead. This app runs on Haiku 4.5 precisely because it is a current model
that still accepts the knob.
