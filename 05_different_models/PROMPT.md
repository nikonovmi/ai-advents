Build a Node.js/Express web app called "model-lab" with the following behavior:

FRONTEND (single HTML page, public/index.html):
- A row of preset task buttons that fill the textarea when clicked. Three presets, each labelled with what it is designed to reveal:
  1. "Easy — tiers should converge": "Rewrite this as one plain-English sentence a 12-year-old would understand: 'Pursuant to the aforementioned agreement, the party of the first part shall indemnify the party of the second part against all liabilities arising therefrom.'"
  2. "Hard reasoning — tiers should diverge": "A shop sells pens in packs of 7 and pencils in packs of 4. Yesterday it sold 3 more packs of pens than packs of pencils, and 41 individual items in total. How many packs of each did it sell? Show your reasoning, then state the final answer on its own line."
  3. "Code — tiers should diverge": "Write a JavaScript function that merges overlapping intervals. Handle unsorted input, touching-but-not-overlapping intervals, and an empty array. Include the edge cases you considered as comments."
- A textarea (prefilled with the first preset, freely editable) and a "Run" button.
- On run, show a loading state with a progress counter, then render a results table:
  - Rows = the three models, cheapest first.
  - Columns = "Response", "Time to first token", "Total time", "Input tokens", "Output tokens", "Cost per call", "Cost per 1,000 calls"
  - The Response cell shows the text from run 1 only, with max-height and overflow-y: auto so a long answer does not stretch the page.
  - Timing columns show the MEDIAN across the three runs, with the min–max range beneath in smaller text.
  - Token and cost columns show the mean across the three runs.
- Beneath the table, show a "Relative to cheapest" line: for each model, its cost as a multiple of the cheapest model's cost on this task (e.g. "1x / 4.2x / 11.8x").
- Beneath that, render the blind quality ranking returned by the backend (see JUDGING below): the ranked order plus the judge's one-line reason for each placement.
- Style it cleanly and simply — bordered table, readable font sizes, monospace for the numeric columns so they align. No frameworks needed; plain HTML/CSS/JS is fine.

BACKEND (server.js, Express):
- Serve the static frontend.
- POST /run endpoint: accepts { message: string } in the body.
- Define the model tiers as a single constant array, cheapest first, with rates in dollars per million tokens:
    { tier: "low",  id: "claude-haiku-4-5-20251001", inputRate: 1,  outputRate: 5  }
    { tier: "mid",  id: "claude-sonnet-5",           inputRate: 3,  outputRate: 15 }
    { tier: "high", id: "claude-opus-5",             inputRate: 5,  outputRate: 25 }
  Add a comment above this constant instructing the reader to verify the rates against Anthropic's current pricing page before trusting the cost column, since published rates change and introductory pricing expires.
- Define runs-per-model as a constant: 3.
- On POST /run, send the identical user message to every model, three times each — 9 calls total — using @anthropic-ai/sdk with max_tokens 2000. Run all 9 in parallel with Promise.allSettled so one failure returns an error string for that cell instead of killing the grid.
- Use the streaming API for every call so time-to-first-token can be measured. Record, per call:
  - ttft: milliseconds from request start to the first content delta
  - total: milliseconds from request start to stream completion
  - inputTokens and outputTokens read from the final message's usage object — do not estimate token counts, the API reports them exactly
  - cost: (inputTokens / 1e6 * inputRate) + (outputTokens / 1e6 * outputRate)
- Note in a code comment that the mid and high tiers use adaptive thinking, so their output token counts include reasoning tokens. This is a real part of what those tiers cost and should be reported as-is, not stripped out.

JUDGING:
- After all 9 calls settle, make one additional call to "claude-opus-5" to rank response quality.
- Send it the original task and the three run-1 responses, labelled A, B and C in RANDOMLY SHUFFLED order, with no model names attached. The judge must not be able to tell which tier produced which answer.
- Instruct the judge to rank the three from best to worst on correctness first and clarity second, and to give one short sentence of justification per placement. Ask for JSON output only.
- Map the anonymized labels back to model names server-side before returning.

- Read ANTHROPIC_API_KEY from process.env — never hardcode it.
- Return a JSON structure like:
  { results: [ { tier, model, response, ttftMedian, ttftRange, totalMedian, totalRange, inputTokens, outputTokens, cost, costPer1000 } ], judgement: [ { rank, model, reason } ] }

PROJECT SETUP:
- Use ES modules ("type": "module" in package.json).
- Create a .gitignore excluding node_modules and .env.
- Support loading the API key from a .env file via dotenv, with a .env.example showing the expected variable name.
- Add a README.md with setup instructions: npm install, setting the API key, npm start, and opening localhost. Include a "How to read the results" section covering three points: that median-of-three is used because single-call latency mostly measures network conditions; that the judge is blind so it cannot favour the flagship by name; and that the interesting comparison is not which model wins overall but how the quality gap changes between the easy preset and the hard ones while the cost gap stays constant.
- Use a fixed port (3000) with a console.log confirming the server is running and the URL to open.

After scaffolding, run npm install and start the server so I can verify it works at localhost:3000.
