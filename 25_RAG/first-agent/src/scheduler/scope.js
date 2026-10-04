import { preview } from "../mcp/toolbox.js";
import { withoutField } from "../pipeline/schemas.js";

/**
 * **What a scheduled run's model is allowed to touch.**
 *
 * The toolbox lists everything a server has. For a scheduled agent that would
 * include the scheduler's app-only tools — delete_schedule, claim_due_runs —
 * which no model should ever be offered. So the listing goes through the
 * agent's allowlist, and only those tools reach the wire.
 *
 * And the ones that take a `scheduleId` lose it: it is removed from the schema
 * the model sees and filled in here, at call time, from the run being
 * executed. A model cannot write to another schedule because it has no way to
 * name one — and one that invents the field anyway is overruled.
 */

export const SCOPED_FIELD = "scheduleId";

/**
 * @param {object} params
 * @param {{ toolsFor: Function, route: Function, call: Function }} params.toolbox
 * @param {string[]} params.servers - The agent's `mcpServers`.
 * @param {Record<string, string[]>} [params.allow] - The agent's `tools`. A
 *   server with no entry contributes nothing.
 * @param {number} params.scheduleId - The schedule this run belongs to.
 */
export async function scopedTools({ toolbox, servers, allow = {}, scheduleId }) {
  const offered = await toolbox.toolsFor(servers);
  const allowed = new Set();
  const scoped = new Set();
  const tools = [];

  for (const tool of offered.tools) {
    const { server, tool: name } = toolbox.route(tool.name);
    if (!allow[server]?.includes(name)) continue;
    allowed.add(tool.name);
    const schema = tool.inputSchema ?? { type: "object", properties: {} };
    if (schema.properties && SCOPED_FIELD in schema.properties) {
      scoped.add(tool.name);
      tools.push({ ...tool, inputSchema: withoutField(schema, SCOPED_FIELD) });
    } else {
      tools.push(tool);
    }
  }

  /** The toolbox's `call`, behind the allowlist and with the schedule filled in. */
  async function call(name, input) {
    if (!allowed.has(name)) {
      const { server, tool } = toolbox.route(name);
      const text = `The tool "${name}" is not available to this task.`;
      return { server, tool, ok: false, text, preview: preview(text), ms: 0 };
    }
    const args = { ...(input ?? {}) };
    if (scoped.has(name)) args[SCOPED_FIELD] = scheduleId;
    return toolbox.call(name, args);
  }

  return { tools, unavailable: offered.unavailable, call };
}
