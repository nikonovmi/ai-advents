# first-agent

A minimal chat app: an Express server, a plain-HTML chat UI, and a reusable
`Agent` class sitting behind a provider-neutral LLM abstraction.

https://github.com/user-attachments/assets/89ce4c58-ecac-4367-83ab-5d723f0c803a


## Install

Requires Node 18+ (native `fetch`).

```bash
npm install
```

## API key

```bash
cp .env.example .env
```

Then put your key in `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Get one at https://console.anthropic.com/settings/keys. The key is read only on
the server, only in `src/llm/anthropic.js`, and is never sent to the browser.

If a request comes back saying the key *"is not scoped to a workspace"*, the key
is identity-linked and also needs a workspace id:

```
ANTHROPIC_WORKSPACE_ID=wrkspc_...
```

Workspace-scoped keys can leave that blank.

Without a key the server starts anyway and falls back to `FakeProvider`, which
returns canned replies with no network calls — handy for poking at the UI.

## Run

```bash
npm start
```

Then open **http://localhost:3000**.

Enter sends a message, Shift+Enter adds a newline, and **New conversation**
clears both the view and the server-side history for your session.

## Layout

```
src/
  llm/
    provider.js    the abstraction (LlmProvider + LlmError)
    anthropic.js   AnthropicProvider + FakeProvider
  agent.js         the Agent class and the personas
  server.js        Express routes and session bookkeeping
public/
  index.html       the chat UI
```

## The provider abstraction

`Agent` depends on exactly one thing:

```js
async complete({ system, messages, temperature, maxTokens }) // → { text, model }
```

`messages` is a plain `{ role, content }[]`, deliberately not any vendor's wire
format, and the result is plain text plus a model name. Raw HTTP responses,
content blocks, headers and credentials all stop at that boundary — so `agent.js`
contains no URL, no key, no `fetch`, and no vendor name at all.

The provider is **injected** through the constructor; the Agent never builds one:

```js
const agent = new Agent({ provider, systemPrompt: personas.pirate });
```

That means swapping vendors is a one-line change at the composition root
(`src/server.js`) and *zero* changes to `agent.js`:

```js
const provider = new FakeProvider();               // offline, no key
// const provider = new OpenAiProvider({ apiKey }); // a different vendor
// const provider = new AnthropicProvider({ apiKey });
```

Any new provider only has to extend `LlmProvider`, translate the neutral input
into its own request format, and translate the response back to `{ text, model }`.
Failures are normalised to `LlmError` with a `status`, which is how the Agent
knows to retry a 429 or a 5xx (three attempts, 500/1000/2000 ms backoff) without
knowing who produced the error.

Session state lives in `server.js` in a `Map<sessionId, Agent>` — the Agent
itself has no idea that sessions or HTTP requests exist.
