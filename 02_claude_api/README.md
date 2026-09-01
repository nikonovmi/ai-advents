# dummy

A single web page that shows what each knob on a Claude API request actually does
to the answer.

```bash
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm install
npm start              # http://localhost:3000
```

Nothing calls the API until you press a button.

## Part 1 — the constraint ladder

You type a question. It gets sent four times, each request adding one more
constraint than the last:

1. persona only
2. \+ a format rule (exactly three bullets)
3. \+ a length rule (12 words per bullet, and `max_tokens: 120`)
4. \+ a stop rule (`<END>`, and `stop_sequences: ["<END>"]`)

**Output:** four cards. Each shows the request parameters used, the answer, its
token count and `stop_reason`, and ✓/✗ checks for whether the model actually
obeyed its own rules.

Typical result — the answer shrinks from 294 tokens to 47 as the rules stack up.
The format rule alone doesn't shorten anything; the word budget does.

## Part 2 — every other knob, one at a time

Eight experiments. Each sends the same request 2–4 times, changing exactly one
parameter, so any difference has exactly one cause.

`system` · `messages` · `model` · `output_config.effort` · `thinking` ·
`max_tokens` · `stop_sequences` · `output_config.format`

**Output:** for each experiment, a row of cards. Each card shows the one
parameter that changed, the answer, the reasoning summary if there is one, and
tokens / time / `stop_reason`.

Each experiment is labelled with how much power the knob has:

- **just asking** — it's only text in the prompt; the model may ignore it
- **dial** — trades quality for time and money, guarantees neither
- **hard rule** — the API enforces it; the model can't break it, and with
  `max_tokens` can't even see it coming

## Not included

`temperature`, `top_p` and `top_k` — deprecated, they return a 400 on Sonnet 5 and
Opus 5. `output_config.effort` replaced them. Also no `stream` or `tools`: neither
produces one final answer you can put side by side.

## Files

```
server.js           Express + the constraint ladder
lab.js              the eight experiments
public/index.html   the whole frontend, no build step
```
