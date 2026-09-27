/**
 * **What a pipeline step may look like.** Pure; no SQL, no MCP.
 *
 * A schedule's `steps` is an ordered list, run by first-agent one after the
 * other. Two kinds:
 *
 *   - `{ kind: "tool", server, tool, args? }` — one MCP call, made by code;
 *   - `{ kind: "prompt", text, allowTools? }` — one LLM call from a fresh context.
 *
 * Strings anywhere in a step may hold templates — `{{prev}}`, `{{steps.N}}`
 * (1-based), `{{now}}`, and a dotted path after the first two
 * (`{{steps.1.results.0.title}}`). The server never resolves them; it only
 * checks that each one names something that will exist when the step runs: an
 * earlier step, never this one or a later one.
 */

export const MAX_STEPS = 20;
export const MAX_PROMPT_CHARS = 8000;
export const MAX_ARGS_CHARS = 20000;
export const STEP_KINDS = ["tool", "prompt"];

const TEMPLATE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const REFERENCE = /^(prev|now|steps\.(\d+))((?:\.[^.\s]+)*)$/;
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** A step list that does not pass, with every reason in one sentence. */
export class StepsError extends Error {
  constructor(problems) {
    super(problems.join(" "));
    this.name = "StepsError";
    this.problems = problems;
  }
}

/**
 * Check a whole list and hand back a clean copy (unknown keys are refused, not
 * dropped, so a typo is an error rather than a silently ignored field).
 *
 * @param {unknown} steps
 * @returns {Array<{ kind: "tool", server: string, tool: string, args: object } | { kind: "prompt", text: string, allowTools: boolean }>}
 */
export function validateSteps(steps) {
  if (!Array.isArray(steps)) throw new StepsError(["steps must be an array."]);
  if (steps.length > MAX_STEPS) throw new StepsError([`At most ${MAX_STEPS} steps.`]);

  const problems = [];
  const clean = steps.map((step, i) => {
    const n = i + 1;
    const say = (text) => problems.push(`Step ${n}: ${text}`);
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      say("must be an object.");
      return null;
    }
    if (!STEP_KINDS.includes(step.kind)) {
      say(`kind must be "tool" or "prompt".`);
      return null;
    }

    let out;
    if (step.kind === "tool") {
      extraKeys(step, ["kind", "server", "tool", "args"], say);
      if (typeof step.server !== "string" || !NAME.test(step.server)) say("needs a server.");
      if (typeof step.tool !== "string" || !NAME.test(step.tool)) say("needs a tool.");
      const args = step.args ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args)) say("args must be a JSON object.");
      else if (JSON.stringify(args).length > MAX_ARGS_CHARS) say(`args must be at most ${MAX_ARGS_CHARS} characters of JSON.`);
      out = { kind: "tool", server: step.server, tool: step.tool, args };
    } else {
      extraKeys(step, ["kind", "text", "allowTools"], say);
      if (typeof step.text !== "string" || !step.text.trim()) say("needs a prompt text.");
      else if (step.text.length > MAX_PROMPT_CHARS) say(`text must be at most ${MAX_PROMPT_CHARS} characters.`);
      if (step.allowTools !== undefined && typeof step.allowTools !== "boolean") say("allowTools must be true or false.");
      out = { kind: "prompt", text: step.text, allowTools: step.allowTools === true };
    }

    for (const problem of templateProblems(out, n)) say(problem);
    return out;
  });

  if (problems.length) throw new StepsError(problems);
  return clean;
}

function extraKeys(step, allowed, say) {
  const extra = Object.keys(step).filter((key) => !allowed.includes(key));
  if (extra.length) say(`unknown field${extra.length > 1 ? "s" : ""} ${extra.map((key) => `"${key}"`).join(", ")}.`);
}

/** Every template in a step that cannot resolve when step `n` runs. */
export function templateProblems(step, n) {
  const problems = [];
  for (const text of strings(step.kind === "tool" ? step.args : step.text)) {
    for (const [whole, inner] of text.matchAll(TEMPLATE)) {
      const ref = REFERENCE.exec(inner);
      if (!ref) {
        problems.push(`${whole} is not a template: use {{prev}}, {{steps.N}} or {{now}}.`);
      } else if (ref[1] === "prev" && n === 1) {
        problems.push(`${whole} has no previous step to refer to.`);
      } else if (ref[1] === "now" && ref[3]) {
        problems.push(`${whole}: {{now}} has no fields.`);
      } else if (ref[2] !== undefined) {
        const target = Number(ref[2]);
        if (target < 1 || target >= n) problems.push(`${whole} must refer to an earlier step (1 to ${n - 1}).`.replace("(1 to 0)", "(there is none)"));
      }
    }
  }
  return problems;
}

/** Every string value inside a value. Keys are never resolved, so they are not checked. */
function* strings(value) {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else if (value && typeof value === "object") for (const item of Object.values(value)) yield* strings(item);
}
