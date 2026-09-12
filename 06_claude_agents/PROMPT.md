# Day 6 — Build Prompt

Build a Node.js/Express web app called `first-agent`: a simple chat interface backed by a reusable **Agent** class.

Two architectural requirements:

1. The Agent is a self-contained class that owns the persona and the conversation history. The Express route contains no LLM code — it creates an Agent and calls `agent.run(text)`.
2. The Agent never talks to Anthropic directly. It depends on an **LLM provider abstraction** with a single generic method, and an Anthropic implementation of that abstraction is passed into the Agent's constructor.

```
src/
  llm/
    provider.js    — the abstraction (base class + shared error type)
    anthropic.js   — Anthropic implementation
  agent.js         — the Agent class
  server.js        — Express
public/
  index.html       — chat UI
```

Acceptance test for the separation: `agent.js` must not contain the string `fetch`, any URL, any API key reference, or the word "anthropic" in any casing.

## `src/llm/provider.js` — the abstraction

- Export an abstract class `LlmProvider` with one method:
  `async complete({ system, messages, temperature, maxTokens })` → `{ text, model }`
  The base implementation throws `new Error("Not implemented")`.
- `messages` is a plain array of `{ role: "user" | "assistant", content: string }`. This shape is the contract — it is deliberately provider-neutral, not Anthropic's wire format.
- The return value is plain text plus the model name. Raw provider responses must never cross this boundary.
- Export an `LlmError` class carrying `status` and `message`, so the Agent can react to failures without knowing which provider produced them.

## `src/llm/anthropic.js` — the implementation

- Export `class AnthropicProvider extends LlmProvider`.
- Constructor takes `{ apiKey, model = "claude-haiku-4-5-20251001" }` and throws a clear error if `apiKey` is missing. The key lives here and nowhere else.
- `complete()` translates the neutral input into an Anthropic request, calls the API, and translates the response back into `{ text, model }`.
- Use native `fetch` directly against `https://api.anthropic.com/v1/messages` — do NOT use `@anthropic-ai/sdk`. Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`. Timeout via `AbortSignal.timeout(30000)`.
- On a non-2xx response, read the body and throw an `LlmError` with the status and the provider's error message.
- Extracting text from the response's content blocks happens here, in its own small helper, so tool-use blocks can be handled later without touching the Agent.

Also export a `FakeProvider extends LlmProvider` that returns a canned reply after a short delay. This lets the app and the Agent be exercised with no API key and no network.

## `src/agent.js`

Export a class `Agent`.

Constructor takes `{ provider, name = "Assistant", systemPrompt, temperature = 0.7, maxTokens = 1024, historyLimit = 20 }`.

- The provider is **injected** — the Agent never constructs one. Throw if it's missing or lacks a `complete` method.
- Conversation history lives in a private field (`#history`).

Public methods:
- `async run(userInput)` → `{ text, meta: { agent, model, ms } }`
  - Trim and validate input; throw on empty.
  - Push the user turn, call `this.provider.complete(...)`, push the assistant turn, trim history to the last `historyLimit` turns, return the result.
  - `meta.ms` is elapsed time in milliseconds; `meta.model` comes from the provider's response.
- `reset()` — clears history.
- `get transcript()` — returns a copy of the history.

Private: `#callWithRetry()` — up to 3 attempts with exponential backoff (500ms, 1000ms, 2000ms) on `LlmError` with status 429 or 5xx; fail fast otherwise.

Also export a `personas` object with two ready-made system prompts (e.g. `helpful`, `pirate`).

## `src/server.js`

- Express, serving `public/` statically, fixed port 3000.
- Construct one `AnthropicProvider` at startup from `process.env.ANTHROPIC_API_KEY` and share it across agents.
- Keep sessions in a `Map<sessionId, Agent>` **in this file** — the Agent class must not know sessions exist. Create an Agent lazily on a session's first message.
- `POST /chat` — accepts `{ message, sessionId }`, returns `{ reply, meta }`.
- `POST /reset` — accepts `{ sessionId }`, calls `agent.reset()`, returns `{ ok: true }`.
- 400 on missing or empty message; 500 with a readable JSON error otherwise. Never leak the API key or a stack trace into the response.
- `console.log` the URL on startup.

## `public/index.html`

Single page, plain HTML/CSS/JS, no frameworks.

- Scrollable message list with visually distinct user and agent bubbles, plus a textarea and a Send button.
- Enter sends, Shift+Enter makes a newline.
- Show a "thinking…" indicator while a request is in flight and disable the Send button.
- Render `meta` (model and elapsed ms) as small muted text under each agent reply.
- A "New conversation" button that calls `/reset` and clears the view.
- Generate a `sessionId` once on page load with `crypto.randomUUID()` and send it with every request.
- Clean and readable: sensible max-width, comfortable line height, long messages wrap instead of stretching the page.

## PROJECT SETUP

- ES modules (`"type": "module"`), Node 18+.
- Dependencies: only `express` and `dotenv`.
- Load `ANTHROPIC_API_KEY` from a `.env` file via dotenv — never hardcode it, never send it to the frontend.
- `.gitignore` excluding `node_modules` and `.env`.
- `.env.example` showing the expected variable name.
- `README.md`: install, API key setup, `npm start`, the localhost URL, and a short section on the provider abstraction — what the Agent depends on and why swapping in `FakeProvider` or another vendor requires no changes to `agent.js`.

## FINALLY

Run `npm install`, start the server, and confirm it works at localhost:3000.
