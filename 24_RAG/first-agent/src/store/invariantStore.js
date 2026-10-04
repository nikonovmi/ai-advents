import fs from "node:fs/promises";
import path from "node:path";

/**
 * **Where the rules a project does not break live.**
 *
 * `ProfileStore` answers "what do we know about the *user*?". This one answers
 * a question it structurally cannot: **what is true of the codebase, whoever
 * is typing?** The same human has two repositories with two different rule
 * sets — one stays on Postgres and hand-writes its SQL, the other is a Rails
 * app where an ORM is the whole point — and a layer keyed by the human would
 * have to pick one of those and be wrong about the other.
 *
 * So it is a fifth injected abstraction, keyed by a **project**, sitting
 * beside the four the README names. The two rules the others keep apply here
 * unchanged:
 *
 *   - Nothing storage-specific crosses the boundary. No paths, no file
 *     handles, no JSON.
 *   - An unwritable store is a degraded agent, never a lost turn.
 *
 * And one that is specific to this layer: **nothing a model said reaches it.**
 * The store does not enforce that — `applyOps` does, in one place — but every
 * entry in here got here because a person clicked accept, and the archive in
 * `previous[]` is what makes that checkable months later.
 */

/**
 * @typedef {{ text: string, check: string, supersededAt: string | null }} SupersededInvariant
 * @typedef {{ id: string, key: string, subject: string, text: string, check: string, supersedes: string | null, updatedAt: string | null, turn: number, previous: SupersededInvariant[] }} Invariant
 * @typedef {{ project: string, updatedAt: string | null, nextId: number, entries: Record<string, Invariant>, retired: Invariant[] }} Invariants
 */

/**
 * Which project a conversation belongs to when nobody says.
 *
 * Named rather than left implicit, for the same reason `DEFAULT_USER` is: the
 * file is `default.json` and not `undefined.json`, and the day this app grows
 * a real notion of a repository the only change is what gets passed in here.
 */
export const DEFAULT_PROJECT = "default";

/** A project id has to be safe to use as a filename before it reaches one. */
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** How many superseded versions of one rule are worth keeping. */
const HISTORY_DEPTH = 8;

/** An invariant's text and its check are one line each in a system prompt. */
const MAX_TEXT = 240;

/**
 * Whether a string may be used as a project id.
 *
 * Exported because the id arrives from the browser — the topbar picker sends
 * it with every request — and a route has to be able to refuse one *before* it
 * reaches the store and becomes a path.
 *
 * @param {unknown} projectId
 */
export function isValidProject(projectId) {
  return typeof projectId === "string" && PROJECT_PATTERN.test(projectId.trim().toLowerCase());
}

/** A project id, or the default. The one coercion every caller shares. */
export function projectOf(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isValidProject(id) ? id : DEFAULT_PROJECT;
}

/** How many withdrawn rules are worth keeping as a tombstone. */
const MAX_RETIRED = 12;

/** A project nobody has written a rule for yet. @returns {Invariants} */
export function emptyInvariants(project = DEFAULT_PROJECT) {
  return { project, updatedAt: null, nextId: 1, entries: {}, retired: [] };
}

/**
 * **The subject a key is about**, which is the whole of the collision rule.
 *
 * `invariant.database`, `preference.database` and `constraint.database` share
 * the subject `database`, and that sharing is deliberate: it is what turns
 * "does this new entry conflict with a rule?" into a string comparison rather
 * than a judgement a model would have to be paid to make and would get wrong
 * differently every run.
 *
 * A bare key — `goal` — has no subject and therefore collides with nothing.
 *
 * @param {string} key
 * @returns {string} The dotted remainder, or "" when there is none.
 */
export function subjectOf(key) {
  const text = typeof key === "string" ? key.trim().toLowerCase() : "";
  const dot = text.indexOf(".");
  return dot === -1 ? "" : text.slice(dot + 1);
}

/**
 * Whatever came off disk, coerced into a rule set.
 *
 * An invariant with no `check` is dropped rather than loaded: nothing can
 * create one, and a file hand-edited to contain one would put a rule on the
 * wire that nothing could ever say had been violated.
 *
 * @param {unknown} data
 * @param {string} [project]
 * @returns {Invariants}
 */
export function normaliseInvariants(data, project = DEFAULT_PROJECT) {
  const record = emptyInvariants(typeof data?.project === "string" && data.project ? data.project : project);
  if (!data || typeof data !== "object") return record;

  let highest = 0;
  const coerce = (key, entry) => {
    const text = line(entry?.text);
    const check = line(entry?.check);
    // Both halves are required. A rule nobody could catch being broken is
    // the thing the drafting call turns into a `preference.*` instead.
    if (!text || !check) return null;
    const id = typeof entry?.id === "string" && entry.id ? entry.id : `i${++highest}`;
    const coerced = {
      id,
      key,
      subject: subjectOf(key),
      text,
      check,
      supersedes: typeof entry?.supersedes === "string" && entry.supersedes ? entry.supersedes : null,
      updatedAt: typeof entry?.updatedAt === "string" ? entry.updatedAt : null,
      turn: Number.isInteger(entry?.turn) ? entry.turn : 0,
      // **The archive.** An invariant that changed without a trace is worse
      // than none: the entire value of the mechanism is that it is stable,
      // so every version it has ever had stays readable after the fact.
      previous: (Array.isArray(entry?.previous) ? entry.previous : [])
        .map((old) => ({
          text: line(old?.text),
          check: line(old?.check),
          supersededAt: typeof old?.supersededAt === "string" ? old.supersededAt : null,
        }))
        .filter((old) => old.text)
        .slice(-HISTORY_DEPTH),
    };
    const numbered = /^i(\d+)$/.exec(id);
    if (numbered) highest = Math.max(highest, Number(numbered[1]));
    return coerced;
  };

  const source = data.entries;
  if (source && typeof source === "object") {
    for (const [key, entry] of Object.entries(source)) {
      const coerced = coerce(key, entry);
      if (coerced) record.entries[key] = coerced;
    }
  }

  // Withdrawing a rule is a change to the rule set, so it leaves a tombstone
  // for the same reason an amendment leaves its old text: the mechanism is
  // worth having only because you can see, afterwards, exactly what it said
  // and when it stopped saying it.
  record.retired = (Array.isArray(data.retired) ? data.retired : [])
    .map((entry) => {
      const coerced = coerce(typeof entry?.key === "string" ? entry.key : "", entry);
      if (!coerced) return null;
      return { ...coerced, retiredAt: typeof entry?.retiredAt === "string" ? entry.retiredAt : null };
    })
    .filter(Boolean)
    .slice(-MAX_RETIRED);

  record.nextId = Number.isInteger(data.nextId) && data.nextId > highest ? data.nextId : highest + 1;
  record.updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : null;
  return record;
}

/**
 * Write one invariant, keeping the id the key already had and archiving the
 * text it replaces.
 *
 * This is the amendment path, and the only one: `supersedes` names the
 * entry being replaced, and the sentence that was there goes into `previous[]`
 * rather than being overwritten.
 *
 * @param {Invariants} record
 * @param {{ key: string, text: string, check: string, turn?: number, at?: string }} params
 * @returns {{ entry: Invariant, amended: boolean }}
 */
export function writeInvariant(record, { key, text, check, turn = 0, at = new Date().toISOString() }) {
  const existing = record.entries[key];
  const changed = existing && (existing.text !== text || existing.check !== check);

  const entry = {
    id: existing?.id ?? `i${record.nextId ?? 1}`,
    key,
    subject: subjectOf(key),
    text,
    check,
    supersedes: changed ? existing.id : (existing?.supersedes ?? null),
    updatedAt: at,
    turn,
    previous: changed
      ? [...(existing.previous ?? []), { text: existing.text, check: existing.check, supersededAt: at }].slice(
          -HISTORY_DEPTH
        )
      : (existing?.previous ?? []),
  };

  if (!existing) record.nextId = (record.nextId ?? 1) + 1;
  record.entries[key] = entry;
  return { entry, amended: Boolean(existing) };
}

/**
 * Withdraw one invariant, keeping the tombstone. The amendment path's other
 * half: a rule that
 * vanished without a trace is the same failure as one that changed without
 * one.
 *
 * @returns {boolean} Whether there was anything to withdraw.
 */
export function retireInvariant(record, key, at = new Date().toISOString()) {
  const existing = record.entries?.[key];
  if (!existing) return false;
  delete record.entries[key];
  record.retired = [...(record.retired ?? []), { ...existing, retiredAt: at }].slice(-MAX_RETIRED);
  return true;
}

export class InvariantStore {
  /**
   * @param {string} [projectId]
   * @returns {Promise<Invariants>} Always a rule set — an unknown project is
   *   an empty one, never null.
   */
  // eslint-disable-next-line no-unused-vars
  async load(projectId) {
    throw new Error("Not implemented");
  }

  /**
   * @param {string} projectId
   * @param {Invariants} record - The whole rule set, as it should now stand.
   * @returns {Promise<Invariants>}
   */
  // eslint-disable-next-line no-unused-vars
  async save(projectId, record) {
    throw new Error("Not implemented");
  }

  /** @param {string} projectId @returns {Promise<void>} */
  // eslint-disable-next-line no-unused-vars
  async clear(projectId) {
    throw new Error("Not implemented");
  }

  /**
   * Which projects exist, for the picker — built from the store rather than
   * from a second list in the UI that can quietly disagree with it.
   *
   * @returns {Promise<{ id: string, entryCount: number, updatedAt: string | null }[]>}
   */
  async list() {
    return [];
  }
}

/**
 * One JSON file per project, in `data/invariants/`.
 *
 * Deliberately **not** in `data/memory/`, which is keyed by the human. Two
 * codebases belonging to one person need two rule sets, and a layer that could
 * only hold one of them would be wrong about the other on every turn.
 */
export class JsonInvariantStore extends InvariantStore {
  #dir;
  #ready;
  /** Writes are serialised per store, so two accepts cannot interleave. */
  #queue = Promise.resolve();

  constructor({ dir = path.join(import.meta.dirname, "..", "..", "data", "invariants") } = {}) {
    super();
    this.#dir = dir;
  }

  get dir() {
    return this.#dir;
  }

  async load(projectId = DEFAULT_PROJECT) {
    const file = this.#fileFor(projectId);
    let raw;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") {
        console.warn(`[invariants] could not read ${file}: ${err?.message ?? err}`);
      }
      return emptyInvariants(projectId);
    }

    try {
      return normaliseInvariants(JSON.parse(raw), projectId);
    } catch (err) {
      console.warn(`[invariants] ignoring unreadable rule set ${file}: ${err?.message ?? err}`);
      return emptyInvariants(projectId);
    }
  }

  async save(projectId = DEFAULT_PROJECT, record) {
    const file = this.#fileFor(projectId);
    const next = { ...normaliseInvariants(record, projectId), updatedAt: new Date().toISOString() };

    // Same protocol as the other two file stores: write beside the target and
    // rename, so a crash mid-write cannot leave half a rule set behind.
    this.#queue = this.#queue.then(async () => {
      await this.#ensureDir();
      const tmp = file + ".tmp";
      await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
      await fs.rename(tmp, file);
    }, () => {});
    await this.#queue;
    return next;
  }

  async clear(projectId = DEFAULT_PROJECT) {
    try {
      await fs.unlink(this.#fileFor(projectId));
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  async list() {
    let files = [];
    try {
      files = await fs.readdir(this.#dir);
    } catch (err) {
      if (err?.code !== "ENOENT") console.warn(`[invariants] could not list ${this.#dir}: ${err?.message ?? err}`);
      return [];
    }

    const projects = [];
    for (const name of files.sort()) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!isValidProject(id)) continue;
      const record = await this.load(id);
      projects.push({ id, entryCount: Object.keys(record.entries).length, updatedAt: record.updatedAt });
    }
    return projects;
  }

  /** The single place a project id becomes a path. */
  #fileFor(projectId) {
    const project = String(projectId ?? "").trim().toLowerCase();
    if (!PROJECT_PATTERN.test(project)) {
      throw new Error("Invalid project id: expected lowercase letters, digits, dash or underscore");
    }
    return path.join(this.#dir, project + ".json");
  }

  #ensureDir() {
    this.#ready ??= fs.mkdir(this.#dir, { recursive: true });
    return this.#ready;
  }
}

/** The same contract backed by a Map: the twin the tests use. */
export class MemoryInvariantStore extends InvariantStore {
  /** @type {Map<string, Invariants>} */
  #projects = new Map();

  async load(projectId = DEFAULT_PROJECT) {
    const stored = this.#projects.get(projectId);
    return stored ? normaliseInvariants(structuredClone(stored), projectId) : emptyInvariants(projectId);
  }

  async save(projectId = DEFAULT_PROJECT, record) {
    const next = { ...normaliseInvariants(record, projectId), updatedAt: new Date().toISOString() };
    this.#projects.set(projectId, next);
    return structuredClone(next);
  }

  async clear(projectId = DEFAULT_PROJECT) {
    this.#projects.delete(projectId);
  }

  async list() {
    return [...this.#projects.entries()].map(([id, record]) => ({
      id,
      entryCount: Object.keys(record.entries ?? {}).length,
      updatedAt: record.updatedAt ?? null,
    }));
  }
}

/** @type {JsonInvariantStore | null} */
let shared = null;

/**
 * The process-wide invariant store. Built once and lazily, like the profile
 * store, so that merely listing the strategy catalogue touches no filesystem.
 */
export function defaultInvariantStore() {
  shared ??= new JsonInvariantStore();
  return shared;
}

function line(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}
