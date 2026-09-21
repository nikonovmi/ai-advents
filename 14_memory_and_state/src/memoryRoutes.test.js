import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { memoryRoutes } from "./memoryRoutes.js";
import { MemoryStore } from "./store/memoryStore.js";
import { UNTITLED } from "./store/conversationStore.js";
import { MemoryInvariantStore } from "./store/invariantStore.js";
import { MemoryProfileStore } from "./store/profileStore.js";

/**
 * **The memory routes, over HTTP.**
 *
 * Everything else in this suite drives the strategy directly, which is the
 * right level for the write policies — and is exactly why the bug these tests
 * pin got through. `onBranch` is the one piece of the task boundary that no
 * strategy test can reach: it decides what a request is *about* before the
 * strategy sees it, and it was deciding that a conversation nobody had spoken
 * in yet did not exist.
 */

const SESSION = "33333333-3333-4333-8333-333333333333";

/** A provider that drafts one rule, so the propose route has something to do. */
class StubProvider {
  calls = [];

  async complete({ system, messages }) {
    this.calls.push({ system, messages });
    return {
      text: JSON.stringify([
        { action: "add", key: "invariant.database", text: "Stays on Postgres.", check: "another engine" },
      ]),
      model: "stub",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }

  async countTokens({ messages }) {
    return { inputTokens: messages.length };
  }
}

/** The router on a real socket, torn down when the test ends. */
async function serve(t) {
  const store = new MemoryStore();
  const profileStore = new MemoryProfileStore();
  const invariantStore = new MemoryInvariantStore();
  const provider = new StubProvider();

  const app = express();
  app.use(express.json());
  app.use(memoryRoutes({ store, provider, profileStore, invariantStore }));

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  return { post, store, profileStore, invariantStore, provider };
}

test("the memory panel works before a word has been said", async (t) => {
  const { post, invariantStore, profileStore, store } = await serve(t);

  // The page mints a session id when it opens and the record is written on the
  // first turn, so this is the state every conversation is in before anybody
  // types. It is a conversation with nothing in it, not a missing one — and
  // the invariant box is the clearest case: the rules of a project have
  // nothing to do with any conversation, so needing to say something first was
  // never a rule anybody chose.
  const drafted = await post(`/conversations/${SESSION}/memory/invariants/propose`, {
    project: "demo",
    text: "we never move off postgres",
  });
  assert.equal(drafted.status, 200);
  assert.deepEqual(
    drafted.body.rows.map((row) => [row.action, row.key]),
    [["add", "invariant.database"]]
  );

  // Accepting it is the write, and it is the same `/memory/ops` path
  // everything else takes.
  const accepted = await post(`/conversations/${SESSION}/memory/ops`, {
    project: "demo",
    ops: [{ op: "set", key: "invariant.database", value: "Stays on Postgres.", check: "another engine" }],
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body.panel.invariants.map((row) => row.text), ["Stays on Postgres."]);
  assert.deepEqual(Object.keys((await invariantStore.load("demo")).entries), ["invariant.database"]);

  // The profile editor had the same bug, by the same route, for longer.
  const declared = await post(`/conversations/${SESSION}/memory/ops`, {
    ops: [{ op: "set", key: "preference.format", value: "Bullets, code first" }],
    declared: true,
  });
  assert.equal(declared.status, 200);
  assert.equal((await profileStore.load("local")).entries["preference.format"].source, "declared");

  // ...and the conversation that was conjured to hold all this is an ordinary
  // one: a single branch, in planning, with nothing said on it.
  const record = await store.load(SESSION);
  assert.deepEqual(record.messages, []);
  assert.deepEqual(Object.keys(record.branches), ["main"]);
  assert.equal(record.project, "demo");
  assert.equal(accepted.body.panel.lifecycle.stage, "planning");
});

test("the project a conversation belongs to is remembered, and not reset by silence", async (t) => {
  const { post, store } = await serve(t);

  await post(`/conversations/${SESSION}/memory/ops`, {
    project: "demo",
    ops: [{ op: "set", key: "invariant.orm", value: "No ORM.", check: "an ORM import" }],
  });
  assert.equal((await store.load(SESSION)).project, "demo");

  // A request that does not name a project is not a request to move the
  // conversation to the default one. Resetting it would drop every rule the
  // project has for the length of a turn, silently.
  const quiet = await post(`/conversations/${SESSION}/memory/ops`, {
    ops: [{ op: "set", key: "preference.style", value: "Terse" }],
    declared: true,
  });
  assert.equal(quiet.status, 200);
  assert.equal((await store.load(SESSION)).project, "demo");
  assert.deepEqual(quiet.body.panel.invariants.map((row) => row.key), ["invariant.orm"]);
});

test("writing a rule first does not name the conversation after the placeholder", async (t) => {
  const { post, store } = await serve(t);

  // Saving a record before its first message is what the fix above made
  // possible, and it walked straight into "titles are derived once, on first
  // save, and preserved afterwards": derived from no messages, the title is
  // the placeholder, and *preserved afterwards* then meant forever.
  await post(`/conversations/${SESSION}/memory/ops`, {
    project: "demo",
    ops: [{ op: "set", key: "invariant.orm", value: "No ORM.", check: "an ORM import" }],
  });
  assert.equal((await store.load(SESSION)).title, UNTITLED);

  // The placeholder is not a title, so the first real message still names it.
  await store.save(
    SESSION,
    [{ role: "user", content: "Move the billing service off Heroku" }, { role: "assistant", content: "ok" }],
    null,
    null
  );
  assert.equal((await store.load(SESSION)).title, "Move the billing service off Heroku");

  // ...and once it has a real one, it keeps it. A conversation that renames
  // itself every turn is the failure this rule exists to prevent.
  await store.save(
    SESSION,
    [
      { role: "user", content: "Move the billing service off Heroku" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "actually, let us talk about something else" },
    ],
    null,
    null
  );
  assert.equal((await store.load(SESSION)).title, "Move the billing service off Heroku");
});

test("a malformed session id is still refused, and a bad branch still 404s", async (t) => {
  const { post } = await serve(t);

  // Conjuring a record for anything that asks is not the change: the id has to
  // be one this app could have issued.
  const bad = await post("/conversations/not-a-uuid/memory/invariants/propose", { text: "no ORM" });
  assert.equal(bad.status, 400);

  const branch = await post(`/conversations/${SESSION}/memory/ops`, {
    branchId: "nope",
    ops: [{ op: "set", key: "preference.style", value: "Terse" }],
  });
  assert.equal(branch.status, 404);
});

test("the propose route is read-only, and an empty box is a refusal rather than a call", async (t) => {
  const { post, provider, invariantStore } = await serve(t);

  const empty = await post(`/conversations/${SESSION}/memory/invariants/propose`, { project: "demo", text: "   " });
  assert.equal(empty.status, 400);
  assert.equal(provider.calls.length, 0, "an empty box must not cost a model call");

  const drafted = await post(`/conversations/${SESSION}/memory/invariants/propose`, {
    project: "demo",
    text: "we never move off postgres",
  });
  assert.equal(drafted.status, 200);
  assert.equal(provider.calls.length, 1);
  // Drafting writes nothing. The accept is the write, and there has not been
  // one — which is the whole of what keeps the namespace person-only.
  assert.deepEqual(Object.keys((await invariantStore.load("demo")).entries), []);
});
