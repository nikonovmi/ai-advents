# first-agent

A minimal chat app — Express server, plain-HTML chat UI, reusable `Agent` behind
a provider-neutral LLM abstraction. Real tokens and cost per turn, and context
management as a **pluggable strategy**: four of them, switchable per
conversation, measured against each other by a scripted scenario.


https://github.com/user-attachments/assets/e9922362-4994-4b83-ba24-be1ff1d13965



## Run

Node 20.11+. Without an API key the server falls back to `FakeProvider`.

```bash
npm install
npm test                              # stubs, no key, no network
echo 'ANTHROPIC_API_KEY=sk-ant-…' > .env
npm start                             # http://localhost:3000
npm run scenario -- --all --window=10 # the numbers below
```

## Design

Three abstractions injected into `Agent`, which holds no URL, key, `fetch` or
vendor name: `LlmProvider` (who is the model), `ConversationStore` (where the
conversation lives), `ContextStrategy` (what goes on the wire). A strategy owns
`buildPayload` and an opaque `state` the `Agent` never inspects, so a fifth one
is a new file and a registry line. Its calls are billed separately; its failures
degrade the payload, not the turn. Two silent-failure rules live in
`boundaries.js`: the payload must open on a user message, and a turn pair is
never split. Nothing is deleted from the store — cropping affects only what is
sent. Branching is a storage change (messages gain `id`/`parentId`, each branch
owns a deep-copied `strategyState`), so it composes with all four.

## Strategies and numbers

`claude-haiku-4-5-20251001`, 15 turns, five planted facts recalled at the end.

| | | recall | w10 | w5 |
| --- | --- | :---: | ---: | ---: |
| `sliding` | last N exchanges | 0/5 | $0.02598 | $0.02094 |
| `summary` | digest in the system prompt, oldest half folded at a high-water mark | 5/5 | $0.03061 | $0.03399 |
| `facts` | key-value block, patch-based extraction, never regenerative | 5/5 | $0.03814 | $0.02934 |
| `full` | everything, every turn | 5/5 | **$0.02828** | **$0.02828** |

**At fifteen turns, sending everything is the cheapest thing that works.** Facts
loses at window 10 (15 extraction calls against 2 folds) and wins at window 5,
where its block plateaus while the summary keeps growing; the curves cross around
turn 17. Sliding's 0/5 didn't say "I don't know" — it confidently asked to start
over. Pick `full` until it hurts, then `facts` with a narrow window, `summary`
when narrative matters more than values.
