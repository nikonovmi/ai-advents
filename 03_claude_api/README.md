# Week 1 Day 3 — Reasoning Approaches


https://github.com/user-attachments/assets/7ea6d519-89a5-4302-82b5-6907baf5b62d


Does *how* you ask change the answer? This app takes one open-ended problem with no right
answer, solves it four different ways through the Anthropic API, and has a blind judge grade
the results — without knowing which method wrote which answer.

**The problem:** a founder has 8 weeks, £16k already spent, 400 people who pre-ordered a
quit-smoking app that doesn't exist yet, and no way to refund them. What should they build,
and how?

**The four methods:**

| | Calls | |
| --- | --- | --- |
| `direct` | 1 | Just the problem. |
| `step_by_step` | 1 | Problem + "solve this step-by-step". |
| `meta_prompt` | 2 | Ask the model to write the best prompt for the problem, then use it. |
| `expert_panel` | 4 | Researcher, engineer and critic in parallel; a founder decides. |

**The judge:** every answer is stripped of method labels, shuffled, given an opaque id, and
scored 0–2 on six criteria — framing, tradeoff, mechanism, legal exposure, concreteness,
uncertainty — for a total out of 12.

The interesting result is the second table, not the first. The methods mostly agree on *what*
to build; where they differ is whether they notice that the problem never says what the
campaign actually promised.

## Run it

```bash
npm install
cp .env.example .env      # paste your key from console.anthropic.com/settings/keys
npm start                 # http://localhost:3000
```

Set runs per method (default 1), hit **Run comparison**, click any cell to read the full
transcript. **Download results.md** exports both tables and a summary.

One pass at the default is 8 solver calls plus 4 judge calls, about 50 seconds.

## Files

```
server.js    Express app, the problem, batch orchestration
methods.js   The four approaches, side by side so the prompts are easy to diff
judge.js     Blind rubric, JSON schema, anonymisation
client.js    Shared client, concurrency cap, usage helpers
public/      Single-page frontend, no frameworks
```

## Two notes

- **The solver runs at `temperature: 0`; the judge sends no temperature at all.**
  `claude-sonnet-5` rejects sampling parameters with a 400, so the judge's consistency comes
  from a frozen rubric and an enforced JSON schema instead.
- **At 1 run per method the scores are a rough sort, not a ranking.** Single-call methods
  swing a couple of points between runs. Do a 3-run pass if you want the averages to mean
  something.
