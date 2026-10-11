import { describeError } from "../mcp/mcpClient.js";
import { completeWithRetry } from "../toolLoop.js";
import { withoutField } from "./schemas.js";
import { validatePlan } from "./validatePlan.js";

/**
 * **A goal in prose → a plan in the Day 19 step format.**
 *
 * One model call, with the tool `submit_plan` forced, so the plan comes back
 * as structured input rather than prose to parse. What the model is told is
 * exactly the catalog: every tool it may use, namespaced `server.tool`, with
 * its description, inputSchema and — when the server declares one — its
 * outputSchema. What it is not told is anything app-only: the scheduler's
 * bookkeeping tools never reach the catalog, and neither does `scheduleId`,
 * which the runner fills in.
 *
 * The plan is checked (`validatePlan`) before anyone sees it. If it does not
 * pass, the problems go back to the model as the `submit_plan` result, once;
 * a second plan that does not pass either is returned as a failure with its
 * errors, and the caller stores nothing.
 *
 * The same call repairs: given the goal, the plan that ran, what its steps
 * produced and the error it stopped on, it proposes a corrected plan. A repair
 * is only ever a proposal — a person accepts it or does not.
 */

export const SUBMIT_PLAN = "submit_plan";
export const PLANNER_MAX_TOKENS = 4096;
/** How much of one step's output a repair prompt carries, as JSON. */
export const MAX_REPAIR_OUTPUT_CHARS = 2000;

const TEXT = { type: "string" };

/** The one tool the planner is given, and made to call. */
export const SUBMIT_PLAN_TOOL = {
  name: SUBMIT_PLAN,
  description: "Submit the whole pipeline plan: every step, in order. Call it exactly once.",
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        minItems: 1,
        description: "The steps, in the order they run.",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["tool", "prompt"] },
            tool: { ...TEXT, description: 'Tool steps: the catalog name, exactly, e.g. "omdb.get_movie".' },
            args: { type: "object", description: "Tool steps: the arguments, matching the tool's inputSchema. Strings may hold templates." },
            text: { ...TEXT, description: "Prompt steps: the whole instruction, with the data it needs inlined through templates." },
            format: { type: "string", enum: ["text", "json"], description: 'Prompt steps: "text" (default) or "json".' },
            outputSchema: {
              type: "object",
              description: 'Json prompt steps: the JSON Schema of the object it returns ({ type: "object", properties, required }).',
            },
            why: { ...TEXT, description: "One short sentence: why this step, and why this tool." },
          },
          required: ["kind", "why"],
        },
      },
      notes: { ...TEXT, description: "Optional: anything the person should know — an assumption, or what could not be planned." },
    },
    required: ["steps"],
  },
};

export const PLANNER_SYSTEM = `You plan pipelines. A pipeline is an ordered list of steps that code runs unattended, top to bottom; nobody can answer a question while it runs.

Two kinds of step:
- tool: { "kind": "tool", "tool": "server.tool", "args": { … }, "why": "…" } — one MCP call, made by code, no model. "tool" is a name from the catalog, exactly. "args" must satisfy that tool's inputSchema.
- prompt: { "kind": "prompt", "text": "…", "format": "text" | "json", "outputSchema": { … }, "why": "…" } — one model call from a fresh context. The model sees only "text" (with its templates filled in): no tools, no history, no earlier steps except what the text inlines.
  - format "text" (the default): the output is a plain string.
  - format "json": the output is an object of the shape "outputSchema" declares — required for json steps, as { "type": "object", "properties": { … }, "required": [ … ] }. Say in the text what each field must hold.

Templates, in any string inside args or text:
- {{prev}} — the previous step's output; {{steps.N}} — step N's output (1-based, earlier steps only); {{now}} — the current ISO time.
- Add a dotted path to reach a field: {{steps.2.results.0.imdbId}}, {{prev.title}}.
- In args, a string that is exactly one template becomes the raw value (an object stays an object, a number a number); anything else is filled in as text, with objects as JSON.

Rules:
1. Use tool steps for fetching and saving data. Use prompt steps only for judgment and wording: choosing, comparing, summarizing, writing.
2. Reference a field ({{steps.N.path}} or {{prev.path}}) only when that step's output shape is known: a tool with an outputSchema, or a json prompt step. The path must exist in that schema.
3. Otherwise (a tool with no outputSchema, or a text prompt), use the output whole ({{steps.N}}), or add a json prompt step that reshapes {{prev}} into the fields the next steps need.
4. Never invent tools or servers. Use only the catalog's names. If the goal needs something the catalog lacks, or a server that is down, plan what you can and say what is missing in notes.
5. Keep it short: every step must serve the goal, and nothing the goal does not ask for — never record, save or post something unless the goal says to. One prompt step can decide and write at once: when the goal asks to choose something and then write about it, do both in a single json prompt step whose fields carry the choice (with its id) and the text. Never chain two prompt steps where one would do.
6. Carry identity through: if the goal asks to save or record an item, keep the item's id from the data (an imdbId, a page id) as a field of the json step, and use it as the key.
7. {{prev}} is always the step directly before. After a tool step that saved something, {{prev}} is that tool's result, not the text saved: name the step that holds what you mean, {{steps.N.field}}.
8. scheduler.record and scheduler.aggregate are this pipeline's history: use them only when the goal asks to record something or to read what was recorded. They already know which pipeline they belong to: never pass an id for it.
9. Every step gets a "why": one short sentence on why it is there and why that tool.
10. Copy tool names character for character from the catalog, hyphens and underscores included.

Example (the shape, not the tools: use the catalog's). Goal: "Fetch the two products, choose the cheaper one, write a one-line ad for it, post the ad, and log which one won."
1. tool shop.get_product { "sku": "A-1" }
2. tool shop.get_product { "sku": "B-2" }
3. prompt, format json: "Two products:\n{{steps.1}}\n{{steps.2}}\nChoose the cheaper one. Return its sku and name, and a one-line ad for it." outputSchema { sku, name, ad } (all required)
4. tool social.post { "text": "{{steps.3.ad}}" }
5. tool log.write { "key": "{{steps.3.sku}}", "label": "{{steps.3.name}}" }
One json step makes the choice and writes the text; the ids it returns are what later steps key on.

Call ${SUBMIT_PLAN} once, with the whole plan.`;

/**
 * **What the planner may use**: the tools of the servers it is allowed,
 * filtered to its allowlist, from each server's live listing.
 *
 * A server that cannot be reached — or needs a login — contributes nothing
 * and is listed in `down` with the reason, so the planner can be told.
 *
 * @param {{
 *   registry: import("../mcp/servers.js").McpRegistry,
 *   allow: Record<string, string[] | "*">,
 * }} params - `allow` names the servers and, per server, the tools (or "*").
 * @returns {Promise<import("./validatePlan.js").Catalog>}
 */
export async function buildCatalog({ registry, allow }) {
  const tools = [];
  const down = [];
  for (const [server, names] of Object.entries(allow)) {
    const client = registry.get(server);
    if (!client) {
      down.push({ server, error: "not a registered MCP server" });
      continue;
    }
    let listed;
    try {
      const connected = await client.connect();
      if (!connected.ok) {
        down.push({ server, error: "needs authorization: connect it in the MCP panel" });
        continue;
      }
      listed = client.tools ?? (await client.listTools());
    } catch (err) {
      down.push({ server, error: describeError(err) });
      continue;
    }
    for (const tool of listed) {
      if (names !== "*" && !names.includes(tool.name)) continue;
      tools.push(catalogEntry(server, tool));
    }
  }
  return { tools, down };
}

/** One listed tool as the planner sees it: namespaced, with no field it must not fill. */
export function catalogEntry(server, tool) {
  const inputSchema = withoutField(tool.inputSchema ?? { type: "object", properties: {} }, "scheduleId");
  return {
    name: `${server}.${tool.name}`,
    server,
    tool: tool.name,
    description: tool.description ?? "",
    inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  };
}

/**
 * `submit_plan`'s input, as steps in the stored format. Nothing is dropped or
 * repaired here — whatever is wrong is the validator's to say — except that a
 * tool step's `server.tool` is split and a prompt step's format is spelled out.
 */
export function stepsFromSubmission(input) {
  const steps = Array.isArray(input?.steps) ? input.steps : [];
  return steps.map((step) => {
    if (!step || typeof step !== "object") return step;
    const { kind, tool, args, text, format, outputSchema, why, ...rest } = step;
    const reason = typeof why === "string" ? { why: why.trim() } : why === undefined ? {} : { why };
    if (kind === "tool") {
      const name = String(tool ?? "");
      const dot = name.indexOf(".");
      return {
        kind,
        server: dot > 0 ? name.slice(0, dot) : "",
        tool: dot > 0 ? name.slice(dot + 1) : name,
        args: args ?? {},
        ...reason,
        ...rest,
      };
    }
    if (kind === "prompt") {
      return { kind, text, format: format ?? "text", ...(outputSchema !== undefined ? { outputSchema } : {}), ...reason, ...rest };
    }
    return step;
  });
}

/** The catalog as the planner reads it: one block per tool. */
export function describeCatalog(catalog) {
  const blocks = catalog.tools.map((tool) =>
    [
      `### ${tool.name}`,
      tool.description.trim() || "(no description)",
      `inputSchema: ${JSON.stringify(stripDraft(tool.inputSchema))}`,
      tool.outputSchema
        ? `outputSchema: ${JSON.stringify(stripDraft(tool.outputSchema))}`
        : "outputSchema: none declared — its output shape is unknown: use it whole, or reshape it with a json prompt step.",
    ].join("\n")
  );
  const down = catalog.down.length
    ? catalog.down.map(({ server, error }) => `- ${server}: ${error}`).join("\n")
    : "(none — every registered server is up)";
  return `## Catalog: the only tools that exist\n\n${blocks.join("\n\n") || "(empty)"}\n\n## Servers that are down right now (their tools are not in the catalog)\n${down}`;
}

function stripDraft(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const { $schema: _draft, ...rest } = schema;
  return rest;
}

export class Planner {
  #provider;
  #catalog;
  #model;
  #maxTokens;
  #now;

  /**
   * @param {{
   *   provider: import("../llm/provider.js").LlmProvider,
   *   catalog: () => Promise<import("./validatePlan.js").Catalog>,
   *   model?: string,
   *   maxTokens?: number,
   *   now?: () => number,
   * }} deps - `catalog` is read fresh on every plan, so a server that just
   *   came up (or went down) is seen.
   */
  constructor({ provider, catalog, model, maxTokens = PLANNER_MAX_TOKENS, now = Date.now }) {
    this.#provider = provider;
    this.#catalog = catalog;
    this.#model = model;
    this.#maxTokens = maxTokens;
    this.#now = now;
  }

  /**
   * A plan for a goal.
   *
   * @param {{ goal: string }} params
   * @returns {Promise<PlanResult>}
   */
  async propose({ goal }) {
    const catalog = await this.#catalog();
    const ask = `${describeCatalog(catalog)}\n\n## Goal\n${goal.trim()}\n\nPlan it.`;
    return this.#plan(ask, catalog);
  }

  /**
   * A corrected plan for a run that failed.
   *
   * @param {{ goal: string, plan: object[], run: { id: number, error: string }, steps?: object[] }} params -
   *   `steps` is what each step of the failed run did (index, status, output, error).
   * @returns {Promise<PlanResult>}
   */
  async repair({ goal, plan, run, steps = [] }) {
    const catalog = await this.#catalog();
    const outputs = steps.map((step) => ({
      step: step.index,
      status: step.status,
      ...(step.input !== undefined ? { input: capped(step.input) } : {}),
      ...(step.output !== undefined ? { output: capped(step.output) } : {}),
      ...(step.error ? { error: step.error } : {}),
    }));
    const ask = [
      describeCatalog(catalog),
      `## Goal\n${goal.trim() || "(no goal was written: infer it from the plan)"}`,
      `## The plan that ran\n${JSON.stringify(plan, null, 2)}`,
      `## What happened\nRun #${run.id} failed: ${run.error}\n\nStep by step:\n${JSON.stringify(outputs, null, 2)}`,
      "Propose a corrected plan that reaches the goal and avoids this failure. Change only what the failure calls for. " +
        "If the failure is outside the plan's control (a server that is down, a missing login), keep the plan and say so in notes.",
    ].join("\n\n");
    return this.#plan(ask, catalog);
  }

  async #plan(ask, catalog) {
    const messages = [{ role: "user", content: ask }];
    const usage = { inputTokens: 0, outputTokens: 0 };
    let attempt;
    let firstErrors = [];
    for (let round = 1; round <= 2; round++) {
      attempt = await this.#submit(messages, usage);
      attempt.errors = attempt.called ? validatePlan(attempt.steps, catalog) : [`The planner did not call ${SUBMIT_PLAN}.`];
      if (!attempt.errors.length) break;
      if (round === 2) break;
      firstErrors = attempt.errors;

      // One retry, with every problem in it.
      const problems = `The plan did not validate:\n${attempt.errors.map((error) => `- ${error}`).join("\n")}\n\n` +
        `Fix every problem and call ${SUBMIT_PLAN} again with the whole corrected plan.`;
      if (attempt.use) {
        messages.push(
          { role: "assistant", content: attempt.content },
          { role: "user", content: [{ type: "tool_result", toolUseId: attempt.use.id, content: problems, isError: true }] }
        );
      } else {
        messages.push({ role: "assistant", content: attempt.text || "(no plan)" }, { role: "user", content: problems });
      }
    }
    return {
      ok: !attempt.errors.length,
      steps: attempt.steps,
      notes: attempt.notes,
      errors: attempt.errors,
      attempts: messages.length === 1 ? 1 : 2,
      firstErrors,
      usage,
      createdAt: new Date(this.#now()).toISOString(),
    };
  }

  async #submit(messages, usage) {
    const result = await completeWithRetry(this.#provider, {
      system: PLANNER_SYSTEM,
      messages,
      tools: [SUBMIT_PLAN_TOOL],
      toolChoice: { name: SUBMIT_PLAN },
      model: this.#model,
      maxTokens: this.#maxTokens,
      temperature: 0,
    });
    usage.inputTokens += result.usage?.inputTokens ?? 0;
    usage.outputTokens += result.usage?.outputTokens ?? 0;
    const use = (result.content ?? []).find((block) => block.type === "tool_use" && block.name === SUBMIT_PLAN);
    const notes = typeof use?.input?.notes === "string" ? use.input.notes.trim() : "";
    return {
      called: Boolean(use),
      use,
      content: result.content,
      text: result.text,
      steps: use ? stepsFromSubmission(use.input) : [],
      notes,
    };
  }
}

/**
 * @typedef {{
 *   ok: boolean, steps: object[], notes: string, errors: string[], attempts: 1 | 2, firstErrors: string[],
 *   usage: { inputTokens: number, outputTokens: number }, createdAt: string,
 * }} PlanResult - `errors` are the last attempt's; empty when `ok`.
 *   `firstErrors` are what the retry was asked to fix (empty with no retry).
 */

function capped(value) {
  const json = JSON.stringify(value);
  if (json === undefined || json.length <= MAX_REPAIR_OUTPUT_CHARS) return value;
  return `${json.slice(0, MAX_REPAIR_OUTPUT_CHARS)}… (${json.length} characters in all)`;
}
