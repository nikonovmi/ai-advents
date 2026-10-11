/**
 * **What a pipeline step may look like.** Pure; no SQL, no MCP.
 *
 * A schedule's `steps` is an ordered list, run by first-agent one after the
 * other. Two kinds:
 *
 *   - `{ kind: "tool", server, tool, args?, why? }` — one MCP call, made by code;
 *   - `{ kind: "prompt", text, allowTools?, format?, outputSchema?, why? }` — one
 *     LLM call from a fresh context. `format: "json"` makes its output a JSON
 *     object (of `outputSchema`'s shape, when one is given) instead of text.
 *
 * `why` is the planner's one line on why it chose the step; it is shown, never
 * executed.
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
export const MAX_WHY_CHARS = 500;
export const MAX_SCHEMA_CHARS = 8000;
export const STEP_KINDS = ["tool", "prompt"];
export const FORMATS = ["text", "json"];

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
 * @returns {Array<{ kind: "tool", server: string, tool: string, args: object, why?: string } | { kind: "prompt", text: string, allowTools: boolean, format?: "text" | "json", outputSchema?: object, why?: string }>}
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
      extraKeys(step, ["kind", "server", "tool", "args", "why"], say);
      if (typeof step.server !== "string" || !NAME.test(step.server)) say("needs a server.");
      if (typeof step.tool !== "string" || !NAME.test(step.tool)) say("needs a tool.");
      const args = step.args ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args)) say("args must be a JSON object.");
      else if (JSON.stringify(args).length > MAX_ARGS_CHARS) say(`args must be at most ${MAX_ARGS_CHARS} characters of JSON.`);
      out = { kind: "tool", server: step.server, tool: step.tool, args };
    } else {
      extraKeys(step, ["kind", "text", "allowTools", "format", "outputSchema", "why"], say);
      if (typeof step.text !== "string" || !step.text.trim()) say("needs a prompt text.");
      else if (step.text.length > MAX_PROMPT_CHARS) say(`text must be at most ${MAX_PROMPT_CHARS} characters.`);
      if (step.allowTools !== undefined && typeof step.allowTools !== "boolean") say("allowTools must be true or false.");
      out = { kind: "prompt", text: step.text, allowTools: step.allowTools === true };
      if (step.format !== undefined) {
        if (!FORMATS.includes(step.format)) say(`format must be "text" or "json".`);
        out.format = step.format;
      }
      if (step.outputSchema !== undefined) {
        const schema = step.outputSchema;
        if (step.format !== "json") say(`outputSchema needs format "json".`);
        if (!schema || typeof schema !== "object" || Array.isArray(schema)) say("outputSchema must be a JSON Schema object.");
        else if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS) say(`outputSchema must be at most ${MAX_SCHEMA_CHARS} characters of JSON.`);
        out.outputSchema = schema;
      }
    }
    if (step.why !== undefined) {
      if (typeof step.why !== "string") say("why must be a string.");
      else if (step.why.length > MAX_WHY_CHARS) say(`why must be at most ${MAX_WHY_CHARS} characters.`);
      out.why = step.why;
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

export const PROPOSAL_REASONS = ["generated", "repair"];
export const MAX_PROPOSAL_CHARS = 200_000;

/**
 * **A plan waiting for a person to accept or discard it.** Null, or
 * `{ steps, notes?, createdAt, reason, errors?, run? }`.
 *
 * Its steps are checked for shape only — a list of objects — not with
 * `validateSteps`: a repair the planner could not make valid is still stored,
 * with its `errors`, so the panel can show what went wrong; it just cannot be
 * accepted. Accepting is what puts steps through the full check, as the plan.
 * `run` is the failed run a repair answers: `{ id, error }`.
 *
 * @param {unknown} proposal
 * @returns {object | null}
 */
export function validateProposal(proposal) {
  if (proposal === null) return null;
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) throw new StepsError(["proposal must be an object or null."]);
  const problems = [];
  const say = (text) => problems.push(`Proposal: ${text}`);
  extraKeys(proposal, ["steps", "notes", "createdAt", "reason", "errors", "run"], say);
  const { steps, notes, createdAt, reason, errors, run } = proposal;
  if (!Array.isArray(steps)) say("steps must be an array.");
  else if (steps.length > MAX_STEPS) say(`at most ${MAX_STEPS} steps.`);
  else if (steps.some((step) => !step || typeof step !== "object" || Array.isArray(step))) say("every step must be an object.");
  if (notes !== undefined && typeof notes !== "string") say("notes must be a string.");
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) say("createdAt must be an ISO time.");
  if (!PROPOSAL_REASONS.includes(reason)) say(`reason must be "generated" or "repair".`);
  if (errors !== undefined && !(Array.isArray(errors) && errors.every((error) => typeof error === "string"))) say("errors must be a list of strings.");
  if (run !== undefined && (!run || typeof run !== "object" || !Number.isInteger(run.id))) say("run must be { id, error }.");
  if (JSON.stringify(proposal).length > MAX_PROPOSAL_CHARS) say(`must be at most ${MAX_PROPOSAL_CHARS} characters of JSON.`);
  if (problems.length) throw new StepsError(problems);
  return proposal;
}
