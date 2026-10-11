import assert from "node:assert/strict";
import test from "node:test";

import { TemplateError, interpolate, lookup, resolve } from "./templates.js";

/** Pure functions: a list of outputs and a clock in, a value out. */

const T0 = Date.parse("2026-09-27T12:00:00.000Z");
const clock = () => T0;

const SEARCH = { results: [{ title: "Batman", year: "1989", imdbId: "tt0096895" }, { title: "Batman Begins", year: "2005" }], total: 2 };
const context = { steps: [SEARCH, "Three sentences about Batman."], now: clock };

test("a string that is exactly one template is the raw value; objects stay objects", () => {
  assert.deepEqual(resolve("{{steps.1}}", context), SEARCH);
  assert.equal(resolve("{{ prev }}", context), "Three sentences about Batman.");
  assert.equal(resolve("{{steps.1.total}}", context), 2);
  assert.deepEqual(resolve("{{steps.1.results.0}}", context), SEARCH.results[0]);
});

test("anything else is interpolated as a string, objects JSON.stringify'd", () => {
  assert.equal(resolve("Found {{steps.1.total}}: {{steps.1.results.1.title}}", context), "Found 2: Batman Begins");
  assert.equal(resolve("raw: {{steps.1.results.0}}", context), `raw: ${JSON.stringify(SEARCH.results[0])}`);
  // Two templates side by side are not "exactly one".
  assert.equal(resolve("{{steps.1.total}}{{steps.1.total}}", context), "22");
  assert.equal(interpolate("Summarize:\n{{steps.1}}", context), `Summarize:\n${JSON.stringify(SEARCH)}`);
  // A prompt is always text, even when it is a whole template.
  assert.equal(interpolate("{{steps.1.total}}", context), "2");
});

test("args are walked: arrays and nested objects resolve, keys are left alone, other types pass", () => {
  const args = {
    creation_mode: "draft",
    pages: [{ properties: { title: "Batman summary {{now}}" }, content: "{{prev}}" }],
    "{{prev}}": 1,
    count: 3,
    flag: true,
    nothing: null,
  };
  assert.deepEqual(resolve(args, context), {
    creation_mode: "draft",
    pages: [{ properties: { title: "Batman summary 2026-09-27T12:00:00.000Z" }, content: "Three sentences about Batman." }],
    "{{prev}}": 1,
    count: 3,
    flag: true,
    nothing: null,
  });
});

test("{{now}} reads the injected clock, as ISO", () => {
  let at = T0;
  const moving = { steps: [], now: () => at };
  assert.equal(resolve("{{now}}", moving), "2026-09-27T12:00:00.000Z");
  at += 1500;
  assert.equal(interpolate("at {{now}}", moving), "at 2026-09-27T12:00:01.500Z");
  assert.throws(() => lookup("now.year", moving), /has no fields/);
});

test("a missing step, a path to nothing or an unknown name is a TemplateError", () => {
  const cases = [
    ["{{steps.3}}", { steps: [1, 2] }, /step 3, which has not run \(steps 1–2 have\)/],
    ["{{steps.0}}", { steps: [1] }, /step 0/],
    ["{{prev}}", { steps: [] }, /there is none/],
    ["{{steps.1.results.5.title}}", context, /steps\.1\.results has no "5"/],
    ["{{prev.length}}", context, /prev has no "length"/],
    ["{{previous}}", context, /not a template/],
    ["x {{steps.9}} y", context, /step 9/],
  ];
  for (const [template, ctx, message] of cases) {
    assert.throws(() => resolve(template, ctx), (err) => err instanceof TemplateError && message.test(err.message), template);
  }
  // Inside args too, however deep.
  assert.throws(() => resolve({ a: [{ b: "{{steps.4}}" }] }, context), TemplateError);
});

test("text without templates is returned unchanged", () => {
  assert.equal(interpolate("plain {text} and {{ unclosed", context), "plain {text} and {{ unclosed");
  assert.deepEqual(resolve({ query: "batman" }, context), { query: "batman" });
});
