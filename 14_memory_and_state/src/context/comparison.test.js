import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Agent } from "../agent.js";
import { MemoryStore } from "../store/memoryStore.js";
import { JsonProfileStore } from "../store/profileStore.js";
import { compareProfiles } from "./comparison.js";
import { MemoryStrategy } from "./memory.js";

const SESSION = "44444444-4444-4444-8444-444444444444";

/**
 * A provider that answers in the shape of whatever it was told to be.
 *
 * Not a joke fixture: the thing under test is *what reached the model*, and a
 * stub that ignores its system prompt would let a comparison that sent both
 * arms the same block still pass. This one puts the rules it was given into
 * its reply, so an arm that was not personalised is visible in the output.
 */
class ProfileEchoProvider {
  calls = [];
  model = "stub";

  async complete({ system, messages }) {
    this.calls.push({ system, messages });
    const rules = [...String(system).matchAll(/^rule\.[a-z0-9_-]+: (.+)$/gm)].map((m) => m[1]);
    return {
      text: rules.length ? `obeying: ${rules.join(" / ")}` : "no rules given",
      model: "stub",
      stopReason: "end_turn",
      usage: { inputTokens: 40, outputTokens: 12 },
    };
  }

  async countTokens({ messages }) {
    return { inputTokens: messages.length };
  }
}

async function seededStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "profiles-"));
  const store = new JsonProfileStore({ dir });
  await store.save("novice", {
    user: "novice",
    nextId: 4,
    entries: {
      "preference.style": { id: "e1", key: "preference.style", value: "Terse, plain words, assume no background", source: "declared" },
      "preference.format": { id: "e2", key: "preference.format", value: "Short prose, four sentences at most", source: "declared" },
      "rule.no-code": { id: "e3", key: "rule.no-code", value: "Never show code", source: "declared" },
    },
  });
  await store.save("expert", {
    user: "expert",
    nextId: 4,
    entries: {
      "preference.style": { id: "e1", key: "preference.style", value: "Dense and technical, assume expert", source: "declared" },
      "preference.format": { id: "e2", key: "preference.format", value: "Code first, prose after", source: "declared" },
      "rule.no-preamble": { id: "e3", key: "rule.no-preamble", value: "Never open with a summary of the question", source: "declared" },
    },
  });
  return { dir, store };
}

/** Every profile file, as bytes. The strongest form of "nothing was written". */
async function bytesIn(dir) {
  const names = (await fs.readdir(dir)).sort();
  const files = {};
  for (const name of names) files[name] = await fs.readFile(path.join(dir, name), "utf8");
  return files;
}

test("a comparison sends each profile its own block, three times over", async () => {
  const { dir, store } = await seededStore();
  const provider = new ProfileEchoProvider();

  const comparison = await compareProfiles({
    message: "How does a bloom filter avoid false negatives?",
    systemPrompt: "persona",
    provider,
    profileStore: store,
    profiles: ["novice", "expert"],
    samples: 3,
  });

  assert.equal(comparison.arms.length, 2);
  assert.deepEqual(comparison.arms.map((arm) => arm.user), ["novice", "expert"]);

  // Three runs per arm, all of them returned. One run is an anecdote: the
  // whole point of showing three is that a reader can tell a profile changing
  // the answer from a model having a quiet turn.
  for (const arm of comparison.arms) {
    assert.equal(arm.runs.length, 3);
    for (const run of arm.runs) assert.equal(run.ok, true);
  }

  // The evidence is structural — *this* went in, *that* came back. Nothing
  // asks the model which preferences it used, because it would confabulate.
  const [novice, expert] = comparison.arms;
  for (const run of novice.runs) {
    assert.match(run.profileBlock, /rule\.no-code: Never show code/);
    assert.doesNotMatch(run.profileBlock, /Code first/);
    assert.equal(run.reply, "obeying: Never show code");
  }
  for (const run of expert.runs) {
    assert.match(run.profileBlock, /preference\.format: Code first, prose after/);
    assert.doesNotMatch(run.profileBlock, /Never show code/);
    assert.equal(run.reply, "obeying: Never open with a summary of the question");
  }

  // Same question, same history, same persona for every arm — the whole claim
  // rests on nothing else having differed. (The extractor talks to the same
  // provider, so the reply calls are the ones opening with the persona.)
  const replies = provider.calls.filter((call) => call.system.startsWith("persona"));
  assert.equal(replies.length, 6);
  for (const call of replies) {
    assert.equal(call.messages.at(-1).content, "How does a bloom filter avoid false negatives?");
  }

  // Its own bill, and it says so. Folding this into the conversation's totals
  // would put the cost of measuring into the number being measured.
  assert.equal(comparison.meta.billedToConversation, false);
  assert.ok(comparison.meta.outputTokens > 0);
  assert.equal(comparison.meta.calls, comparison.arms.reduce((n, arm) => n + arm.usage.calls, 0));

  await fs.rm(dir, { recursive: true, force: true });
});

test("a comparison writes nothing at all — not to the profiles, not to the conversation", async () => {
  const { dir, store } = await seededStore();
  const conversations = new MemoryStore();

  // A real conversation with real memory in it, so there is something to
  // corrupt. The agent runs one turn through the ordinary write path first.
  const agent = new Agent({
    provider: new ProfileEchoProvider(),
    store: conversations,
    sessionId: SESSION,
    contextMessages: 10,
    strategy: new MemoryStrategy({
      contextMessages: 10,
      profileStore: store,
      user: "novice",
      extractor: { async extract() { return { ops: [{ op: "set", key: "goal", value: "learn about filters" }], usage: { inputTokens: 1, outputTokens: 1 }, model: "stub", ms: 1 }; } },
      promoter: { async propose() { return { proposals: [], usage: {}, model: "stub", ms: 1 }; } },
      summarizer: { async summarize() { return { text: "digest", usage: {}, model: "stub", ms: 1 }; } },
    }),
  });
  await agent.run("tell me about bloom filters");

  const record = await conversations.load(SESSION);
  const before = {
    profiles: await bytesIn(dir),
    conversation: JSON.stringify(await conversations.load(SESSION)),
  };

  const comparison = await compareProfiles({
    message: "and what about counting bloom filters?",
    history: record.messages,
    state: record.branches.main.strategyState.memory,
    systemPrompt: "persona",
    provider: new ProfileEchoProvider(),
    profileStore: store,
    profiles: ["novice", "expert"],
    samples: 3,
  });

  // Six whole turns happened — six payloads built, six replies produced.
  assert.equal(comparison.arms.reduce((n, arm) => n + arm.runs.length, 0), 6);

  const after = {
    profiles: await bytesIn(dir),
    conversation: JSON.stringify(await conversations.load(SESSION)),
  };

  assert.deepEqual(after.profiles, before.profiles, "a comparison wrote to long-term memory");
  assert.equal(after.conversation, before.conversation, "a comparison wrote to the conversation record");
  // Nothing was appended to the transcript either: a comparison is not a turn.
  assert.equal((await conversations.load(SESSION)).messages.length, 2);

  await fs.rm(dir, { recursive: true, force: true });
});

test("a comparison arm that extracts still writes nothing", async () => {
  const { dir, store } = await seededStore();
  const before = await bytesIn(dir);

  // The live extractor inside an arm is a real `MemoryExtractor` talking to
  // the provider, so a provider that answers with a valid patch is the way to
  // drive the write path for real rather than around it.
  class PatchingProvider extends ProfileEchoProvider {
    async complete(params) {
      // The extraction call is the one with the routing prompt in its system
      // string; the reply call is the one with the persona.
      if (/You maintain a small key-value store/.test(params.system ?? "")) {
        this.calls.push(params);
        return {
          text: '[{"op":"set","key":"preference.style","value":"overwritten by a comparison"},' +
                ' {"op":"set","key":"rule.shouting","value":"ALWAYS SHOUT"}]',
          model: "stub",
          stopReason: "end_turn",
          usage: { inputTokens: 30, outputTokens: 20 },
        };
      }
      return super.complete(params);
    }
  }

  const comparison = await compareProfiles({
    message: "answer me",
    systemPrompt: "persona",
    provider: new PatchingProvider(),
    profileStore: store,
    profiles: ["novice", "expert"],
    samples: 2,
  });

  // The patch was produced, applied to a throwaway profile, and dropped: the
  // *reply* saw the new rule — extraction runs before the answer, which is the
  // whole reason it costs a call — and the store never did.
  assert.match(comparison.arms[0].runs[0].profileBlock, /rule\.shouting: ALWAYS SHOUT/);
  // And the other half of the patch never landed even in the throwaway copy:
  // `preference.style` is declared in both seeds, and this op came from a
  // model. Declared wins inside a comparison exactly as it does in a turn.
  assert.doesNotMatch(comparison.arms[0].runs[0].profileBlock, /overwritten by a comparison/);
  assert.deepEqual(await bytesIn(dir), before, "an arm's extraction reached the profile store");
  assert.ok(comparison.arms[0].refusedWrites > 0, "the read-only store never saw the write it refused");

  await fs.rm(dir, { recursive: true, force: true });
});

test("a comparison refuses to be a comparison of one", async () => {
  const { dir, store } = await seededStore();
  const provider = new ProfileEchoProvider();

  await assert.rejects(
    () => compareProfiles({ message: "hi", provider, profileStore: store, profiles: ["novice"] }),
    /at least two profiles/
  );
  await assert.rejects(
    () => compareProfiles({ message: "  ", provider, profileStore: store, profiles: ["novice", "expert"] }),
    /needs a message/
  );

  await fs.rm(dir, { recursive: true, force: true });
});
