// The four reasoning approaches. Each is an async fn (problem) => {
//   recommendation, transcript: [{label, role, content}], usage, latencyMs
// }
// Keeping them side by side in one file makes the prompts easy to diff.
import { client, limit, textOf, emptyUsage, addUsage } from "./client.js";

export const SOLVER_MODEL = "claude-haiku-4-5-20251001";
export const SOLVER_MAX_TOKENS = 2000;
// Haiku 4.5 still accepts sampling parameters, so the solver can pin temperature 0. The judge
// cannot — claude-sonnet-5 rejects temperature/top_p/top_k outright (see judge.js).
export const SOLVER_TEMPERATURE = 0;

// Every solver prompt ends with this so the frontend always has a one-line
// summary to put in a table cell.
export const CLOSING_INSTRUCTION = `

Keep the whole response under 1,000 words so it fits the output budget, and end it with
exactly one final line of the form:
RECOMMENDATION: <one sentence stating what you ship on 1 May and how you build it>`;

/** One solver call. Model/max_tokens/temperature are fixed across all methods. */
async function solverCall({ system, messages }) {
  return limit(() =>
    client.messages.create({
      model: SOLVER_MODEL,
      max_tokens: SOLVER_MAX_TOKENS,
      temperature: SOLVER_TEMPERATURE,
      ...(system ? { system } : {}),
      messages,
    })
  );
}

/** True when the model ran out of budget mid-answer, which eats the RECOMMENDATION line. */
function wasTruncated(...messages) {
  return messages.some((m) => m.stop_reason === "max_tokens");
}

/**
 * Pull the RECOMMENDATION line out of an answer. Takes the last one, since a
 * model that reasons out loud may mention the format before using it.
 */
export function extractRecommendation(text) {
  // Models dress the line up in markdown ("**RECOMMENDATION:** ...", "## RECOMMENDATION: ...",
  // "- RECOMMENDATION: ..."), so tolerate leading and trailing emphasis rather than losing
  // the cell to a formatting choice.
  const pattern = /^[\s>#*_-]*RECOMMENDATION[\s*_]*:[\s*_]*(.+?)[\s*_]*$/i;
  let found = null;
  for (const line of (text ?? "").split(/\r?\n/)) {
    const match = line.match(pattern);
    if (match) found = match[1].trim();
  }
  return found;
}

// --- 1. direct ---------------------------------------------------------------

async function direct(problem) {
  const started = Date.now();
  const usage = emptyUsage();

  const prompt = problem + CLOSING_INSTRUCTION;
  const message = await solverCall({
    messages: [{ role: "user", content: prompt }],
  });
  addUsage(usage, message);
  const answer = textOf(message);

  return {
    answer,
    recommendation: extractRecommendation(answer),
    truncated: wasTruncated(message),
    transcript: [
      { label: "Prompt", role: "user", content: prompt },
      { label: "Answer", role: "assistant", content: answer },
    ],
    usage,
    latencyMs: Date.now() - started,
  };
}

// --- 2. step_by_step ---------------------------------------------------------

async function stepByStep(problem) {
  const started = Date.now();
  const usage = emptyUsage();

  const prompt =
    problem +
    "\n\nSolve this step-by-step, showing your reasoning." +
    CLOSING_INSTRUCTION;

  const message = await solverCall({
    messages: [{ role: "user", content: prompt }],
  });
  addUsage(usage, message);
  const answer = textOf(message);

  return {
    answer,
    recommendation: extractRecommendation(answer),
    truncated: wasTruncated(message),
    transcript: [
      { label: "Prompt", role: "user", content: prompt },
      { label: "Answer", role: "assistant", content: answer },
    ],
    usage,
    latencyMs: Date.now() - started,
  };
}

// --- 3. meta_prompt ----------------------------------------------------------

async function metaPrompt(problem) {
  const started = Date.now();
  const usage = emptyUsage();

  const metaRequest = `You are a prompt engineer. Below is a problem someone wants a language model to tackle.

Write the best possible prompt for tackling it: one that pushes the model toward the framing, tradeoffs, mechanisms, legal exposure, concreteness and stated uncertainty that a genuinely good answer would need.

The model answering your prompt has a hard budget of 2000 output tokens (roughly 1,000
words), so do not ask for more sections or detail than fit in that.

Return the prompt only. No preamble, no commentary, no quotation marks around it.

--- PROBLEM ---
${problem}
--- END PROBLEM ---`;

  const metaMessage = await solverCall({
    messages: [{ role: "user", content: metaRequest }],
  });
  addUsage(usage, metaMessage);
  const generatedPrompt = textOf(metaMessage);

  // Append the closing instruction ourselves rather than trusting the generated
  // prompt to have carried it through — the table depends on that line existing.
  const solvePrompt = generatedPrompt + CLOSING_INSTRUCTION;

  const solveMessage = await solverCall({
    messages: [{ role: "user", content: solvePrompt }],
  });
  addUsage(usage, solveMessage);
  const answer = textOf(solveMessage);

  return {
    answer,
    recommendation: extractRecommendation(answer),
    truncated: wasTruncated(metaMessage, solveMessage),
    transcript: [
      { label: "Meta-prompt request", role: "user", content: metaRequest },
      {
        label: "Generated prompt",
        role: "assistant",
        content: generatedPrompt,
      },
      { label: "Fresh call with generated prompt", role: "user", content: solvePrompt },
      { label: "Answer", role: "assistant", content: answer },
    ],
    usage,
    latencyMs: Date.now() - started,
  };
}

// --- 4. expert_panel ---------------------------------------------------------

const PANEL = [
  {
    key: "behaviour_change_researcher",
    label: "Behaviour-change researcher",
    system: `You are a behaviour-change researcher who works on smoking cessation.

Your job is to say what actually drives quitting and what merely decorates an app: which components have real evidence behind them, roughly how large those effects are, how much of the benefit survives being delivered through a phone, and where the literature is thin or contested.

Say plainly which components would carry the outcome and which are cosmetic. Do not invent precise citations, author names, or numbers you are not confident in - describe the state of the evidence and its strength instead.`,
  },
  {
    key: "shipping_engineer",
    label: "Shipping engineer",
    system: `You are an engineering lead who has shipped consumer mobile apps against fixed dates.

Your job is to say what two people can actually build in 8 weeks, and what that costs. Cover the mechanics: cross-platform versus native, what the backend really has to do for 400 users, which features can be run manually or half-manually behind the scenes at that scale, app store review time and rejection risk for a health-adjacent app, payments and subscription plumbing, and which parts of the plan quietly slip.

Be concrete about weeks, sequencing and what gets cut. Leave the pedagogy of quitting to someone else.`,
  },
  {
    key: "critic",
    label: "Critic",
    system: `You are a critic whose job is to attack the framing of the question rather than answer it on its own terms.

Challenge the assumptions: whether "worth the money" is a question the founder gets to answer at all, or one the 400 buyers answer; whether the honest move is to delay, or to say plainly what this will and will not be, rather than to ship a thinner product quietly; what someone who pre-paid 40 GBP for a year of a quit-smoking app was reasonably entitled to expect; and the ethics of shipping a half-working health product to people actively trying to quit, where a failed attempt has a real cost to them.

Be specific and adversarial, not vague. Where the framing is salvageable, say what it would have to be replaced with.`,
  },
];

async function expertPanel(problem) {
  const started = Date.now();
  const usage = emptyUsage();

  const expertPrompt = problem + CLOSING_INSTRUCTION;

  const expertMessages = await Promise.all(
    PANEL.map((expert) =>
      solverCall({
        system: expert.system,
        messages: [{ role: "user", content: expertPrompt }],
      })
    )
  );

  const experts = PANEL.map((expert, i) => {
    addUsage(usage, expertMessages[i]);
    return { ...expert, content: textOf(expertMessages[i]) };
  });

  const founderPrompt = `Three advisers have each written to you about the same decision. Their responses are reproduced verbatim below.

--- PROBLEM ---
${problem}
--- END PROBLEM ---

${experts
  .map(
    (expert) =>
      `--- ${expert.label.toUpperCase()} ---\n${expert.content}\n--- END ${expert.label.toUpperCase()} ---`
  )
  .join("\n\n")}

You are the founder. You have to decide. Produce a single final recommendation: weigh the three views against each other, say plainly where you are overruling one of them and why, name the bar you are holding yourself to, and commit to a concrete answer for 1 May - what you build, how you build it, and what you tell the 400 people who have already paid.${CLOSING_INSTRUCTION}`;

  const headMessage = await solverCall({
    system:
      "You are the founder. Your name is on the campaign, your money is at stake, and you are accountable for the decision. You cannot defer it.",
    messages: [{ role: "user", content: founderPrompt }],
  });
  addUsage(usage, headMessage);
  const answer = textOf(headMessage);

  return {
    answer,
    recommendation: extractRecommendation(answer),
    truncated: wasTruncated(...expertMessages, headMessage),
    transcript: [
      ...experts.map((expert) => ({
        label: expert.label,
        role: "assistant",
        content: expert.content,
      })),
      { label: "Founder brief", role: "user", content: founderPrompt },
      { label: "Founder (final)", role: "assistant", content: answer },
    ],
    usage,
    latencyMs: Date.now() - started,
  };
}

export const METHODS = {
  direct,
  step_by_step: stepByStep,
  meta_prompt: metaPrompt,
  expert_panel: expertPanel,
};

export const METHOD_KEYS = Object.keys(METHODS);

export const METHOD_LABELS = {
  direct: "Direct",
  step_by_step: "Step by step",
  meta_prompt: "Meta prompt",
  expert_panel: "Expert panel",
};
