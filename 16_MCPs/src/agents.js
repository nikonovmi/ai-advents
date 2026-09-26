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
];

const BY_ID = new Map(AGENTS.map((agent) => [agent.id, agent]));

/** @param {unknown} id */
export function isValidAgent(id) {
  return typeof id === "string" && BY_ID.has(id.trim().toLowerCase());
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
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isValidAgent(id) ? id : DEFAULT_AGENT;
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

/**
 * Every agent, for the dropdown. Without the system prompt: the browser has no
 * use for it, and a persona is not something to ship to the client.
 */
export function agentCatalog() {
  return AGENTS.map(({ id, name, tagline }) => ({ id, name, tagline }));
}
