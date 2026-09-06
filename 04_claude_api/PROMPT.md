Build a Node.js/Express web app called "temp-lab" with the following behavior:

FRONTEND (single HTML page, public/index.html):
- A row of preset task buttons that fill the textarea when clicked. Three presets, each labelled with what it tests:
  1. "Factual — tests accuracy": "List the five largest countries by land area, in order, with area in square kilometres. Just the list, no commentary."
  2. "Creative — tests creativity": "Write the opening sentence of a story about a lighthouse keeper who receives a letter. One sentence only."
  3. "Brainstorm — tests variety": "Name three unusual uses for a house brick. One short line each, no explanation."
- A textarea (prefilled with the first preset, freely editable) and a "Run" button.
- On run, display a loading state with a progress counter, then render a table:
  - Rows = temperature values: 0, 0.35, 0.7, 1.0, 1.2
  - Columns = "Run 1", "Run 2", "Run 3", "Divergence"
  - The first three columns show three independent responses to the SAME prompt at that temperature.
  - The Divergence column shows a percentage: how far the three runs spread apart from each other.
- Mark cells that are byte-identical to Run 1 in the same row with a small "identical" note — at temperature 0 this should light up, and that visual contrast is the point of the app.
- Style it cleanly and simply — bordered table, readable font sizes, cells wrap text and are scrollable if long (max-height with overflow-y: auto), not stretching the page.
- No frameworks needed — plain HTML/CSS/JS is fine.

BACKEND (server.js, Express):
- Serve the static frontend.
- POST /run endpoint: accepts { message: string } in the body.
- Define the temperature list as a constant: [0, 0.35, 0.7, 1.0, 1.2]. Define runs-per-temperature as a constant: 3.
- On POST /run, fire all 15 combinations (5 temperatures × 3 repeat runs) as PARALLEL requests to the Anthropic API using @anthropic-ai/sdk, model "claude-haiku-4-5-20251001", max_tokens 300. Send the identical user message every time — the temperature is the only variable.
- IMPORTANT: the Anthropic API accepts temperature only in the range 0.0 to 1.0. The 1.2 row is included deliberately and is expected to return a 400 error. Do not clamp, skip, or silently rewrite it. Catch the error and return its message as the cell content so the failure is visible in the table. This is intended experimental evidence, not a bug to fix.
- Use Promise.allSettled so one failure doesn't kill the whole grid — a failed cell returns an error string for that cell only.
- Compute a divergence score per temperature row, server-side: tokenize each response into a lowercase word set, take the average pairwise Jaccard similarity across the successful runs, and return (1 - that average) as a percentage rounded to a whole number. Return null when fewer than two runs succeeded.
- Return a JSON structure like:
  { results: { "0": { runs: ["...", "...", "..."], divergence: 4 }, "0.35": {...}, ... } }
- Read ANTHROPIC_API_KEY from process.env — never hardcode it.

PROJECT SETUP:
- Use ES modules ("type": "module" in package.json).
- Create a .gitignore excluding node_modules and .env.
- Support loading the API key from a .env file via dotenv, with a .env.example showing the expected variable name.
- Add a README.md with setup instructions: npm install, setting the API key, npm start, and opening localhost. Include a short "What this demonstrates" section explaining that temperature widens the sampling distribution rather than adding creativity, that the divergence column is the measurement, and that Anthropic's newest models (Opus 4.7 and later, Sonnet 5) have removed the temperature parameter entirely.
- Use a fixed port (3000) with a console.log confirming the server is running and the URL to open.

After scaffolding, run npm install and start the server so I can verify it works at localhost:3000.
