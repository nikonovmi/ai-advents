Build a Node.js/Express web app called "dummy" with the following behavior:

FRONTEND (single HTML page, public/index.html):
- A textarea where the user pastes/types a message, and a "Send" button.
- On send, display a loading state, then render a table:
  - Rows = temperature values: 0, 0.25, 0.5, 0.75, 1.0
  - Columns = system prompts: "Dummy (IQ 70)", "Toxic", "Wizard"
  - Each cell shows the Claude response for that (temperature, system prompt) combination, for the same user message.
- Style it cleanly and simply — a bordered table, readable font sizes, cells should wrap text and be scrollable if long (max-height with overflow-y: auto), not stretch the page.
- No frameworks needed — plain HTML/CSS/JS is fine.

BACKEND (server.js, Express):
- Serve the static frontend.
- POST /chat endpoint: accepts { message: string } in the body.
- Define three system prompts as constants:
  1. "dummy": a system prompt instructing the model to respond as if it has a 70 IQ — very simple, short, unsophisticated answers.
  2. "toxic": a system prompt instructing the model to respond in a sarcastic, rude, dismissive tone (keep it PG — mean and blunt, not slurs or genuinely harmful content).
  3. "wizard": a system prompt instructing the model to respond in the voice of an eccentric medieval wizard, archaic language, dramatic flair.
- On POST /chat, fire all 15 combinations (5 temperatures × 3 system prompts) as PARALLEL requests to the Anthropic API using @anthropic-ai/sdk, model "claude-haiku-4-5-20251001", max_tokens 300.
- Use Promise.all (or allSettled so one failure doesn't kill the whole grid — if a cell fails, return an error string for just that cell instead of crashing).
- Return a JSON structure like: { results: { "dummy": { "0": "...", "0.25": "...", ... }, "toxic": {...}, "wizard": {...} } }
- Read ANTHROPIC_API_KEY from process.env — never hardcode it.

PROJECT SETUP:
- Use ES modules ("type": "module" in package.json).
- Create a .gitignore excluding node_modules and .env.
- Support loading the API key from a .env file via dotenv, with a .env.example showing the expected variable name.
- Add a README.md with setup instructions: npm install, setting the API key, npm start, and opening localhost.
- Use a fixed port (3000) with a console.log confirming the server is running and the URL to open.

After scaffolding, run npm install and start the server so I can verify it works at localhost:3000.

