import fs from "node:fs/promises";
import path from "node:path";

import { pickGraph } from "./branches.js";
import {
  ConversationStore,
  emptyUsage,
  isValidSessionId,
  normaliseMessages,
  normaliseRecord,
  normaliseUsage,
  titleFrom,
  UNTITLED,
} from "./conversationStore.js";
import { projectOf } from "./invariantStore.js";

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

  async save(sessionId, messages, usage, graph) {
    const file = this.#fileFor(sessionId);
    await this.#ensureDir();

    const now = new Date().toISOString();
    const existing = await this.#readRecord(file);
    const turns = normaliseMessages(messages);

    const record = {
      id: sessionId,
      // Derived once and preserved afterwards — a conversation that keeps
      // renaming itself is disorienting. But the **placeholder is not a
      // title**, and a record saved before its first message carries one, so
      // it is re-derived until there is something real to derive it from.
      // That also heals any conversation already stuck with the placeholder.
      title: existing?.title && existing.title !== UNTITLED ? existing.title : titleFrom(turns),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      usage: usage ? normaliseUsage(usage) : (existing?.usage ?? emptyUsage()),
      // An absent `graph` means "unchanged", not "cleared" — a caller that does
      // not know about branches must not flatten one.
      ...(graph ?? pickGraph(existing)),
      // Same rule for the project: a caller that does not know invariants
      // exist must not silently move the conversation to another rule set.
      project: projectOf(graph?.project ?? existing?.project),
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
        branchCount: Object.keys(record.branches).length,
        totalCostUsd: record.usage.totalCostUsd,
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
      // Files written by earlier versions have no usage, no summary, no
      // message ids and no branches. They read back as a conversation that has
      // cost nothing and been forked never, not as a parse failure.
      return normaliseRecord(data);
    } catch (err) {
      // A corrupt file is a bad conversation, not a bad server.
      console.warn(`[store] ignoring unreadable conversation ${file}: ${err?.message ?? err}`);
      return null;
    }
  }
}
