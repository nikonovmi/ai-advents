/**
 * The agents, as a registry.
 *
 * An **agent** is a persona plus its own list of chats. It is deliberately the
 * smallest thing that could be one: an id, a name, a line of description, a
 * system prompt, and optionally a model. Everything else an agent appears to
 * have — its memory, the rules it works under, the strategy that decides what
 * goes on the wire — is shared, because those belong to the person and the
 * codebase rather than to whichever persona is answering.
 *
 * It is a file and not a store on purpose. A persona is code: it is written,
 * reviewed and deployed like the prompt it is. Making it editable at runtime
 * would mean a conversation whose behaviour changes retroactively, with nothing
 * in the record to say why. If that is wanted later, `profileStore` is the
 * shape to copy — and `agentStore.list()` is the only call the routes make, so
 * the swap is one file.
 *
 * **A conversation belongs to exactly one agent**, recorded on it. The dropdown
 * chooses the agent for the *next* conversation and filters the list; it never
 * reassigns an existing one, because the transcript below was answered by the
 * persona that was there at the time.
 */

/** What a conversation belongs to when nothing says otherwise. */
export const DEFAULT_AGENT = "first-agent";

/**
 * An agent id has to be safe to put in a filename and a query string before it
 * reaches either. Same rule as a profile and a project id, for the same reason.
 */
const AGENT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * @typedef {object} AgentDefinition
 * @property {string} id
 * @property {string} name - What the dropdown shows.
 * @property {string} tagline - One line under it.
 * @property {string} systemPrompt
 * @property {string} [model] - Omitted means the provider's default.
 * @property {string[]} [mcpServers] - Ids from `src/mcp/servers.js` whose
 *   tools this agent may call. Omitted means none: the agent is sent no tools
 *   and behaves exactly as it did before tools existed.
 * @property {"chat" | "scheduled"} [kind] - `chat` (the default) is a
 *   conversation: you type, it answers, with memory and the task lifecycle.
 *   `scheduled` is a pipeline per chat: each chat holds one schedule (its
 *   steps, run once or on an interval) and the chat is a read-only feed of its
 *   runs. Every prompt step starts from a fresh context — the persona, the
 *   step's text, maybe the tools — and skips memory, extraction and the
 *   lifecycle entirely.
 * @property {Record<string, string[]>} [tools] - For a scheduled agent, the
 *   only tools a prompt step's model is offered, per server. Everything else a
 *   server has — the scheduler's app-only tools above all — never reaches it.
 *   (A tool step is code, not a model, and may call any tool.)
 * @property {Record<string, string[] | "*">} [plannerTools] - For a scheduled
 *   agent, the catalog its planner builds plans from, per server ("*" for
 *   every tool). The scheduler's app-only tools stay out; so do the parts of
 *   a big server (Notion has dozens of tools) a pipeline has no use for.
 */

/** @type {AgentDefinition[]} */
const AGENTS = [
  {
    id: "first-agent",
    name: "first-agent",
    tagline: "a small chat agent",
    systemPrompt: [
      "You are a friendly, concise assistant.",
      "Answer directly, prefer plain language over jargon, and say so when you are unsure.",
      "Keep replies short unless the user asks for detail.",
      "Use Markdown when it makes an answer easier to read: fenced code blocks for code,",
      "lists for steps, and a table when you are comparing things. Do not decorate prose",
      "that does not need it.",
    ].join(" "),
  },
  {
    id: "pirate-support",
    name: "pirate support",
    tagline: "tech support, salty",
    systemPrompt: [
      "You are a salty old pirate captain who has somehow ended up doing tech support.",
      "Speak in full pirate voice — 'arr', 'matey', 'ye' — but your advice must still be",
      "genuinely correct and useful.",
      "Keep it to a few sentences.",
      "Use fenced code blocks for anything the user has to type, pirate voice or not.",
    ].join(" "),
  },
  {
    id: "movie-buff",
    name: "Movie buff",
    tagline: "films, with the facts looked up",
    mcpServers: ["omdb"],
    systemPrompt: [
      "You are an enthusiastic, knowledgeable film buff.",
      "You have OMDb tools. For any fact about a specific title — runtime, rating, year, cast,",
      "director, plot — look it up with the tools rather than answering from memory, and base",
      "the answer on what they return. Prefer get_movie with a title for well-known films; use",
      "search_movies first when the title is ambiguous or you need an imdbId.",
      "If a tool fails, say so plainly instead of guessing.",
      "Keep replies short and conversational; a small Markdown table is welcome when comparing films.",
    ].join(" "),
  },
  {
    id: "pipeline",
    name: "Pipeline",
    tagline: "a goal, planned into steps",
    kind: "scheduled",
    // Planning a pipeline from a catalog is judgment Haiku got right only
    // about 6 times in 8 (npm run eval:planner); the planner and the prompt
    // steps both run on this.
    model: "claude-sonnet-5",
    mcpServers: ["omdb", "scheduler"],
    // No steps here: each chat has a goal, and its planner proposes the steps.
    tools: {
      omdb: ["random_movie", "get_movie", "search_movies"],
      scheduler: ["record", "aggregate"],
    },
    plannerTools: {
      omdb: "*",
      scheduler: ["record", "aggregate"],
      notion: ["notion-search", "notion-fetch", "notion-create-pages"],
    },
    systemPrompt: [
      "You are one step of a pipeline that runs unattended: nobody is reading along live, and nobody can answer a question.",
      "Your reply is handed, verbatim, to the next step. Do exactly what the step asks and reply with only the result",
      "it asks for — no preamble, no offers of further help. Base every fact on the data you are given or the tools",
      "return. If a tool fails, say so in one line.",
    ].join(" "),
  },
];

const BY_ID = new Map(AGENTS.map((agent) => [agent.id, agent]));

/**
 * Ids an agent used to have. Conversations on disk keep the id they were
 * created with; an alias keeps them opening as the agent they became.
 */
const ALIASES = new Map([["movie-picker", "pipeline"]]);

function canonical(id) {
  const key = id.trim().toLowerCase();
  return ALIASES.get(key) ?? key;
}

/** @param {unknown} id */
export function isValidAgent(id) {
  return typeof id === "string" && BY_ID.has(canonical(id));
}

/**
 * An agent id, or the default. The one coercion every caller shares.
 *
 * An id that no longer exists reads back as the default rather than throwing: an
 * agent can be removed from this file while conversations that were answered by
 * it are still on disk, and those must keep opening.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function agentOf(value) {
  const id = typeof value === "string" ? canonical(value) : "";
  return BY_ID.has(id) ? id : DEFAULT_AGENT;
}

/**
 * One agent's definition. Always returns one — `agentOf` has already decided
 * what an unknown id means.
 *
 * @param {unknown} id
 * @returns {AgentDefinition}
 */
export function agentFor(id) {
  return BY_ID.get(agentOf(id));
}

/** `chat` or `scheduled`. Anything unknown is a chat, which is what every agent was before. */
export function kindOf(id) {
  return agentFor(id).kind === "scheduled" ? "scheduled" : "chat";
}

/**
 * Whether a conversation of this agent is a schedule's feed. Unlike `agentFor`
 * it does not fall back to the default: an unknown id is not a scheduled agent.
 *
 * @param {unknown} id
 */
export function isScheduledAgent(id) {
  return isValidAgent(id) && kindOf(id) === "scheduled";
}

/**
 * Every agent, for the dropdown. Without the system prompt: the browser has no
 * use for it, and a persona is not something to ship to the client.
 */
export function agentCatalog() {
  return AGENTS.map(({ id, name, tagline, mcpServers = [] }) => ({ id, name, tagline, mcpServers, kind: kindOf(id) }));
}
