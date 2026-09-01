// The knob lab: one experiment per request parameter. Each experiment fixes a
// base request and changes exactly one thing across its variants, so the
// difference in the answers has exactly one cause.
//
// Out of scope on purpose: stream (no single final answer to put side by side)
// and tools (needs a loop, not a request). temperature / top_p / top_k are gone
// for good - they return 400 "deprecated for this model" on Sonnet 5, Opus 5
// and Fable 5, which is where everything is heading.

import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const SONNET = "claude-sonnet-5";
const HAIKU = "claude-haiku-4-5";
const OPUS = "claude-opus-5";

// Sonnet 5 runs adaptive thinking unless told otherwise. Most experiments turn
// it off so that the knob under test is the only thing moving - otherwise a
// tight max_tokens gets eaten by reasoning and you learn nothing about the cap.
const NO_THINKING = { type: "disabled" };

// kind tells you how much authority the knob has:
//   input  - what you feed in; not a rule at all
//   who    - which model answers
//   dial   - trades quality against time and money; no guarantees either way
//   asking - written in the prompt; the model may ignore it
//   hard   - enforced by the API; the model cannot break it
const EXPERIMENTS = [
  {
    key: "system",
    knob: "system",
    kind: "asking",
    title: "Who the helper pretends to be",
    plain:
      "Same question, three different helpers. The facts barely move; the whole " +
      "shape of the answer does. Nothing here is enforced - the model complies " +
      "because it wants to, and it is free not to.",
    base: {
      model: SONNET,
      // Roomy on purpose: if an answer got cut off here you would be looking at
      // max_tokens, not at the system prompt.
      max_tokens: 700,
      thinking: NO_THINKING,
      messages: [
        {
          role: "user",
          content: "Why does my code work on my machine but not on the server?",
        },
      ],
    },
    variants: [
      { id: "none", label: "No system prompt", patch: {} },
      {
        id: "engineer",
        label: "Grumpy staff engineer",
        patch: {
          system:
            "You are a staff-level engineer with fifteen years in production. " +
            "You think this question is beneath you - say so, then answer it " +
            "correctly. Flat contempt, no profanity.",
        },
      },
      {
        id: "teacher",
        label: "Explaining to a five-year-old",
        patch: {
          system:
            "You are explaining to a five-year-old. Tiny words, short sentences, " +
            "one friendly comparison to something in a kitchen or a playground.",
        },
      },
    ],
  },

  {
    key: "messages",
    knob: "messages",
    kind: "input",
    title: "What the helper has been told so far",
    plain:
      "The API remembers nothing between calls. The second request looks like " +
      "memory, but it is only the earlier turns being sent again - you keep the " +
      "history, not Anthropic.",
    base: {
      model: SONNET,
      max_tokens: 600,
      thinking: NO_THINKING,
      system: "You are a concise, helpful programming assistant.",
    },
    variants: [
      {
        id: "cold",
        label: "One turn, no history",
        patch: {
          messages: [
            { role: "user", content: "So what language should I write it in?" },
          ],
        },
      },
      {
        id: "history",
        label: "The same turn, with history in front of it",
        patch: {
          messages: [
            {
              role: "user",
              content:
                "I'm building a tiny command-line tool. The only language I know well is Rust.",
            },
            {
              role: "assistant",
              content:
                "Understood - a small CLI, and Rust is your strongest language.",
            },
            { role: "user", content: "So what language should I write it in?" },
          ],
        },
      },
    ],
  },

  {
    key: "model",
    knob: "model",
    kind: "who",
    title: "Which helper answers",
    plain:
      "Watch the clock and the token count as much as the words. Each model is " +
      "left on its own default here, and those defaults differ: Haiku 4.5 does " +
      "no thinking at all, Sonnet 5 and Opus 5 think adaptively before answering.",
    base: {
      max_tokens: 1000,
      system: "Answer in at most three sentences.",
      messages: [
        {
          role: "user",
          content:
            "My Node server's memory grows about 5 MB per request and never comes back down. " +
            "What is the single most likely cause, and how would you confirm it?",
        },
      ],
    },
    variants: [
      { id: "haiku", label: "Haiku 4.5 - small and fast", patch: { model: HAIKU } },
      { id: "sonnet", label: "Sonnet 5 - middle", patch: { model: SONNET } },
      { id: "opus", label: "Opus 5 - large", patch: { model: OPUS } },
    ],
  },

  {
    key: "effort",
    knob: "output_config.effort",
    kind: "dial",
    title: "How hard the helper tries",
    plain:
      "This is the dial that replaced temperature. It does not make answers " +
      "more correct - all four levels get this one right - it decides how much " +
      "time and money the model is allowed to spend arriving there.",
    base: {
      model: SONNET,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      messages: [
        {
          role: "user",
          content:
            "On a 6x6 grid of dots, how many rectangles with sides parallel to the axes " +
            "have an area that is an odd number? Answer with the number and one sentence " +
            "of justification.",
        },
      ],
    },
    variants: [
      { id: "low", label: "effort: low", patch: { output_config: { effort: "low" } } },
      { id: "medium", label: "effort: medium", patch: { output_config: { effort: "medium" } } },
      { id: "high", label: "effort: high (the default)", patch: { output_config: { effort: "high" } } },
      { id: "max", label: "effort: max", patch: { output_config: { effort: "max" } } },
    ],
  },

  {
    key: "thinking",
    knob: "thinking",
    kind: "dial",
    title: "Whether the helper works it out first",
    plain:
      "A hard question. With thinking off the model answers straight away; with " +
      "it on it reasons first and you pay for those tokens either way. display " +
      "only decides whether you are allowed to read the reasoning - it never " +
      "changes whether it happened.",
    base: {
      model: SONNET,
      max_tokens: 3000,
      output_config: { effort: "high" },
      messages: [
        {
          role: "user",
          content:
            "What is the smallest positive integer n such that n! ends in exactly 100 " +
            "trailing zeros? If no such n exists, say so and explain why.",
        },
      ],
    },
    variants: [
      { id: "off", label: "thinking: disabled", patch: { thinking: { type: "disabled" } } },
      {
        id: "omitted",
        label: 'adaptive, display "omitted" (the default)',
        patch: { thinking: { type: "adaptive", display: "omitted" } },
      },
      {
        id: "summarized",
        label: 'adaptive, display "summarized"',
        patch: { thinking: { type: "adaptive", display: "summarized" } },
      },
    ],
  },

  {
    key: "max_tokens",
    knob: "max_tokens",
    kind: "hard",
    title: "A hand over the mouth",
    plain:
      "The model cannot see this limit, so it does not plan around it. It is " +
      "talking normally and then it simply is not - mid-sentence, mid-word. The " +
      "last card is the control: the same answer given room to finish, ending on " +
      "end_turn at around 2100 tokens.",
    base: {
      model: SONNET,
      thinking: NO_THINKING,
      system: "Be thorough.",
      messages: [
        { role: "user", content: "Explain in detail how HTTPS keeps a page private." },
      ],
    },
    // Left to itself this answer runs ~2100 tokens, so 3000 is the variant that
    // finishes on its own - without one that ends on end_turn, all three cards
    // would read "cut off" and the cap would look like the only possible outcome.
    variants: [
      { id: "tiny", label: "max_tokens: 16", patch: { max_tokens: 16 } },
      { id: "small", label: "max_tokens: 60", patch: { max_tokens: 60 } },
      { id: "mid", label: "max_tokens: 400", patch: { max_tokens: 400 } },
      { id: "roomy", label: "max_tokens: 3000 — never reached", patch: { max_tokens: 3000 } },
    ],
  },

  {
    key: "stop_sequences",
    knob: "stop_sequences",
    kind: "hard",
    title: "A magic word that ends everything",
    plain:
      'The moment the model writes "5", generation stops and the "5" is cut from ' +
      "the text. Nothing asked it to stop and nothing went wrong - the API " +
      "pulled the plug mid-sentence.",
    base: {
      model: SONNET,
      max_tokens: 200,
      thinking: NO_THINKING,
      messages: [
        { role: "user", content: "Count from 1 to 10. One number per line." },
      ],
    },
    variants: [
      { id: "off", label: "No stop sequence", patch: {} },
      { id: "on", label: 'stop_sequences: ["5"]', patch: { stop_sequences: ["5"] } },
    ],
  },

  {
    key: "output_format",
    knob: "output_config.format",
    kind: "hard",
    title: "Filling in a form instead of talking",
    plain:
      "The first answer is prose because we asked for prose. The second is valid " +
      "JSON in that exact shape because the API constrained the decoder - the " +
      "model could not have answered any other way even if it wanted to.",
    base: {
      model: SONNET,
      max_tokens: 600,
      thinking: NO_THINKING,
      messages: [{ role: "user", content: "Tell me about the Eiffel Tower." }],
    },
    variants: [
      { id: "prose", label: "Free prose", patch: {} },
      {
        id: "json",
        label: "Constrained to a JSON schema",
        patch: {
          output_config: {
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  city: { type: "string" },
                  height_meters: { type: "number" },
                  completed_year: { type: "integer" },
                  fun_fact: { type: "string" },
                },
                required: [
                  "name",
                  "city",
                  "height_meters",
                  "completed_year",
                  "fun_fact",
                ],
                additionalProperties: false,
              },
            },
          },
        },
      },
    ],
  },
];

// A patch value of null deletes the key, so a variant can say "no system prompt
// at all" rather than "an empty one".
function applyPatch(base, patch) {
  const request = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete request[key];
    else request[key] = value;
  }
  return request;
}

function extractText(message) {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || "(empty response)";
}

// Thinking blocks arrive whether or not you are allowed to read them: with
// display "omitted" the block is present and its text is empty. Reporting the
// count separately from the characters is what makes that visible.
function extractThinking(message) {
  const blocks = message.content.filter((block) => block.type === "thinking");
  return {
    blocks: blocks.length,
    text: blocks.map((block) => block.thinking || "").join("\n").trim(),
  };
}

function describeError(error) {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Error: invalid or missing ANTHROPIC_API_KEY.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Error: rate limited - try again in a moment.";
  }
  if (error instanceof Anthropic.APIError) {
    return `Error ${error.status}: ${error.message}`;
  }
  return `Error: ${error?.message ?? String(error)}`;
}

export function createLabRouter(client) {
  const router = express.Router();

  // Definitions only - the frontend renders every experiment before any call is
  // made, so you can read what is about to be sent.
  router.get("/experiments", (_req, res) => {
    res.json({
      experiments: EXPERIMENTS.map((exp) => ({
        key: exp.key,
        knob: exp.knob,
        kind: exp.kind,
        title: exp.title,
        plain: exp.plain,
        base: exp.base,
        variants: exp.variants.map((v) => ({
          id: v.id,
          label: v.label,
          patch: v.patch,
        })),
      })),
    });
  });

  router.post("/run", async (req, res) => {
    const { experiment } = req.body ?? {};
    const exp = EXPERIMENTS.find((e) => e.key === experiment);

    if (!exp) {
      return res.status(400).json({ error: `Unknown experiment "${experiment}".` });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({
        error:
          "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.",
      });
    }

    const settled = await Promise.allSettled(
      exp.variants.map(async (variant) => {
        const request = applyPatch(exp.base, variant.patch);
        const startedAt = Date.now();
        const response = await client.messages.create(request);
        return { response, ms: Date.now() - startedAt };
      })
    );

    const results = settled.map((outcome, i) => {
      const variant = exp.variants[i];

      if (outcome.status === "rejected") {
        return { id: variant.id, error: describeError(outcome.reason) };
      }

      const { response, ms } = outcome.value;
      const text = extractText(response);
      const thinking = extractThinking(response);

      return {
        id: variant.id,
        text,
        thinking,
        meta: {
          model: response.model,
          stopReason: response.stop_reason,
          truncated: response.stop_reason === "max_tokens",
          outputTokens: response.usage.output_tokens,
          inputTokens: response.usage.input_tokens,
          charCount: text.length,
          ms,
        },
      };
    });

    res.json({ results });
  });

  return router;
}
