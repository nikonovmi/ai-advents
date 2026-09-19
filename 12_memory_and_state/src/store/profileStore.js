import fs from "node:fs/promises";
import path from "node:path";

/**
 * The long-term-memory abstraction.
 *
 * `ConversationStore` answers "where does this conversation live?". This one
 * answers the question a conversation store structurally cannot: **where does
 * what we know about the user live when the conversation is over?**
 *
 * It is a fourth injected abstraction rather than a corner of the third on
 * purpose. Long-term memory has a different lifetime (it outlives every
 * conversation), a different key (a user, not a session) and a different
 * deletion rule (only an explicit one) — putting it inside a conversation
 * record would mean a new chat starts with amnesia, which is the exact failure
 * the layer exists to prevent.
 *
 * The same two rules the other abstractions keep apply here:
 *
 *   - Nothing storage-specific crosses the boundary. No paths, no file
 *     handles, no JSON. The strategy above it speaks in profiles and entries.
 *   - An unwritable store is a degraded agent, never a lost turn. Callers are
 *     expected to survive a rejected `save`.
 */

/**
 * @typedef {{ id: string, key: string, value: string, updatedAt: string | null, source: string | null }} ProfileEntry
 * @typedef {{ user: string, updatedAt: string | null, nextId: number, entries: Record<string, ProfileEntry> }} Profile
 */

/**
 * Who the profile belongs to when nobody says. This app has no accounts, so
 * there is exactly one user and it is named rather than left implicit — the
 * file is `local.json` and not `undefined.json`, and the day accounts arrive
 * the only change is what gets passed in here.
 */
export const DEFAULT_USER = "local";

/** A user id has to be safe to use as a filename before it reaches one. */
const USER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class ProfileStore {
  /**
   * @param {string} [userId]
   * @returns {Promise<Profile>} Always a profile — an unknown user is an empty
   *   one, never null. "We have never met" and "we met and learned nothing"
   *   are the same thing to every caller.
   */
  // eslint-disable-next-line no-unused-vars
  async load(userId) {
    throw new Error("Not implemented");
  }

  /**
   * @param {string} userId
   * @param {Profile} profile - The whole profile, as it should now stand.
   * @returns {Promise<Profile>} The record as persisted.
   */
  // eslint-disable-next-line no-unused-vars
  async save(userId, profile) {
    throw new Error("Not implemented");
  }

  /**
   * Forget a user entirely. The only way anything leaves this layer.
   * @param {string} userId
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async clear(userId) {
    throw new Error("Not implemented");
  }
}

/** A user we know nothing about yet. @returns {Profile} */
export function emptyProfile(user = DEFAULT_USER) {
  return { user, updatedAt: null, nextId: 1, entries: {} };
}

/**
 * Whatever came off disk, coerced into a profile.
 *
 * Long-term storage is the one place where a bad file is expensive: it is read
 * on every turn of every conversation for the rest of the user's life with the
 * app. So an entry that does not make sense is dropped and the rest still
 * loads, exactly as a corrupt conversation is skipped rather than fatal.
 *
 * @param {unknown} data
 * @param {string} [user]
 * @returns {Profile}
 */
export function normaliseProfile(data, user = DEFAULT_USER) {
  const profile = emptyProfile(typeof data?.user === "string" && data.user ? data.user : user);
  if (!data || typeof data !== "object") return profile;

  const source = data.entries;
  let highest = 0;
  if (source && typeof source === "object") {
    for (const [key, entry] of Object.entries(source)) {
      const value = String(entry?.value ?? "").replace(/\s+/g, " ").trim();
      if (!value) continue;
      const id = typeof entry?.id === "string" && entry.id ? entry.id : null;
      profile.entries[key] = {
        id: id ?? `e${++highest}`,
        key,
        value,
        updatedAt: typeof entry?.updatedAt === "string" ? entry.updatedAt : null,
        source: typeof entry?.source === "string" ? entry.source : null,
      };
      const numbered = /^e(\d+)$/.exec(profile.entries[key].id);
      if (numbered) highest = Math.max(highest, Number(numbered[1]));
    }
  }

  profile.nextId = Number.isInteger(data.nextId) && data.nextId > highest ? data.nextId : highest + 1;
  profile.updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : null;
  return profile;
}

/**
 * One JSON file per user, in `data/memory/`.
 *
 * Deliberately **not** under `data/conversations/`: a profile that lived
 * beside the conversations would be deleted with one of them, and the whole
 * claim of the long-term layer is that it survives the conversation that
 * established it.
 */
export class JsonProfileStore extends ProfileStore {
  #dir;
  #ready;
  /** Writes are serialised per store, so two promotions cannot interleave. */
  #queue = Promise.resolve();

  constructor({ dir = path.join(import.meta.dirname, "..", "..", "data", "memory") } = {}) {
    super();
    this.#dir = dir;
  }

  get dir() {
    return this.#dir;
  }

  async load(userId = DEFAULT_USER) {
    const file = this.#fileFor(userId);
    let raw;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") {
        console.warn(`[profile] could not read ${file}: ${err?.message ?? err}`);
      }
      return emptyProfile(userId);
    }

    try {
      return normaliseProfile(JSON.parse(raw), userId);
    } catch (err) {
      console.warn(`[profile] ignoring unreadable profile ${file}: ${err?.message ?? err}`);
      return emptyProfile(userId);
    }
  }

  async save(userId = DEFAULT_USER, profile) {
    const file = this.#fileFor(userId);
    const record = { ...normaliseProfile(profile, userId), updatedAt: new Date().toISOString() };

    // Same protocol as the conversation store: write beside the target and
    // rename, so a crash mid-write cannot leave a half-written profile behind.
    this.#queue = this.#queue.then(async () => {
      await this.#ensureDir();
      const tmp = file + ".tmp";
      await fs.writeFile(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
      await fs.rename(tmp, file);
    }, () => {});
    await this.#queue;
    return record;
  }

  async clear(userId = DEFAULT_USER) {
    const file = this.#fileFor(userId);
    try {
      await fs.unlink(file);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  /** The single place a user id becomes a path. */
  #fileFor(userId) {
    const user = String(userId ?? "").trim().toLowerCase();
    if (!USER_PATTERN.test(user)) {
      throw new Error("Invalid user id: expected lowercase letters, digits, dash or underscore");
    }
    return path.join(this.#dir, user + ".json");
  }

  #ensureDir() {
    this.#ready ??= fs.mkdir(this.#dir, { recursive: true });
    return this.#ready;
  }
}

/** The same contract backed by a Map: the twin the tests use. */
export class MemoryProfileStore extends ProfileStore {
  /** @type {Map<string, Profile>} */
  #profiles = new Map();

  async load(userId = DEFAULT_USER) {
    const stored = this.#profiles.get(userId);
    return stored ? normaliseProfile(structuredClone(stored), userId) : emptyProfile(userId);
  }

  async save(userId = DEFAULT_USER, profile) {
    const record = { ...normaliseProfile(profile, userId), updatedAt: new Date().toISOString() };
    this.#profiles.set(userId, record);
    return structuredClone(record);
  }

  async clear(userId = DEFAULT_USER) {
    this.#profiles.delete(userId);
  }
}

/** @type {JsonProfileStore | null} */
let shared = null;

/**
 * The process-wide profile store.
 *
 * Long-term memory is one thing shared by every conversation, so it is built
 * once rather than per agent — and lazily, so that merely listing the strategy
 * catalogue never touches the filesystem. A test injects its own instead.
 */
export function defaultProfileStore() {
  shared ??= new JsonProfileStore();
  return shared;
}
