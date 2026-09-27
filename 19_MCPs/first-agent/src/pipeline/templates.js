/**
 * **How data moves between pipeline steps.** Pure: no I/O, no clock of its own.
 *
 * Three names, each optionally followed by a dotted path into the value:
 *
 *   - `{{prev}}` — the previous step's output;
 *   - `{{steps.N}}` — step N's output, 1-based (`{{steps.1.results.0.title}}`);
 *   - `{{now}}` — the ISO time, read from the context's clock.
 *
 * Two ways to substitute:
 *
 *   - `resolve(value, context)` is for tool args. A string that is *exactly*
 *     one template becomes the raw value — an object stays an object, a number
 *     a number. Any other string is interpolated. Arrays and objects are walked;
 *     keys are left alone.
 *   - `interpolate(text, context)` is for prompt text: always a string, with
 *     objects `JSON.stringify`'d.
 *
 * A template that names a step that has not run, a path that leads nowhere, or
 * a name that is not one of the three throws a `TemplateError` — the runner
 * fails the step with its message rather than sending the model a blank.
 */

const TEMPLATE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const WHOLE = /^\{\{\s*([^{}]*?)\s*\}\}$/;
const REFERENCE = /^(prev|now|steps\.(\d+))((?:\.[^.\s]+)*)$/;

export class TemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = "TemplateError";
  }
}

/**
 * @typedef {object} TemplateContext
 * @property {unknown[]} steps - Outputs of the steps that have run, in order: `steps[0]` is step 1.
 * @property {() => number} [now] - The clock `{{now}}` reads. Default `Date.now`.
 */

/**
 * The value a single reference (the text between the braces) stands for.
 *
 * @param {string} reference - e.g. `prev`, `steps.2.title`, `now`.
 * @param {TemplateContext} context
 */
export function lookup(reference, { steps = [], now = Date.now } = {}) {
  const match = REFERENCE.exec(reference.trim());
  if (!match) throw new TemplateError(`{{${reference}}} is not a template: use {{prev}}, {{steps.N}} or {{now}}.`);
  const [, head, number, rest] = match;

  if (head === "now") {
    if (rest) throw new TemplateError(`{{${reference}}}: {{now}} has no fields.`);
    return new Date(now()).toISOString();
  }

  let value;
  if (head === "prev") {
    if (!steps.length) throw new TemplateError(`{{${reference}}} refers to a previous step, and there is none.`);
    value = steps[steps.length - 1];
  } else {
    const n = Number(number);
    if (n < 1 || n > steps.length) {
      throw new TemplateError(`{{${reference}}} refers to step ${n}, which has not run (${steps.length ? `steps 1–${steps.length} have` : "no step has"}).`);
    }
    value = steps[n - 1];
  }

  const path = rest ? rest.slice(1).split(".") : [];
  for (const [i, key] of path.entries()) {
    const container = value;
    if (container === null || typeof container !== "object" || !Object.hasOwn(container, key)) {
      const at = [head === "prev" ? "prev" : `steps.${number}`, ...path.slice(0, i)].join(".");
      throw new TemplateError(`{{${reference}}}: ${at} has no "${key}".`);
    }
    value = container[key];
  }
  return value;
}

/** A value as it reads inside a sentence: strings as they are, everything else as JSON. */
export function asText(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}

/**
 * Text with every template replaced by its value as text.
 *
 * @param {string} text
 * @param {TemplateContext} context
 * @returns {string}
 */
export function interpolate(text, context) {
  return String(text).replace(TEMPLATE, (_whole, reference) => asText(lookup(reference, context)));
}

/**
 * Tool args (or any JSON value) with templates resolved: a string that is one
 * whole template becomes the raw value, anything else is interpolated.
 *
 * @template T
 * @param {T} template
 * @param {TemplateContext} context
 * @returns {unknown}
 */
export function resolve(template, context) {
  if (typeof template === "string") {
    const whole = WHOLE.exec(template);
    return whole ? lookup(whole[1], context) : interpolate(template, context);
  }
  if (Array.isArray(template)) return template.map((item) => resolve(item, context));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, resolve(value, context)]));
  }
  return template;
}
