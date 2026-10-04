#!/usr/bin/env node
/**
 * Split branched conversations into separate ones. Run once.
 *
 *   node scripts/migrate-conversations.js            # say what would change
 *   node scripts/migrate-conversations.js --write    # do it
 *
 * Forking used to add a branch to a conversation; it now creates a conversation.
 * A record written under the old scheme holds a *pool* of messages and a map of
 * branches pointing into it, and `normaliseRecord` reads one of those back as
 * whichever branch was active — which is the right default for a read, because a
 * read must not write. But it means the other branches are still on disk and no
 * longer reachable.
 *
 * This is the part that cannot happen on a read: every non-active branch becomes
 * its own conversation file, carrying the messages it could reach, its own copy
 * of the memory state, and a `forkedFrom` note pointing back at the message it
 * was taken from. The original file is left exactly as it is — the active branch
 * already reads correctly out of it, and the next save rewrites it in the
 * current shape.
 *
 * It is safe to run twice: a record with no branch map has nothing to split, and
 * a fork that has already been written is recognised by its `forkedFrom` and
 * skipped rather than duplicated.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { JsonFileStore } from "../src/store/jsonFileStore.js";

const write = process.argv.includes("--write");
const store = new JsonFileStore();
const dir = store.dir;

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const ESC = String.fromCharCode(27);
const bold = (text) => (COLOUR ? `${ESC}[1m${text}${ESC}[0m` : text);
const dim = (text) => (COLOUR ? `${ESC}[2m${text}${ESC}[0m` : text);

/** Every message a branch head can reach, oldest first. */
function historyTo(messages, headId) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const path_ = [];
  const seen = new Set();
  let cursor = headId;
  while (cursor && byId.has(cursor) && !seen.has(cursor) && path_.length <= messages.length) {
    seen.add(cursor);
    const message = byId.get(cursor);
    path_.push(message);
    cursor = message.parentId ?? null;
  }
  return path_.reverse();
}

/** The ids already on disk, so a second run does not write the same fork twice. */
async function existingForks(names) {
  const seen = new Set();
  for (const name of names) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
      const origin = data?.forkedFrom;
      if (origin?.conversationId && origin?.messageId) {
        seen.add(`${origin.conversationId}@${origin.messageId}`);
      }
    } catch {
      // An unreadable file is not a reason to refuse to migrate the others.
    }
  }
  return seen;
}

const names = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json"));
if (!names.length) {
  console.log(`Nothing in ${dir}.`);
  process.exit(0);
}

const already = await existingForks(names);
let split = 0;
let skipped = 0;

for (const name of names.slice().sort()) {
  let data;
  try {
    data = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
  } catch (err) {
    console.log(`${bold(name)} ${dim("unreadable — left alone:")} ${err?.message ?? err}`);
    continue;
  }

  const branches = data?.branches;
  if (!branches || typeof branches !== "object" || Array.isArray(branches)) continue;

  const parentId = data.id ?? path.basename(name, ".json");
  const activeId = branches[data.activeBranchId] ? data.activeBranchId : "main";
  const others = Object.entries(branches).filter(([id]) => id !== activeId);
  if (!others.length) continue;

  console.log(`\n${bold(name)} ${dim(`— active branch "${activeId}" stays where it is`)}`);

  for (const [id, branch] of others) {
    const messages = historyTo(data.messages ?? [], branch?.headId);
    if (!messages.length) {
      console.log(dim(`  branch "${id}" reaches no messages — nothing to split out`));
      continue;
    }

    const takenAt = branch?.forkedFromMessageId ?? messages[0].id;
    if (already.has(`${parentId}@${takenAt}`)) {
      console.log(dim(`  branch "${id}" is already a conversation — skipped`));
      skipped += 1;
      continue;
    }

    const forkId = crypto.randomUUID();
    console.log(
      `  branch ${bold(`"${branch?.name ?? id}"`)} → conversation ${forkId} ` +
        dim(`(${messages.length} messages, forked at ${takenAt})`)
    );

    if (write) {
      // Through the store, so the record it writes is whatever the current
      // shape is — a migration that hand-rolls the file format is a second
      // definition of it, and the two drift.
      await store.save(forkId, messages, data.usage, {
        memory: branch?.strategyState?.memory ?? {},
        forkedFrom: { conversationId: parentId, messageId: takenAt },
        project: data.project,
      });
      already.add(`${parentId}@${takenAt}`);
    }
    split += 1;
  }
}

console.log("");
if (!split && !skipped) {
  console.log("No branched conversations found — nothing to migrate.");
} else if (write) {
  console.log(`${split} branch${split === 1 ? "" : "es"} written as conversations.`);
} else {
  console.log(
    `${split} branch${split === 1 ? "" : "es"} would become conversations. ` +
      "Re-run with --write to do it."
  );
}
