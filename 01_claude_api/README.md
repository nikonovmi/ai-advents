# dummy



https://github.com/user-attachments/assets/876db343-ee5a-4fcb-9bf2-b1e703a2a177



Sends one message to Claude fifteen times at once and lays the answers out in a
grid, so you can see what temperature and a system prompt each actually change.

- **Rows** — temperature: `0`, `0.25`, `0.5`, `0.75`, `1.0`
- **Columns** — three voices, all speaking plain modern English:
  - **Dummy** — small vocabulary, short sentences, often misses the point
  - **Toxic** — sarcastic and dismissive, answers anyway
  - **Senior judge** — bored, clipped, gives the ruling and nothing more

Reading it: the columns differ far more than the rows. Different system prompts
relocate the answer; temperature mostly just rephrases it.

## How it talks to the API

`POST /chat` fans all fifteen `(system prompt × temperature)` combinations out
in parallel against `claude-haiku-4-5`:

```js
const settled = await Promise.allSettled(
  jobs.map(({ promptKey, temperature }) =>
    client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: Number(temperature),
      system: SYSTEM_PROMPTS[promptKey],
      messages: [{ role: "user", content: message }],
    })
  )
);
```

`allSettled` rather than `all`, so one failed call becomes an error string in
that one cell instead of taking down the whole grid. The response is keyed by
prompt then temperature:

```json
{ "results": { "dummy": { "0": "…", "0.25": "…" }, "toxic": {…}, "judge": {…} } }
```

`max_tokens` is a runaway guard, not a length setting — the prompts ask for short
answers, and the server logs a warning if a response ever hits the cap.

## Layout

```
server.js           Express: static files + POST /chat
public/index.html   the whole frontend — plain HTML/CSS/JS, no build step
```
