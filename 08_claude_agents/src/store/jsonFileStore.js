import fs from "node:fs/promises";
import path from "node:path";

import { ConversationStore, isValidSessionId, titleFrom } from "./conversationStore.js";

// Resolved from this module, not the cwd — `npm start` from anywhere must
// read and write the same directory.
const DEFAULT_DIR = path.join(import.meta.dirname, "..", "..", "data", "conversations");

/**
 * One JSON file per conversation, named `<sessionId>.json`.
 *
 * This is the only file that knows about the filesystem: the directory
 * layout, the encoding, and the write protocol all stop here.
 */
export class JsonFileStore extends ConversationStore {
  #dir;
  #ready;

  /**
   * @param {object} [params]
   * @param {string} [params.dir]
   */
  constructor({ dir = DEFAULT_DIR } = {}) {
    super();
    this.#dir = dir;
  }

  get dir() {
    return this.#dir;
  }

  async load(sessionId) {
    const file = this.#fileFor(sessionId);
    await this.#ensureDir();
    return await this.#readRecord(file);
  }

  async save(sessionId, messages) {
    const file = this.#fileFor(sessionId);
    await this.#ensureDir();

    const now = new Date().toISOString();
    const existing = await this.#readRecord(file);
    const turns = (messages ?? []).map(({ role, content }) => ({ role, content }));

    const record = {
      id: sessionId,
      // Titles are derived once, on first save, and preserved afterwards —
      // a conversation that keeps renaming itself is disorienting.
      title: existing?.title ?? titleFrom(turns),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messages: turns,
    };

    // Write beside the target, then rename: `rename()` is atomic within a
    // directory, so a crash mid-write leaves the previous file intact rather
    // than a half-written one.
    const tmp = file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
    await fs.rename(tmp, file);

    return record;
  }

  async clear(sessionId) {
    const file = this.#fileFor(sessionId);
    try {
      await fs.unlink(file);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  async listSessions() {
    await this.#ensureDir();

    let names;
    try {
      names = await fs.readdir(this.#dir);
    } catch (err) {
      console.warn(`[store] could not read ${this.#dir}: ${err?.message ?? err}`);
      return [];
    }

    const summaries = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = await this.#readRecord(path.join(this.#dir, name));
      if (!record) continue; // missing or corrupt — skip it, don't fail the list
      summaries.push({
        id: record.id,
        title: record.title,
        updatedAt: record.updatedAt,
        messageCount: record.messages.length,
      });
    }

    return summaries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  /**
   * The single place a session id becomes a path. Validating here means an
   * unvalidated id can never reach the filesystem — an id like `../../.env`
   * would otherwise be an arbitrary file read or write.
   */
  #fileFor(sessionId) {
    if (!isValidSessionId(sessionId)) {
      throw new Error("Invalid sessionId: expected a UUID v4");
    }
    return path.join(this.#dir, sessionId + ".json");
  }

  #ensureDir() {
    this.#ready ??= fs.mkdir(this.#dir, { recursive: true });
    return this.#ready;
  }

  /** Reads and normalises one file. Missing or corrupt both come back null. */
  async #readRecord(file) {
    let raw;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      console.warn(`[store] could not read ${file}: ${err?.message ?? err}`);
      return null;
    }

    try {
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.messages)) throw new Error("unexpected shape");
      return data;
    } catch (err) {
      // A corrupt file is a bad conversation, not a bad server.
      console.warn(`[store] ignoring unreadable conversation ${file}: ${err?.message ?? err}`);
      return null;
    }
  }
}
