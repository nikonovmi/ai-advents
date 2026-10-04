import Ajv from "ajv";

/**
 * **JSON Schema, as the planner and the runner need it.** Pure.
 *
 * Two jobs: validate a value against a tool's schema (ajv, compiled once per
 * schema object), and walk a template path (`results.0.title`) down a schema
 * to say whether it exists — without any value in hand, because a plan is
 * checked before anything runs.
 *
 * Servers write their schemas in whatever draft their SDK emits; the `$schema`
 * line is dropped before compiling, and ajv is not strict about keywords it
 * does not know (Notion's schemas carry a few).
 */

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
/** @type {WeakMap<object, import("ajv").ValidateFunction>} */
const compiled = new WeakMap();

/**
 * @param {object} schema
 * @returns {import("ajv").ValidateFunction}
 * @throws when the schema itself is not valid JSON Schema.
 */
export function compile(schema) {
  let validate = compiled.get(schema);
  if (!validate) {
    const { $schema: _draft, ...rest } = schema;
    validate = ajv.compile(rest);
    compiled.set(schema, validate);
  }
  return validate;
}

/** Whether `schema` compiles; the reason when it does not. */
export function schemaProblem(schema) {
  try {
    compile(schema);
    return null;
  } catch (err) {
    return err?.message ?? String(err);
  }
}

/**
 * Validate a value; every problem as `path: message`.
 *
 * @param {object} schema
 * @param {unknown} value
 * @param {{ ignore?: (instancePath: string) => boolean }} [options] - Drop the
 *   problems at paths this says to ignore (the planner's: a value that is still
 *   a template, and will only be known when the step runs).
 * @returns {string[]}
 */
export function validationErrors(schema, value, { ignore = () => false } = {}) {
  const validate = compile(schema);
  if (validate(value)) return [];
  const seen = new Set();
  const out = [];
  for (const error of validate.errors ?? []) {
    if (ignore(error.instancePath)) continue;
    const where = error.instancePath ? error.instancePath.slice(1).replaceAll("/", ".") : "(top level)";
    const detail =
      error.keyword === "additionalProperties"
        ? `unknown field "${error.params.additionalProperty}"`
        : error.keyword === "enum"
          ? `${error.message} (${error.params.allowedValues.map((v) => JSON.stringify(v)).join(", ")})`
          : error.message;
    const line = `${where}: ${detail}`;
    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

/** The value at an ajv `instancePath` ("/pages/0/content"), or undefined. */
export function valueAt(root, instancePath) {
  if (!instancePath) return root;
  let value = root;
  for (const raw of instancePath.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (value === null || typeof value !== "object") return undefined;
    value = value[key];
  }
  return value;
}

const typesOf = (schema) => (Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []);
const isNullOnly = (schema) => typesOf(schema).length > 0 && typesOf(schema).every((type) => type === "null");

/**
 * Walk a dotted path down a schema.
 *
 * @param {object} schema
 * @param {string[]} path
 * @returns {{ ok: true } | { ok: false, at: number, key: string, reason: string }}
 *   `at` is how many keys matched before the one that did not.
 */
export function walkPath(schema, path, at = 0) {
  if (at >= path.length) return { ok: true };
  if (!schema || typeof schema !== "object") return { ok: true };

  // A union (or an intersection, read loosely): fine if any branch has the
  // path. A `null` branch never has one, and is not worth reporting.
  const union = schema.anyOf ?? schema.oneOf ?? schema.allOf;
  if (Array.isArray(union)) {
    const tries = union.filter((branch) => !isNullOnly(branch)).map((branch) => walkPath(branch, path, at));
    if (!tries.length) return { ok: false, at, key: path[at], reason: "it is always null" };
    return tries.find((each) => each.ok) ?? tries.reduce((deepest, each) => (each.at > deepest.at ? each : deepest));
  }

  const key = path[at];
  const types = typesOf(schema);
  const isObject = types.includes("object") || schema.properties || schema.additionalProperties;
  const isArray = types.includes("array") || schema.items || schema.prefixItems;

  if (isObject && !(isArray && /^\d+$/.test(key))) {
    if (schema.properties && Object.hasOwn(schema.properties, key)) return walkPath(schema.properties[key], path, at + 1);
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      return walkPath(schema.additionalProperties, path, at + 1);
    }
    if (!schema.properties && schema.additionalProperties !== false) return { ok: true };
    const known = Object.keys(schema.properties ?? {});
    return { ok: false, at, key, reason: known.length ? `it has ${known.join(", ")}` : "it has no fields" };
  }
  if (isArray) {
    if (!/^\d+$/.test(key)) return { ok: false, at, key, reason: "it is a list: use an index, like .0" };
    const index = Number(key);
    if (Array.isArray(schema.prefixItems) && index < schema.prefixItems.length) return walkPath(schema.prefixItems[index], path, at + 1);
    return walkPath(schema.items ?? {}, path, at + 1);
  }
  if (!types.length) return { ok: true }; // `{}`: anything, so nothing more can be said.
  const kind = types.filter((type) => type !== "null").join(" or ") || "null";
  return { ok: false, at, key, reason: `it is a ${kind}, which has no fields` };
}

/**
 * A copy of an object schema without one property — how `scheduleId` is kept
 * out of what the planner and the model see.
 */
export function withoutField(schema, field) {
  if (!schema?.properties || !(field in schema.properties)) return schema;
  const { [field]: _dropped, ...properties } = schema.properties;
  const out = { ...schema, properties };
  if (Array.isArray(schema.required)) out.required = schema.required.filter((name) => name !== field);
  return out;
}
