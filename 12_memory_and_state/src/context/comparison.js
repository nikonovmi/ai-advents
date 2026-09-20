import { estimateCost } from "../llm/pricing.js";
import { DEFAULT_USER, ProfileStore, normaliseProfile } from "../store/profileStore.js";
import { MemoryStrategy } from "./memory.js";

/**
 * **The same message, the same history, N profiles, side by side.**
 *
 * The claim personalization makes is that the profile changes the answer. That
 * claim is either visible or it is marketing, and the only way to see it is to
 * hold everything else still — the question, the conversation behind it, the
 * persona, the window — and vary the one thing.
 *
 * **It is strictly read-only, and that is the hard part.** A comparison arm is
 * a whole turn: `memory` extracts on every user message, so simply calling
 * `buildPayload` three times per profile would run nine extraction calls whose
 * patches all want to be written, would fold the digest, and would leave three
 * profile stores and a conversation record permanently changed by an act of
 * *looking*. The old strategy replay could get away with being careless here
 * because `summary` and `facts` only ever wrote to the state handed back to
 * them; this one writes to a store that outlives the conversation.
 *
 * So the discipline is enforced in three places rather than trusted once:
 *
 *   - every arm gets a {@link ReadOnlyProfileStore}, which loads through and
 *     swallows writes, so an extraction that routes a `preference.*` to
 *     long-term cannot reach the file;
 *   - the returned `state` from every `buildPayload` is **discarded**, so no
 *     op is applied, no digest is folded and no proposal is recorded;
 *   - the caller never saves the conversation record — the route that runs
 *     this one deliberately does not go through the save-everything helper the
 *     other memory routes use.
 *
 * And the bill lives in its own `meta`. A comparison is a thing you chose to
 * pay for to answer a question about the system, not a turn the conversation
 * took; folding six extra completions into the conversation's totals would put
 * the cost of *measuring* into the number being measured.
 *
 * **Three samples, all shown.** Extraction is a sampled call, the reply is a
 * sampled call, and one run of each is an anecdote. Three is not statistics
 * either — it is enough to tell "this profile changes the answer" from "that
 * model was feeling terse", which is the failure a single run cannot rule out.
 */

/**
 * A profile store that reads and refuses to write.
 *
 * It does not throw on a write. `MemoryStrategy` treats a failed save as a
 * degraded turn and logs it, so throwing would fill the console with errors
 * describing the design working correctly. It records the attempt instead,
 * which is the thing a test wants to assert on anyway.
 */
export class ReadOnlyProfileStore extends ProfileStore {
  #inner;
  /** Every write this store refused, for the caller to inspect. */
  refused = [];

  /** @param {ProfileStore} inner */
  constructor(inner) {
    super();
    this.#inner = inner;
  }

  async load(userId = DEFAULT_USER) {
    return this.#inner.load(userId);
  }

  async save(userId = DEFAULT_USER, profile) {
    this.refused.push({ op: "save", userId });
    // The shape a real save returns, so a caller that uses the result carries
    // on working — it simply never reaches disk.
    return { ...normaliseProfile(profile, userId), updatedAt: new Date().toISOString() };
  }

  async clear(userId = DEFAULT_USER) {
    this.refused.push({ op: "clear", userId });
  }

  async list() {
    return this.#inner.list();
  }
}

/**
 * Run one message against several profiles and hand back every answer.
 *
 * @param {object} params
 * @param {string} params.message - The user turn every arm is asked.
 * @param {import("../store/conversationStore.js").StoredMessage[]} [params.history]
 *   The conversation behind it, identical for every arm.
 * @param {object} [params.state] - The branch's memory state. Copied per run
 *   and thrown away after it.
 * @param {string} params.systemPrompt
 * @param {import("../llm/provider.js").LlmProvider} params.provider
 * @param {import("../store/profileStore.js").ProfileStore} params.profileStore
 * @param {string[]} params.profiles - Profile ids, in the order to show them.
 * @param {number} [params.samples] - Runs per arm.
 * @param {number} [params.contextMessages]
 * @param {number} [params.maxTokens]
 * @param {number} [params.temperature]
 * @param {string} [params.model]
 */
export async function compareProfiles({
  message,
  history = [],
  state = null,
  systemPrompt = "",
  provider,
  profileStore,
  profiles = [],
  samples = 3,
  contextMessages = 10,
  maxTokens = 1024,
  temperature = 0.7,
  model,
} = {}) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) throw new Error("A comparison needs a message to ask.");
  const users = [...new Set(profiles.filter((id) => typeof id === "string" && id.trim()))];
  if (users.length < 2) throw new Error("A comparison needs at least two profiles.");
  if (!provider || typeof provider.complete !== "function") {
    throw new Error("A comparison needs a provider with a complete() method.");
  }

  const runs = Math.max(1, Math.min(5, Math.floor(samples) || 1));
  // The message the arms are asked is appended here and nowhere else: the
  // caller's history array is the live one the conversation is using, and a
  // read-only view that pushes onto it is not read-only.
  const turn = [...history, { role: "user", content: text }];
  const startedAt = Date.now();

  const arms = await Promise.all(
    users.map((user) => runArm({
      user,
      runs,
      turn,
      state,
      systemPrompt,
      provider,
      profileStore,
      contextMessages,
      maxTokens,
      temperature,
      model,
    }))
  );

  const meta = arms.reduce(
    (total, arm) => ({
      inputTokens: total.inputTokens + arm.usage.inputTokens,
      outputTokens: total.outputTokens + arm.usage.outputTokens,
      overheadTokens: total.overheadTokens + arm.usage.overheadTokens,
      costUsd: total.costUsd + arm.usage.costUsd,
      calls: total.calls + arm.usage.calls,
    }),
    { inputTokens: 0, outputTokens: 0, overheadTokens: 0, costUsd: 0, calls: 0 }
  );

  return {
    message: text,
    samples: runs,
    turns: history.length,
    arms,
    // Its own bill, never the conversation's. See the header.
    meta: { ...meta, ms: Date.now() - startedAt, billedToConversation: false },
  };
}

/** One profile, `runs` times, each one a whole turn that is then thrown away. */
async function runArm({
  user,
  runs,
  turn,
  state,
  systemPrompt,
  provider,
  profileStore,
  contextMessages,
  maxTokens,
  temperature,
  model,
}) {
  const store = new ReadOnlyProfileStore(profileStore);
  const strategy = new MemoryStrategy({ contextMessages, profileStore: store, user, model });
  const results = [];

  // Sequential within an arm, concurrent across them: three samples of the
  // same profile are three calls that differ only by sampling, and firing them
  // at once buys a second of wall clock at the price of a rate limit.
  for (let index = 0; index < runs; index++) {
    results.push(
      await runOnce({ strategy, turn, state, systemPrompt, provider, maxTokens, temperature, model, index })
    );
  }

  const profile = await store.load(user);
  return {
    user,
    entryCount: Object.keys(profile.entries).length,
    declaredCount: Object.values(profile.entries).filter((entry) => entry.source === "declared").length,
    runs: results,
    // What was refused, so "read-only" is something the answer can show rather
    // than something the documentation claims.
    refusedWrites: store.refused.length,
    usage: results.reduce(
      (total, run) => ({
        inputTokens: total.inputTokens + (run.usage?.inputTokens ?? 0),
        outputTokens: total.outputTokens + (run.usage?.outputTokens ?? 0),
        overheadTokens: total.overheadTokens + (run.overheadTokens ?? 0),
        costUsd: total.costUsd + (run.costUsd ?? 0),
        calls: total.calls + (run.calls ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0, overheadTokens: 0, costUsd: 0, calls: 0 }
    ),
  };
}

async function runOnce({ strategy, turn, state, systemPrompt, provider, maxTokens, temperature, model, index }) {
  const startedAt = Date.now();
  try {
    const built = await strategy.buildPayload({
      history: turn,
      systemPrompt,
      // A fresh copy per run. Sharing one object between three samples would
      // let run 1's extraction show up in run 2's block and the three runs
      // would stop being three samples of the same thing.
      state: state ? structuredClone(state) : strategy.emptyState(),
      provider,
      model,
    });

    const result = await provider.complete({
      system: built.system,
      messages: built.messages,
      temperature,
      maxTokens,
      model,
    });

    const cost = estimateCost({
      model: result?.model ?? model,
      inputTokens: result?.usage?.inputTokens ?? 0,
      outputTokens: result?.usage?.outputTokens ?? 0,
    });

    return {
      run: index + 1,
      ok: true,
      reply: result?.text ?? "",
      model: result?.model ?? null,
      ms: Date.now() - startedAt,
      usage: result?.usage ?? { inputTokens: 0, outputTokens: 0 },
      // Exactly the block this arm was sent, lifted out of the string that was
      // sent. The whole demonstration is structural — *this* went in, *that*
      // came back — so quoting the payload matters more than any claim the
      // model could be asked to make about which preferences it used.
      profileBlock: blockFrom(built.system, "profile"),
      workingBlock: blockFrom(built.system, "working"),
      layers: built.meta?.layers ?? null,
      note: built.meta?.note ?? "",
      overheadTokens: built.meta?.overheadTokens ?? 0,
      calls: (built.meta?.overheadCalls ?? 0) + 1,
      costUsd: (cost.totalCost ?? 0) + (built.meta?.overheadCost ?? 0),
      // `built.state` is deliberately not returned. It is the whole read-only
      // rule in one line: the turn happened, and nothing it learned is kept.
    };
  } catch (err) {
    // One arm falling over is a result, not the end of the comparison.
    console.error("[compare] a run failed:", err?.message ?? err);
    return {
      run: index + 1,
      ok: false,
      reply: "",
      error: err?.message ?? String(err),
      ms: Date.now() - startedAt,
      usage: { inputTokens: 0, outputTokens: 0 },
      overheadTokens: 0,
      calls: 0,
      costUsd: 0,
    };
  }
}

/** The `<profile>` or `<working>` block as it actually went on the wire. */
function blockFrom(system, tag) {
  const match = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`).exec(String(system ?? ""));
  return match ? match[0] : "";
}
