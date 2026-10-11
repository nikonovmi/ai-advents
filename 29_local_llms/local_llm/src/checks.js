/**
 * **The automatic check for each request type.** Every check takes the
 * model's text and the request's `check` block from eval/requests.json, and
 * returns `{ pass, detail }`, where `detail` says what was found.
 *
 * - `contains`: the answer contains every `expected` string (case-insensitive;
 *   an array item is a set of alternatives)
 * - `number`: the final number in the answer equals `expected`
 * - `json`: valid JSON, valid against the schema, with the `expected` values
 * - `grounded`: answered with the expected facts, or declined when `expect: "decline"`
 */

/** Lowercase, straight quotes, collapsed whitespace. */
export const normalize = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** Each needle is a string, or an array of alternatives of which one must appear. */
const containsAll = (text, needles) => {
  const t = normalize(text);
  const missing = needles.filter((n) => ![].concat(n).some((alt) => t.includes(normalize(alt))));
  return { ok: missing.length === 0, missing: missing.map((n) => [].concat(n).join(" | ")) };
};
const describe = (needles) => needles.map((n) => [].concat(n).join(" | ")).join(", ");

const DECLINE = /\bi (?:do not|don't) know\b/;

/** True when the answer declines ("I don't know"). */
export const isDecline = (text) => DECLINE.test(normalize(text));

/**
 * The number the answer settles on: the one after "Answer:" if there is one,
 * else the last number in the text. Thousands separators are dropped.
 */
export function finalNumber(text) {
  const t = String(text ?? "").replace(/(\d),(?=\d{3}\b)/g, "$1");
  const tagged = [...t.matchAll(/answer\s*[:=]\s*\**\s*\$?(-?\d+(?:\.\d+)?)/gi)];
  if (tagged.length) return Number(tagged.at(-1)[1]);
  const all = [...t.matchAll(/-?\d+(?:\.\d+)?/g)];
  return all.length ? Number(all.at(-1)[0]) : null;
}

/**
 * Enough JSON Schema for the request set: type (incl. integer), properties,
 * required, additionalProperties: false, enum, pattern. Returns error strings.
 */
export function validateSchema(value, schema, path = "$") {
  const errors = [];
  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  if (schema.type) {
    const ok =
      schema.type === "integer" ? Number.isInteger(value) : schema.type === "number" ? typeof value === "number" && Number.isFinite(value) : typeOf(value) === schema.type;
    if (!ok) return [`${path}: expected ${schema.type}, got ${typeOf(value)}`];
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (schema.pattern && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }
  if (schema.type === "object") {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}.${key}: missing`);
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (sub) errors.push(...validateSchema(v, sub, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
    }
  }
  return errors;
}

const sameValue = (got, want) => (typeof want === "string" && typeof got === "string" ? normalize(got) === normalize(want) : got === want);

export const checks = {
  contains(text, { expected }) {
    const needles = [].concat(expected);
    const { ok, missing } = containsAll(text, needles);
    return { pass: ok, detail: ok ? `contains ${describe(needles)}` : `missing: ${missing.join(", ")}` };
  },

  number(text, { expected }) {
    const got = finalNumber(text);
    return { pass: got === expected, detail: got === expected ? `answer ${got}` : `got ${got ?? "no number"}, expected ${expected}` };
  },

  json(text, { schema, expected = {} }) {
    let value;
    try {
      value = JSON.parse(text);
    } catch (err) {
      return { pass: false, detail: `invalid JSON: ${err.message}` };
    }
    const errors = validateSchema(value, schema);
    if (errors.length) return { pass: false, detail: `schema: ${errors.join("; ")}` };
    const wrong = Object.entries(expected)
      .filter(([k, want]) => !sameValue(value[k], want))
      .map(([k, want]) => `${k}=${JSON.stringify(value[k])} (expected ${JSON.stringify(want)})`);
    return { pass: wrong.length === 0, detail: wrong.length ? `wrong values: ${wrong.join("; ")}` : "valid JSON, schema ok, all values match" };
  },

  grounded(text, { expect, expected = [] }) {
    const declined = isDecline(text);
    if (expect === "decline") {
      return { pass: declined, detail: declined ? "declined" : "answered instead of declining" };
    }
    if (declined) return { pass: false, detail: "declined an answerable question" };
    const { ok, missing } = containsAll(text, expected);
    return { pass: ok, detail: ok ? `contains ${describe(expected)}` : `missing: ${missing.join(", ")}` };
  },
};

/** Run the check named by `check.type`. */
export function runCheck(text, check) {
  const fn = checks[check.type];
  if (!fn) throw new Error(`unknown check type: ${check.type}`);
  return fn(text, check);
}
