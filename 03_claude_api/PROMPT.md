Build a Node.js/Express web app called "Week 1 Day 3 — Reasoning Approaches" that solves ONE
open-ended problem four different ways via the Anthropic API and compares the results.

THE PROBLEM (hardcoded in the backend as a constant):
"I am building a quit-smoking app and I have a hard deadline I cannot move.

  - Today is 1 March. The marketing campaign is already running and launch is publicly
    committed for 1 May. That is 8 weeks.
  - 400 people have pre-ordered an annual subscription at 40 GBP each. The 16,000 GBP is
    already spent on the campaign, so I cannot refund at scale without going insolvent.
  - No code exists yet. No backend, no app, no content.
  - The team is two people: me (full-stack developer) and a part-time designer. Budget
    beyond our own time is about 3,000 GBP.
  - The campaign says iOS and Android.

What should I build, and how should I build it, so that on 1 May there is something the
400 people who already paid consider worth the money - and I am not facing mass refund
demands or a consumer-protection complaint?

Give a concrete recommendation and justify it."

Two properties of that wording are deliberate and must be preserved:
- Refunding is off the table. Without that constraint every method reaches for "offer
  refunds", they all converge, and the comparison shows nothing.
- What the campaign actually promised is NOT stated. A good answer notices the gap and
  states its assumption; a weak one invents a feature list and proceeds. This is the main
  thing that separates the methods.

EVERY solver prompt must end with an instruction to keep the response under 1,000 words
and to close with:
  RECOMMENDATION: <one sentence stating what you ship on 1 May and how you build it>
so the frontend can show a one-line summary per run. The word cap matters: max_tokens is
2000, and without it the multi-call methods run out of budget and lose the line mid-sentence.
Parse that line tolerantly — models dress it in markdown ("**RECOMMENDATION:** ...",
"## RECOMMENDATION: ..."), and a strict line-start match silently blanks the cell.

THE FOUR METHODS (methods.js — each an async fn taking the problem text, returning
{ recommendation, answer, truncated, transcript: [{label, role, content}], usage, latencyMs }):

1. "direct" — one API call, problem text only, no reasoning instructions.
2. "step_by_step" — one API call, problem text + "Solve this step-by-step, showing your reasoning."
3. "meta_prompt" — TWO calls:
   a) ask the model to write the best possible prompt for tackling this problem
      (return the prompt only, no preamble). Tell it the answering model has a hard
      2000-token budget so it doesn't generate a prompt asking for a five-section essay;
   b) send that generated prompt as a fresh call, with the closing instruction appended
      by us rather than trusted to survive generation.
   Store the generated prompt in the transcript so it's visible in the UI.
4. "expert_panel" — FOUR calls:
   a) three PARALLEL calls, each with its own system prompt:
      - Behaviour-change researcher: what actually drives smoking cessation, which
        components have real evidence, how much survives being delivered through a phone.
      - Shipping engineer: what two people can build in 8 weeks — cross-platform vs native,
        what the backend really needs at 400 users, what can be run manually behind the
        scenes, app store review time and rejection risk for a health-adjacent app.
      - Critic: attacks the framing itself — whether "worth the money" is the founder's
        question or the buyers', what someone who pre-paid was entitled to expect, and the
        ethics of shipping a half-working health product to people mid-quit.
   b) a fourth "founder" call that receives all three expert answers verbatim and must
      produce a single final recommendation.
   Store all four messages in the transcript.

GRADING (judge.js — blind rubric, since there is no ground truth):
- After all runs finish, collect every answer, strip any method identifiers, shuffle
  (Fisher-Yates), and assign each an opaque id.
- Send each answer to its own judge call with a FIXED rubric. Judge model "claude-sonnet-5".
  The judge never learns which method produced the answer.
- Do NOT send temperature. claude-sonnet-5 removed the non-default sampling parameters —
  temperature/top_p/top_k return a 400. Consistency comes from the frozen rubric, a
  json_schema in output_config.format, and a fixed effort level ("medium") instead.
- Rubric — score each 0-2, judge must return strict JSON
  { scores: {...}, total, oneLineCritique }:
    a) problem_framing: notes that "worth the money" is underdefined and picks an explicit
       bar — what the campaign led buyers to expect, what a cessation product has to do to
       work at all, or what merely avoids a refund claim
    b) tradeoff: names the tension between shipping something thin enough to finish and
       something substantial enough to be worth 40 GBP, rather than asserting one wins
    c) mechanism: gives a causal reason why the chosen build works (what drives cessation
       or retention, why a feature can be run manually at 400 users, why one platform or
       stack first) rather than restating the plan
    d) legal_exposure: treats the refund and consumer-protection risk concretely given the
       money is already spent — pre-launch disclosure, aligning the campaign with what
       ships, what the terms have to say — without inventing statutes or case law
    e) concreteness: answers both halves — what ships AND how it gets built (stack,
       sequencing, what is faked or run manually) — against the 8 weeks and two people
    f) uncertainty: flags what would change the answer, above all that what the campaign
       promised is not stated here — plus refundability, app store review, dev velocity
- Re-sum the total server-side from the six criteria, so a mis-added total from the judge
  can never move a method up the table.
- A run's score is the rubric total (0-12). Method score = mean across runs.
- Also record, per run: word count, latency, output tokens, API calls.

BACKEND (server.js, Express, ES modules):
- @anthropic-ai/sdk. Solver model "claude-haiku-4-5-20251001", max_tokens 2000,
  temperature 0. (Haiku 4.5 still accepts sampling parameters; the judge does not.)
- POST /run accepts { runs: number, jobId?: string } (default 1). Runs all 4 methods × N
  runs, then judges. GET /progress/:jobId reports { done, total, phase } so the frontend
  counter is real rather than estimated. GET /config serves the problem and rubric.
- Promise.allSettled with a concurrency cap of ~6 in flight. Put the cap on the individual
  API call, not the method — expert_panel is itself four calls, so a method holding a slot
  while awaiting its own inner calls would deadlock the pool.
- A failed call is recorded as { error: "..." } for that cell only and never kills the batch,
  on both the solve pass and the judge pass.
- Response JSON: { problem, runs, solverModel, judgeModel, maxTotal, rubric,
  methods: { direct: { label, runs: [...], avgScore, rubricAverages, avgLatencyMs,
  avgOutputTokens, avgWords }, step_by_step: {...}, meta_prompt: {...}, expert_panel: {...} } }
- Read ANTHROPIC_API_KEY from process.env via dotenv — never hardcode it. Support an
  optional ANTHROPIC_WORKSPACE_ID header for identity-linked keys.

FRONTEND (single page, public/index.html, plain HTML/CSS/JS, no frameworks):
- Problem statement shown at the top. Number input for runs (default 1), "Run comparison"
  button, loading state with a progress counter and a note that judging happens last.
- Main table: rows = the 4 methods, columns = Run 1..N (cell shows the RECOMMENDATION line
  and the rubric total, and flags "hit max_tokens" when a run was truncated rather than
  showing a blank), plus Avg score, Avg latency, Avg output tokens.
- Second table: rows = the 4 methods, columns = the six rubric criteria, showing the average
  per criterion — this is where the methods visibly differ, more than in the headline score.
- Clicking a cell expands the full transcript for that run (for meta_prompt: the generated
  prompt; for expert_panel: all three experts plus the founder) and the judge's critique.
- A "Download results.md" button exporting: the problem, both tables, and a short
  auto-generated comparison — highest average score, best per-criterion, fastest,
  most tokens, and whether the recommendations agreed or diverged (bucketed by keyword
  heuristic: ship narrow / manage the buyers / both / other, labelled as a heuristic).
- Clean styling: bordered tables, readable fonts, scrollable transcript panels
  (max-height + overflow-y: auto).

PROJECT SETUP:
- "type": "module" in package.json, fixed port 3000, console.log the URL on start.
- .gitignore (node_modules, .env), .env.example, README.md with npm install / API key / npm start.
- Keep the four methods in methods.js and the judge in judge.js, so they are easy to diff.
  Shared client, the in-flight cap and usage helpers live in client.js.

After scaffolding, run npm install and start the server so I can verify it at localhost:3000.
