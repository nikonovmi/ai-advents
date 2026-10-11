import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicProvider } from "./anthropic.js";

/** The request body the provider sends, for one `complete` call, with fetch stubbed. */
async function bodyOf(t, params) {
  let sent;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sent = JSON.parse(init.body);
    const reply = { content: [{ type: "tool_use", id: "t1", name: "submit_plan", input: {} }], model: sent.model, stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } };
    return new Response(JSON.stringify(reply), { status: 200 });
  });
  await new AnthropicProvider({ apiKey: "test" }).complete({ messages: [{ role: "user", content: "hi" }], ...params });
  return sent;
}

const TOOL = { name: "submit_plan", inputSchema: { type: "object", properties: {} } };

test("toolChoice forces the named tool; Haiku keeps its temperature", async (t) => {
  const body = await bodyOf(t, { tools: [TOOL], toolChoice: { name: "submit_plan" }, temperature: 0 });
  assert.deepEqual(body.tool_choice, { type: "tool", name: "submit_plan" });
  assert.equal(body.temperature, 0);
  assert.equal(body.thinking, undefined);
});

test("Sonnet 5: no temperature (it is a 400 there), and thinking off when a tool is forced", async (t) => {
  const forced = await bodyOf(t, { model: "claude-sonnet-5", tools: [TOOL], toolChoice: { name: "submit_plan" }, temperature: 0 });
  assert.equal("temperature" in forced, false);
  assert.deepEqual(forced.thinking, { type: "disabled" });

  const plain = await bodyOf(t, { model: "claude-sonnet-5", temperature: 0.7 });
  assert.equal("temperature" in plain, false);
  assert.equal(plain.thinking, undefined);
  assert.equal(plain.tool_choice, undefined);
});
