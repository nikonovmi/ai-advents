import { schemaProblem, validationErrors, valueAt, walkPath } from "./schemas.js";
import { hasTemplate, templatesIn } from "./templates.js";

/**
 * **Is this plan runnable, before anything runs?** Pure: a plan and a catalog
 * in, a list of sentences out (empty means yes).
 *
 * The Day 19 rules — kinds, required fields, templates that only look back —
 * are the scheduler's (`scheduler_mcp_server/src/steps.js`), repeated here so
 * the planner hears every problem at once, in the same words. On top of them,
 * what only the app can know, because it has the catalog:
 *
 *   - every tool step names a tool that is in the catalog (and whose server is
 *     up);
 *   - its args validate against that tool's inputSchema, except where a value
 *     is still a template — that is only known when the step runs;
 *   - every template path (`{{steps.2.results.0.imdbId}}`) exists in the
 *     output shape of the step it points at: a tool's outputSchema, or a json
 *     prompt step's. A step whose shape is unknown — a tool that declares none,
 *     a text prompt — can be used whole, but its fields cannot be reached into.
 *
 * @typedef {{ name: string, server: string, tool: string, description?: string, inputSchema?: object, outputSchema?: object }} CatalogTool
 * @typedef {{ tools: CatalogTool[], down: Array<{ server: string, error: string }> }} Catalog
 */

export const MAX_PLAN_STEPS = 20;
export const MAX_PROMPT_CHARS = 8000;
export const MAX_ARGS_CHARS = 20000;
export const FORMATS = ["text", "json"];
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** What a step is called in a sentence: `omdb.get_movie`, `prompt (json)`. */
export function stepName(step) {
  if (step?.kind === "tool") return `${step.server}.${step.tool}`;
  return step?.format === "json" ? "prompt (json)" : "prompt";
}

/**
 * @param {unknown} steps
 * @param {Catalog} catalog
 * @returns {string[]} Every problem, one sentence each, "Step N (name): …".
 */
export function validatePlan(steps, catalog) {
  if (!Array.isArray(steps) || !steps.length) return ["The plan has no steps."];
  if (steps.length > MAX_PLAN_STEPS) return [`The plan has ${steps.length} steps; at most ${MAX_PLAN_STEPS}.`];

  const tools = new Map(catalog.tools.map((tool) => [tool.name, tool]));
  const down = new Map(catalog.down.map(({ server, error }) => [server, error]));
  const problems = [];
  /** What each step's output looks like, as far as can be known now. @type {Array<{ schema?: object, unknown?: string, invalid?: true }>} */
  const shapes = [];

  steps.forEach((step, i) => {
    const n = i + 1;
    const say = (text) => problems.push(`Step ${n} (${stepName(step)}): ${text}`);
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      problems.push(`Step ${n}: must be an object.`);
      shapes.push({ invalid: true });
      return;
    }
    if (step.why !== undefined && typeof step.why !== "string") say("why must be a sentence.");

    if (step.kind === "tool") {
      shapes.push(checkTool(step, { tools, down, say }));
      for (const problem of templateProblems(step.args, n, shapes)) say(problem);
    } else if (step.kind === "prompt") {
      shapes.push(checkPrompt(step, say));
      for (const problem of templateProblems(step.text, n, shapes)) say(problem);
    } else {
      problems.push(`Step ${n}: kind must be "tool" or "prompt".`);
      shapes.push({ invalid: true });
    }
  });
  return problems;
}

function checkTool(step, { tools, down, say }) {
  extraKeys(step, ["kind", "server", "tool", "args", "why"], say);
  if (typeof step.server !== "string" || !NAME.test(step.server) || typeof step.tool !== "string" || !NAME.test(step.tool)) {
    say("needs a tool from the catalog, as server.tool.");
    return { invalid: true };
  }
  const args = step.args ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    say("args must be a JSON object.");
    return { invalid: true };
  }
  if (JSON.stringify(args).length > MAX_ARGS_CHARS) say(`args must be at most ${MAX_ARGS_CHARS} characters of JSON.`);

  const name = `${step.server}.${step.tool}`;
  const tool = tools.get(name);
  if (!tool) {
    say(
      down.has(step.server)
        ? `the ${step.server} server is down (${down.get(step.server)}), so none of its tools can be used.`
        : `${name} is not in the catalog. Use only the tools listed there, exactly as named.`
    );
    return { invalid: true };
  }

  // A value that is still a template is only known at run time: its type and
  // format are not checked here. Its path is, below.
  const ignore = (instancePath) => {
    const value = valueAt(args, instancePath);
    return typeof value === "string" && hasTemplate(value);
  };
  try {
    for (const problem of validationErrors(tool.inputSchema ?? { type: "object" }, args, { ignore })) say(`args.${problem}`.replace("args.(top level)", "args"));
  } catch (err) {
    // A server's schema ajv cannot compile is the server's problem, not the plan's.
    console.warn(`[planner] could not compile ${name}'s inputSchema: ${err?.message ?? err}`);
  }
  return tool.outputSchema ? { schema: tool.outputSchema } : { unknown: `${name} declares no outputSchema` };
}

function checkPrompt(step, say) {
  extraKeys(step, ["kind", "text", "format", "outputSchema", "allowTools", "why"], say);
  if (typeof step.text !== "string" || !step.text.trim()) say("needs a prompt text.");
  else if (step.text.length > MAX_PROMPT_CHARS) say(`text must be at most ${MAX_PROMPT_CHARS} characters.`);
  if (step.allowTools !== undefined && typeof step.allowTools !== "boolean") say("allowTools must be true or false.");
  const format = step.format ?? "text";
  if (!FORMATS.includes(format)) {
    say(`format must be "text" or "json".`);
    return { invalid: true };
  }
  if (format === "text") {
    if (step.outputSchema !== undefined) say(`outputSchema needs format "json".`);
    return { schema: { type: "string" }, text: true };
  }

  const schema = step.outputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    say('a json step needs an outputSchema: a JSON Schema { type: "object", properties, required } of what it returns.');
    return { invalid: true };
  }
  if (schema.type !== "object") say('its outputSchema must have type "object".');
  const problem = schemaProblem(schema);
  if (problem) {
    say(`its outputSchema is not valid JSON Schema: ${problem}.`);
    return { invalid: true };
  }
  return { schema };
}

/**
 * Every template inside a step (args or text) that cannot resolve when step
 * `n` runs, or that reaches for a field the target step's shape does not have.
 */
function templateProblems(value, n, shapes) {
  const problems = [];
  for (const text of strings(value)) {
    for (const ref of templatesIn(text)) {
      if (ref.bad) {
        problems.push(`${ref.whole} is not a template: use {{prev}}, {{steps.N}} or {{now}}.`);
        continue;
      }
      if (ref.name === "now") {
        if (ref.path.length) problems.push(`${ref.whole}: {{now}} has no fields.`);
        continue;
      }
      const target = ref.name === "prev" ? n - 1 : ref.step;
      if (ref.name === "prev" && n === 1) {
        problems.push(`${ref.whole} has no previous step to refer to.`);
        continue;
      }
      if (target < 1 || target >= n) {
        problems.push(`${ref.whole} must refer to an earlier step (${n > 1 ? `1 to ${n - 1}` : "there is none"}).`);
        continue;
      }
      if (!ref.path.length) continue;

      const shape = shapes[target - 1];
      const head = ref.name === "prev" ? "prev" : `steps.${target}`;
      if (shape.invalid) continue; // Already reported at that step.
      if (shape.unknown) {
        problems.push(
          `${ref.whole}: step ${target}'s output shape is unknown (${shape.unknown}), so its fields cannot be referenced. ` +
            `Use {{steps.${target}}} whole, or add a json prompt step that reshapes it.`
        );
        continue;
      }
      if (shape.text) {
        problems.push(`${ref.whole}: step ${target} is a text prompt, its output is a plain string with no fields. Give it format "json" and an outputSchema.`);
        continue;
      }
      const walked = walkPath(shape.schema, ref.path);
      if (!walked.ok) {
        const at = [head, ...ref.path.slice(0, walked.at)].join(".");
        problems.push(`${ref.whole}: ${at} has no "${walked.key}" (${walked.reason}).`);
      }
    }
  }
  return problems;
}

function extraKeys(step, allowed, say) {
  const extra = Object.keys(step).filter((key) => !allowed.includes(key));
  if (extra.length) say(`unknown field${extra.length > 1 ? "s" : ""} ${extra.map((key) => `"${key}"`).join(", ")}.`);
}

/** Every string value inside a value. Keys are never resolved, so they are not checked. */
function* strings(value) {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else if (value && typeof value === "object") for (const item of Object.values(value)) yield* strings(item);
}
