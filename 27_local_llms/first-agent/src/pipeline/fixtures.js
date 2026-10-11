import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

import { McpRegistry } from "../mcp/servers.js";
import { MemoryMcpAuthStore } from "../store/mcpAuthStore.js";
import { buildCatalog } from "./planner.js";

/**
 * **Test data for the planner**: a catalog shaped like the real servers'
 * listings (OMDb and the scheduler declare outputSchemas; Notion does not),
 * and the plan the Day 20 goal should come out as. Not a test file itself —
 * imported by the ones that need it.
 */

const nullable = (type) => ({ type: [type, "null"] });

export const MOVIE_OUTPUT = {
  type: "object",
  properties: {
    title: nullable("string"),
    year: nullable("string"),
    runtimeMinutes: nullable("number"),
    genres: { type: "array", items: { type: "string" } },
    director: nullable("string"),
    actors: { type: "array", items: { type: "string" } },
    plot: nullable("string"),
    imdbRating: nullable("number"),
    ratings: { type: "array", items: { type: "object", properties: { source: { type: "string" }, value: { type: "string" } }, required: ["source", "value"] } },
    imdbId: nullable("string"),
  },
  required: ["title", "year", "runtimeMinutes", "genres", "director", "actors", "plot", "imdbRating", "ratings", "imdbId"],
  additionalProperties: false,
};

/** Raw listings, as each server's listTools returns them (before the catalog filters and namespaces them). */
export const LISTINGS = {
  omdb: [
    {
      name: "search_movies",
      description: "Search OMDb by title words.",
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: { query: { type: "string", minLength: 1 }, year: { type: "integer" }, page: { type: "integer", minimum: 1 } },
        required: ["query"],
      },
      outputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              properties: { title: nullable("string"), year: nullable("string"), imdbId: nullable("string"), type: nullable("string") },
              required: ["title", "year", "imdbId", "type"],
              additionalProperties: false,
            },
          },
          totalResults: { type: "integer" },
        },
        required: ["results", "totalResults"],
        additionalProperties: false,
      },
    },
    {
      name: "get_movie",
      description: "Full details for exactly one title. Pass exactly one of imdbId or title.",
      inputSchema: {
        type: "object",
        properties: {
          imdbId: { type: "string", pattern: "^tt\\d{7,10}$" },
          title: { type: "string", minLength: 1 },
          year: { type: "integer", minimum: 1870, maximum: 2100 },
          plot: { type: "string", enum: ["short", "full"] },
        },
      },
      outputSchema: MOVIE_OUTPUT,
    },
    {
      name: "random_movie",
      description: "A random well-known film.",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { ...MOVIE_OUTPUT, properties: { ...MOVIE_OUTPUT.properties, n: { type: "integer" }, pickedAt: { type: "string" } } },
    },
  ],
  scheduler: [
    {
      name: "record",
      description: "Store one result of this run.",
      inputSchema: {
        type: "object",
        properties: {
          scheduleId: { type: "integer" },
          key: { type: "string", minLength: 1 },
          label: { type: "string", minLength: 1 },
          data: { type: "object" },
        },
        required: ["scheduleId", "key", "label"],
      },
      outputSchema: {
        type: "object",
        properties: { id: { type: "integer" }, scheduleId: { type: "integer" }, key: { type: "string" }, label: { type: "string" }, createdAt: { type: "string" } },
        required: ["id", "scheduleId", "key", "label", "createdAt"],
      },
    },
    {
      name: "aggregate",
      description: "Numbers about everything recorded so far.",
      inputSchema: { type: "object", properties: { scheduleId: { type: "integer" } }, required: ["scheduleId"] },
      outputSchema: {
        type: "object",
        properties: {
          invocations: { type: "integer" },
          uniqueKeys: { type: "integer" },
          mostRepeated: { anyOf: [{ type: "object", properties: { label: { type: "string" }, count: { type: "integer" } } }, { type: "null" }] },
        },
      },
    },
    // App-only: never in a catalog.
    { name: "claim_due_runs", description: "App tool.", inputSchema: { type: "object", properties: {} } },
    { name: "delete_schedule", description: "App tool.", inputSchema: { type: "object", properties: { scheduleId: { type: "integer" } } } },
    { name: "finish_run", description: "App tool.", inputSchema: { type: "object", properties: {} } },
    { name: "get_run", description: "App tool.", inputSchema: { type: "object", properties: {} } },
  ],
  notion: [
    {
      name: "notion-create-pages",
      description: "Creates one or more Notion pages.",
      inputSchema: {
        type: "object",
        properties: {
          pages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                properties: { type: "object", additionalProperties: { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] } },
                content: { type: "string" },
              },
              additionalProperties: false,
            },
          },
          creation_mode: { type: "string", enum: ["draft"] },
        },
        required: ["pages"],
      },
    },
    { name: "notion-search", description: "Search Notion.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "notion-duplicate-page", description: "Not for the planner.", inputSchema: { type: "object", properties: {} } },
  ],
};

export const PLANNER_ALLOW = {
  omdb: "*",
  scheduler: ["record", "aggregate"],
  notion: ["notion-search", "notion-create-pages"],
};

/** The winner's shape, as the json prompt step declares it. */
export const WINNER_SCHEMA = {
  type: "object",
  properties: {
    imdbId: { type: "string" },
    title: { type: "string" },
    imdbRating: { type: "number" },
    summary: { type: "string" },
  },
  required: ["imdbId", "title", "imdbRating", "summary"],
};

export const GOAL =
  "Look up Inception, The Matrix and Heat. Pick the one with the highest IMDb rating, write a 3-sentence summary of it, " +
  "save the summary to Notion, and record the winner in this chat's history.";

/** `submit_plan`'s input for GOAL: get_movie ×3 → a json prompt step → Notion → record. */
export const WINNER_SUBMISSION = {
  steps: [
    { kind: "tool", tool: "omdb.get_movie", args: { title: "Inception" }, why: "Fetch Inception's rating and plot." },
    { kind: "tool", tool: "omdb.get_movie", args: { title: "The Matrix" }, why: "Fetch The Matrix's rating and plot." },
    { kind: "tool", tool: "omdb.get_movie", args: { title: "Heat" }, why: "Fetch Heat's rating and plot." },
    {
      kind: "prompt",
      format: "json",
      text:
        "Three films:\n{{steps.1}}\n{{steps.2}}\n{{steps.3}}\n\nPick the one with the highest imdbRating. Return its imdbId, " +
        "title and imdbRating, and a 3-sentence summary of it.",
      outputSchema: WINNER_SCHEMA,
      why: "Choosing the winner and writing the summary are judgment and wording.",
    },
    {
      kind: "tool",
      tool: "notion.notion-create-pages",
      args: { creation_mode: "draft", pages: [{ properties: { title: "{{steps.4.title}}" }, content: "{{steps.4.summary}}" }] },
      why: "Save the summary as a Notion page.",
    },
    {
      kind: "tool",
      tool: "scheduler.record",
      args: { key: "{{steps.4.imdbId}}", label: "{{steps.4.title}}" },
      why: "Record the winner in this pipeline's history.",
    },
  ],
  notes: "Draft page, since no Notion destination was named.",
};

/** The same plan as it is stored: server and tool split, prompt format spelled out. */
export const WINNER_PLAN = WINNER_SUBMISSION.steps.map(({ tool, ...step }) => {
  if (step.kind !== "tool") return step;
  const [server, name] = tool.split(".");
  return { kind: "tool", server, tool: name, args: step.args, why: step.why };
});

const PORTS = { omdb: 3991, notion: 3992, scheduler: 3993 };

/**
 * A real registry over stub SDK clients: each server lists `LISTINGS`, and a
 * server in `down` fails its connect — Notion with a 401 (needs a login), the
 * others as if nothing were listening.
 *
 * @param {{ down?: string[] }} [options]
 */
export function stubRegistry({ down = [] } = {}) {
  const byPort = Object.fromEntries(Object.entries(PORTS).map(([server, port]) => [String(port), server]));
  return new McpRegistry({
    servers: [
      { id: "omdb", name: "OMDb", url: `http://127.0.0.1:${PORTS.omdb}/mcp`, auth: "none" },
      { id: "notion", name: "Notion", url: `http://127.0.0.1:${PORTS.notion}/mcp`, auth: "oauth" },
      { id: "scheduler", name: "Scheduler", url: `http://127.0.0.1:${PORTS.scheduler}/mcp`, auth: "none" },
    ],
    authStore: new MemoryMcpAuthStore(),
    createTransport: (options) => ({ ...options }),
    createClient: () => {
      let server;
      return {
        async connect(transport) {
          server = byPort[transport.url.port];
          if (!down.includes(server)) return;
          if (server === "notion") throw new UnauthorizedError("no tokens");
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
        },
        getServerVersion: () => ({ name: server, version: "1.0.0" }),
        listTools: async () => ({ tools: structuredClone(LISTINGS[server]) }),
        async callTool() {
          throw new Error("the planner never calls a tool");
        },
        async close() {},
      };
    },
  });
}

/** The catalog the planner would see over `stubRegistry`. */
export function stubCatalog(options) {
  const registry = stubRegistry(options);
  return () => buildCatalog({ registry, allow: PLANNER_ALLOW });
}
