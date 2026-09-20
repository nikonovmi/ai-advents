import { estimateCost } from "../llm/pricing.js";
import { Summarizer } from "../summarizer.js";
import { DEFAULT_USER, defaultProfileStore } from "../store/profileStore.js";
import { exchangeStarts, foldTo, snapToUserMessage, toWire } from "./boundaries.js";
import { ContextStrategy, NO_OVERHEAD, overheadFrom } from "./strategy.js";
import { summaryBlock } from "./summarization.js";

/**
 * **The routing table.** One place, in code, identical every run.
 *
 * The extractor proposes a *key*. It never proposes a layer, is never asked
 * which layer a key belongs in, and is never shown that layers exist. The
 * namespace of the key it chose is looked up here and that is the whole of the
 * decision — which is what makes "why is this in long-term?" a question with
 * an answer rather than a question about what a model felt like doing on a
 * particular afternoon.
 *
 *   - `layer`      — which of the three memories the key lives in.
 *   - `evict`      — `task` clears when the user finishes the task; `never`
 *                    means only an explicit delete removes it.
 *   - `promotable` — may be offered for long-term at the task boundary. A goal
 *                    or an open question is over when the task is; a decision
 *                    or an agreement can outlive it.
 */
export const ROUTES = {
  goal: { layer: "working", evict: "task", singular: true },
  constraint: { layer: "working", evict: "task" },
  finding: { layer: "working", evict: "task" },
  open: { layer: "working", evict: "task" },
  decision: { layer: "working", evict: "task", promotable: true },
  agreement: { layer: "working", evict: "task", promotable: true },
  profile: { layer: "longterm", evict: "never" },
  preference: { layer: "longterm", evict: "never" },
  rule: { layer: "longterm", evict: "never" },
};

/** The namespaces, in the order a block lists them. */
export const NAMESPACES = Object.keys(ROUTES);

/**
 * One line each, for the extractor's prompt and for the panel's legend.
 *
 * Two of these are dotted rather than bare, and that is the whole of the fix
 * for the thing the README calls the recurring lesson: *a misfiled fact is
 * usually a missing row*. "Keep it short", "bullets please" and "never use
 * em-dashes" had no durable home, so they were filed as `constraint.*` —
 * task-scoped — and were deleted at the next *Finish task*, which is exactly
 * backwards for the one kind of thing a user expects never to have to repeat.
 *
 * The routing table itself did not need a new *layer* for them. The router
 * cares about one distinction and one only — **durable vs task-scoped** — and
 * `preference` was already durable. What was missing was the extractor knowing
 * that a request about tone or format is a `preference.*`, so the meanings
 * table names the two sub-keys directly. `rule` is a namespace of its own
 * because a standing rule is not a *want*: "I prefer bullets" and "never use
 * em-dashes" behave differently when the two disagree with each other, and
 * they read differently in the block the model is handed.
 */
const MEANINGS = {
  goal: "what the user is trying to achieve in the work at hand",
  constraint: "something *the work in hand* must respect — a version, a port, a date, a budget. Dies with the task",
  finding: "something learned about the subject of the work — an observation, a result, a measurement",
  open: "a question nobody has answered yet — never something you have just learned",
  decision: "something that has been settled",
  agreement: "something the user and the assistant agreed to do",
  profile: "who the user is — their role, team, company, stack; true of them whatever the task",
  preference: "how this user likes to work, true beyond the task at hand",
  "preference.style": "how they want to be spoken to — tone, warmth, verbosity, how much to assume they know",
  "preference.format": "what an answer should look like — bullets or prose, code first, how long",
  rule: "a hard standing rule the assistant must always obey, stated as a prohibition or an obligation ('never use em-dashes', 'always show the SQL'). Needs a sub-key: rule.emdash, rule.sql",
};

/** `constraint.database`, `preference.tooling`, or a bare `goal`. */
const KEY_PATTERN = new RegExp(`^(${NAMESPACES.join("|")})(\\.[a-z0-9][a-z0-9_-]*){0,2}$`);

const MAX_VALUE_LENGTH = 240;
/** How many superseded values a working key remembers, so the UI can show a change. */
const HISTORY_DEPTH = 3;
/** How many closed tasks and how many turns of attribution are worth keeping. */
const MAX_PAST_TASKS = 12;
const MAX_ATTRIBUTION = 80;
/** Keys the panel may still show as "proposed, not stored". */
const MAX_DISCARDED = 12;

/**
 * What a key resolves to, or null when nothing does.
 *
 * Exported because this is the function the routing test drives: every
 * namespace resolves to exactly one layer, and an unknown one resolves to
 * nothing at all rather than to a guess.
 *
 * @param {string} key
 * @returns {{ namespace: string, layer: "working" | "longterm", evict: string, promotable: boolean } | null}
 */
export function routeFor(key) {
  const text = typeof key === "string" ? key.trim().toLowerCase() : "";
  if (!KEY_PATTERN.test(text)) return null;
  const namespace = text.split(".")[0];
  const route = ROUTES[namespace];
  if (!route) return null;
  return {
    namespace,
    layer: route.layer,
    evict: route.evict,
    promotable: Boolean(route.promotable),
    // A task has one goal, so `goal` is a key. A user has a role *and* a city
    // *and* a team, so a bare `profile` is not a key — it is a whole layer
    // collapsed into one slot, where every new fact silently overwrites the
    // last one. Long-term never expires, which makes that overwrite permanent.
    singular: Boolean(route.singular),
    bare: text === namespace,
  };
}

// ---- the three blocks -------------------------------------------------------

/**
 * Long-term memory, for the system prompt.
 *
 * Everything the model is told about the user rides in the system string
 * rather than in the messages, for the reason the summary does: a
 * third-person note about the user read as an assistant message is something
 * the model thinks it said out loud, and it answers in that register.
 *
 * @param {Record<string, { value: string }>} entries
 */
export function profileBlock(entries) {
  const keys = orderKeys(entries);
  const lines = keys.map((key) => `${key}: ${entries[key].value}`);
  if (!lines.length) return "";

  // A `profile.*` fact is context; a `preference.*` or a `rule.*` is an
  // instruction, and the difference has to be said out loud. Told only that
  // something is "known about this user", a model treats "prefers bullets" as
  // a biographical detail and answers in prose anyway — which makes the whole
  // layer look like it is not working when what is not working is one line of
  // framing. It is conditional because a profile with no standing instructions
  // in it should not pay for a sentence about them on every turn.
  const standing = keys.some((key) => key.startsWith("preference") || key.startsWith("rule"));

  return [
    "",
    "",
    "<profile>",
    "Known about this user from every conversation so far — long-lived, and true until they say otherwise.",
    ...(standing
      ? [
          "The preference.* and rule.* lines are standing instructions about how to answer. Follow them in this reply and every reply, even when the question says nothing about them. A rule.* line is absolute.",
        ]
      : []),
    ...lines,
    "</profile>",
  ].join("\n");
}

/**
 * Working memory, for the system prompt.
 *
 * The header earns its place: without "what is true now, not what was said"
 * the model treats the block as a second digest and starts narrating from it.
 *
 * @param {Record<string, { value: string }>} working
 */
export function workingBlock(working) {
  const lines = orderKeys(working).map((key) => `${key}: ${working[key].value}`);
  if (!lines.length) return "";
  return [
    "",
    "",
    "<working>",
    "The task in hand — what is currently *true about the work*, not a record of what was said. All of it is live.",
    ...lines,
    "</working>",
  ].join("\n");
}

// ---- the extractor ----------------------------------------------------------

const EXTRACTOR_PROMPT = [
  "You maintain a small key-value store of what is established in an ongoing",
  "conversation. You are shown everything already stored — with its current value —",
  "and the latest exchange.",
  "",
  "Return ONLY the changes the latest exchange makes: a JSON array of operations,",
  "and nothing else.",
  "",
  'Format: [{"op":"set","key":"constraint.database","value":"Postgres 14 on port 8477"},',
  '         {"op":"delete","key":"open.region"}]',
  "",
  "Choose the key. Nothing else about where it is kept is yours to decide — do not",
  "label anything short-term, long-term, temporary or permanent, and do not add any",
  "field other than op, key and value.",
  "",
  "The namespaces, and what each one means:",
  ...Object.entries(MEANINGS).map(([key, meaning]) => `- ${key}: ${meaning}`),
  "",
  "WHAT COUNTS AS A CHANGE — this is the part that goes wrong:",
  "- Return [] when the exchange establishes nothing new. **Most turns establish nothing.**",
  "- A key that is already stored is `set` again only when **the fact itself has changed**.",
  "  Re-wording it, narrowing it, sharpening it or restating it in the vocabulary of the",
  "  newest message is NOT a change. If the stored value is still true, leave it alone.",
  "- **Zooming in is not a change of goal.** `goal: decide whether to hire this candidate`",
  "  stays exactly as it is while the conversation works through the candidate's algorithms,",
  "  the seniority of the role, the other interviews and the interviewer's doubts — every one",
  "  of those is part of *pursuing* that goal, not a new one. Only the user turning to a",
  "  different objective changes it.",
  "- Write every value so it still makes sense on its own next week, not only in the light",
  "  of the message you have just read.",
  "- The opposite failure is just as bad. When the exchange genuinely reverses, corrects,",
  "  contradicts or supersedes what a key stands for, you MUST emit a `set` for that exact",
  "  key with the new value. 'Actually…', 'correction', 'change of plan', 'scratch that' and",
  "  'we decided the opposite' all mean a `set`. A stale value is as broken as one that",
  "  churns every turn.",
  "- Reuse an existing key when the exchange updates that fact — `set` overwrites it. Only",
  "  invent a key when nothing already stored fits.",
  "- Being conservative applies to **rewriting what is already stored**, and to nothing else.",
  "  A fact that is genuinely new, a question that has just been answered and a choice the",
  "  user has just made are all changes, and missing them is its own failure. A store that",
  "  stopped moving is as wrong as one that never settles.",
  "- Something you have **learned** is a `finding.*`, never an `open.*`. 'The candidate",
  "  struggled with DFS', 'the p99 is 400ms', 'the team was impressed' are findings. An",
  "  `open.*` is only ever a question nobody has answered yet.",
  "- **Closing an open question must record its answer, in the same array.** The moment the",
  "  exchange answers an `open.*` — including when the assistant answered it in the very",
  "  message you are reading — emit both ops: the `delete` for the question *and* a `set` for",
  "  what the answer established (`finding.*` when something was learned, `decision.*` when",
  "  the user chose). A lone `delete` throws the only record away: the question is very often",
  "  the only place that fact was ever written down.",
  "- When the user chooses, commits, agrees or rules something out, that is a `decision.*`,",
  "  even when they say it casually: 'alright, I'll go with that', 'fine, let's do it',",
  "  'I'm ready to pay more'. Record what they chose, and delete the `open.*` it answers.",
  "",
  "Rules:",
  "- A fact about the **user themselves** is `profile.*`: 'I'm a senior Android developer',",
  "  'we're a three-person team', 'I've just moved to Berlin'. Name which fact it is in the",
  "  sub-key — `profile.role`, `profile.location`, `profile.team`, `profile.company`,",
  "  `profile.stack`, `profile.experience` — so that the next thing they tell you about",
  "  themselves lands beside it instead of on top of it. A fact about someone or something",
  "  they are *working on* — a candidate, a ticket, a release — is not a profile fact: that",
  "  belongs to the task, as a `constraint.*` or a `decision.*`, and dies with it.",
  "- **How they want to be answered is durable, never a `constraint.*`.** Ask when it stops",
  "  being true: at the end of this task, or never. 'Keep this plan under two pages' is a",
  "  `constraint.*`; 'keep your answers short' is about you, forever. One example of each:",
  '    "I get lost in long answers" → {"op":"set","key":"preference.style","value":"Wants brief answers"}',
  '    "bullets, code before the prose" → {"op":"set","key":"preference.format","value":"Bullets, code first"}',
  '    "never use em-dashes" → {"op":"set","key":"rule.emdash","value":"Never use em-dashes"}',
  "  A `rule.*` is an absolute they stated as one ('never', 'always'); a softer want is a",
  "  `preference.*`. Do not promote a preference to a rule because it was said firmly.",
  "- `preference.*` is for how the user works in general ('always show me the SQL',",
  "  'I hate emoji'). Something true only of this piece of work is a constraint, not a",
  "  preference.",
  "- Keys are lowercase and dotted, at most three segments, and must begin with one of:",
  "  " + NAMESPACES.join(" ") + ".",
  "- `goal` is the only key that may be a bare namespace — a task has one goal. Everything",
  "  else needs at least one sub-key: `profile.role`, `profile.city`, `constraint.budget`,",
  "  `open.parking`. A bare `profile` is one slot for everything about a person, and the",
  "  second fact would overwrite the first.",
  "- Keep names, numbers, file paths, versions, port numbers and dates **exactly** as the",
  "  user stated them. Never round, rename or paraphrase a specific value.",
  "- Values are under 20 words.",
  "- Use `delete` only when the user withdraws something or an open question is answered.",
  "- Record what the USER established. Do not record the assistant's own suggestions.",
  "- Output the JSON array and nothing else: no prose, no explanation, no code fences.",
].join("\n");

/**
 * The per-turn extraction call: the keys that exist plus the latest exchange
 * in, a patch out.
 *
 * It is a separate class for the same reason `Summarizer` is: it is the part
 * with a prompt in it, and the part a test wants to replace.
 */
export class MemoryExtractor {
  #provider;

  constructor({ provider, model, maxTokens = 300 } = {}) {
    if (!provider || typeof provider.complete !== "function") {
      throw new Error("MemoryExtractor requires a provider with a complete() method");
    }
    this.#provider = provider;
    this.model = model;
    this.maxTokens = maxTokens;
  }

  /**
   * @param {object} params
   * @param {{ key: string, value: string }[]} [params.stored] - Everything
   *   already held, **with its current value**. Names alone are not enough: a
   *   model that cannot see what `goal` currently says cannot be asked to
   *   leave it alone when it has not changed, and it will rewrite it in the
   *   vocabulary of whatever was said last.
   * @param {import("../llm/provider.js").Message[]} [params.exchange]
   */
  async extract({ stored = [], exchange = [] } = {}) {
    const startedAt = Date.now();
    const result = await this.#provider.complete({
      model: this.model,
      system: EXTRACTOR_PROMPT,
      messages: [{ role: "user", content: extractionPrompt(stored, exchange) }],
      temperature: 0,
      maxTokens: this.maxTokens,
    });

    return {
      ops: parseJsonArray(result?.text),
      usage: result?.usage ?? { inputTokens: 0, outputTokens: 0 },
      model: result?.model ?? null,
      ms: Date.now() - startedAt,
    };
  }
}

const PROMOTER_PROMPT = [
  "A piece of work has just finished. You are shown the working memory that was kept",
  "while it ran, and you decide what is worth remembering **about this user** once the",
  "work itself is forgotten.",
  "",
  "PROMOTION CANDIDATES come in; a JSON array of proposals goes out, and nothing else.",
  "",
  'Format: [{"key":"profile.hiring","value":"Hires senior Android engineers on system-design ',
  'strength, and will accept a weak algorithms screen when the rest is solid."}]',
  "",
  "Rules:",
  "- **Promote what the work says about the user, never what happened in it.** A fact about a",
  "  particular person, candidate, ticket, release, repo or customer belongs to the task that",
  "  is ending and dies with it. `decision.hire = \"Sending the offer to the candidate\"` is the",
  "  wrong shape — it will be false by next quarter and it describes someone who is not the",
  "  user. What that decision reveals about how they hire is the right shape.",
  "- Ask of each proposal: would this help in a conversation about something completely",
  "  different next month? If not, leave it out. Returning [] is a perfectly good answer.",
  "- **Rephrase every proposal so it stands alone.** `constraint.latency = \"200ms\"` means",
  "  nothing next week; `Holds API latency to 200ms on billing work` does. Assume the reader",
  "  has never heard of this task.",
  "- Prefer `profile.*` for who the user is and how they work, `preference.*` for how they",
  "  like to be helped. Keep a `decision.*` key only when the decision is a standing policy",
  "  rather than a one-off call.",
  "- Keep names, numbers, versions, ports and dates exactly as they were stated.",
  "- One or two sentences per value, at most.",
  "- Output the JSON array and nothing else: no prose, no explanation, no code fences.",
].join("\n");

/**
 * The task-boundary call: working memory in, long-term proposals out.
 *
 * It runs **once**, when the user says the task is over, and its output is a
 * proposal rather than a write. Nothing it returns reaches the profile store
 * until a human has said yes to that particular line.
 */
export class Promoter {
  #provider;

  constructor({ provider, model, maxTokens = 600 } = {}) {
    if (!provider || typeof provider.complete !== "function") {
      throw new Error("Promoter requires a provider with a complete() method");
    }
    this.#provider = provider;
    this.model = model;
    this.maxTokens = maxTokens;
  }

  /**
   * @param {{ entries: { key: string, value: string }[], context?: string }} params
   */
  async propose({ entries = [], context = "" } = {}) {
    const startedAt = Date.now();
    const result = await this.#provider.complete({
      model: this.model,
      system: PROMOTER_PROMPT,
      messages: [{ role: "user", content: promotionPrompt(entries, context) }],
      temperature: 0,
      maxTokens: this.maxTokens,
    });

    return {
      proposals: parseJsonArray(result?.text)
        .map((item) => ({
          key: typeof item?.key === "string" ? item.key.trim().toLowerCase() : "",
          value: String(item?.value ?? "").replace(/\s+/g, " ").trim(),
        }))
        .filter((item) => item.value),
      usage: result?.usage ?? { inputTokens: 0, outputTokens: 0 },
      model: result?.model ?? null,
      ms: Date.now() - startedAt,
    };
  }
}

// ---- the one mutation path --------------------------------------------------

/**
 * Apply a patch to the two stores, deterministically and in code.
 *
 * Everything that ever changes memory goes through here: the extractor's
 * patch, the panel's *forget* and *promote* buttons, and an approved proposal.
 * One code path means one place where the routing table is consulted, one
 * place where a malformed key is refused, and one thing to test.
 *
 * Three operations exist, and the model is only ever allowed two of them:
 *
 *   - `set`     — route by namespace and write. The extractor may emit this.
 *   - `delete`  — route by namespace and remove, or remove from the layer named
 *                 in `from` when the panel is addressing one row specifically.
 *                 The extractor may emit this.
 *   - `promote` — write to long-term regardless of the key's namespace. This is
 *                 a *human* saying yes, so it is refused when it arrives from a
 *                 model: `allow` does not include it during extraction.
 *
 * **Declared wins.** Long-term entries carry where they came from: `declared`
 * if the user typed them into the profile form, `learned` if the extractor
 * proposed them and they were routed or approved. A *model-originated* op onto
 * a key whose current entry is `declared` does not write — it becomes a
 * correction proposal, in the same shape the task boundary produces, reading
 * *you declared X, the conversation suggests Y*. A person-originated op always
 * writes, and learned-over-learned keeps overwriting exactly as it did before.
 *
 * `origin` and `source` are two different questions and it is worth being
 * clear which is which: `origin` is **who sent this patch** and decides
 * whether the write is allowed at all; `source` is **what to stamp on what
 * gets written** and only matters in long-term. Collapsing them into one field
 * was the first thing tried, and it makes "a person approving a correction to
 * a declared entry" unrepresentable.
 *
 * @param {{ working: Record<string, object>, profile: import("../store/profileStore.js").Profile }} stores
 * @param {unknown[]} ops
 * @param {object} [params]
 * @param {number} [params.turn]
 * @param {number} [params.maxWorking]
 * @param {string[]} [params.allow]
 * @param {"model" | "person"} [params.origin] - Who sent these ops. Defaults to
 *   the cautious answer, which is also the default `allow` list's answer.
 * @param {"declared" | "learned" | null} [params.source] - What to stamp on
 *   long-term writes. `null` keeps whatever the entry already had, and makes a
 *   brand-new entry `learned`.
 */
export function applyOps(
  { working, profile },
  ops,
  {
    turn = 0,
    maxWorking = 40,
    allow = ["set", "delete"],
    longtermDeletes = false,
    unpairedCloses = false,
    origin = "model",
    source = null,
  } = {}
) {
  const nextWorking = { ...(working ?? {}) };
  const nextProfile = { ...profile, entries: { ...(profile?.entries ?? {}) } };
  const permitted = new Set(allow);
  const now = new Date().toISOString();
  /**
   * Whether this patch records anything at all.
   *
   * An `open.*` key is a question, and a question is very often the only place
   * a fact was ever written down — "he struggled with DFS" lives in
   * `open.candidate.dfs_performance` and nowhere else. Closing it without
   * recording the answer does not resolve the question, it erases the subject.
   */
  const records = (Array.isArray(ops) ? ops : []).some(
    (op) => typeof op?.op === "string" && op.op.trim().toLowerCase() === "set"
  );

  const set = [];
  const deleted = [];
  const promoted = [];
  /** Profile entries this patch created or changed, for the caller to stamp. */
  const stamped = [];
  /** Whether long-term was touched at all — a delete leaves nothing to stamp. */
  let profileTouched = false;
  /** Keys that were proposed and not stored — the panel says so out loud. */
  const discarded = [];
  /**
   * Everything this patch noticed and refused to resolve on its own, as
   * `{ key, value, was, reason }` — the raw material for a correction proposal.
   *
   * Two things end up here, and they are the same shape because they are the
   * same event seen from two sides: *long-term and the conversation disagree,
   * and a person has to say which one is right.*
   *
   *   - `task`     — a working write that lands on a key long-term already
   *                  holds. Routing is by namespace, so `decision.hire` always
   *                  lands in working even when a copy of that exact key was
   *                  promoted two conversations ago. Without noticing the
   *                  collision, "we fired him" would update working while the
   *                  profile went on telling every future conversation that he
   *                  was hired, and nothing would ever reconcile the two.
   *   - `declared` — a model-originated write onto a key the user declared.
   *                  The write does not happen; the disagreement is recorded.
   */
  const contested = [];

  for (const op of Array.isArray(ops) ? ops : []) {
    const key = typeof op?.key === "string" ? op.key.trim().toLowerCase() : "";
    const action = typeof op?.op === "string" ? op.op.trim().toLowerCase() : "";
    const route = routeFor(key);

    if (!route) {
      // The interesting failure. A namespace nobody recognises is **discarded,
      // not guessed at** — and it is logged, because "the model proposed
      // something and it went nowhere" is information the panel should show
      // rather than a silence that looks like the model saying nothing.
      discarded.push({ key: key || "(no key)", op: action || "(no op)", reason: "unknown namespace", at: now, turn });
      continue;
    }
    // A bare key may not *create* a slot that everything about a person would
    // then pile into — but it must still be able to update one that already
    // exists, including one written before this rule did. Refusing both is
    // worse than allowing both: it freezes a stale entry as permanently
    // uncorrectable, and the model, told to reuse the stored key, proposes it
    // again on every single turn and loses the fact every single time.
    const alreadyHeld = key in nextWorking || key in nextProfile.entries;
    if (route.bare && !route.singular && !alreadyHeld) {
      discarded.push({
        key,
        op: action || "(no op)",
        value: String(op?.value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_VALUE_LENGTH),
        reason: `needs a sub-key, such as ${route.namespace}.role`,
        at: now,
        turn,
      });
      continue;
    }
    if (!permitted.has(action)) {
      discarded.push({ key, op: action || "(no op)", reason: "operation not allowed here", at: now, turn });
      continue;
    }

    // The profile form may only write to the profile. A `constraint.*` typed
    // into a field labelled "how I like to be answered" would be routed to
    // working memory and deleted at the next *Finish task* — the exact failure
    // the durable namespaces were added to end, arriving by a different door.
    if (source === "declared" && route.layer !== "longterm" && action !== "delete") {
      discarded.push({
        key,
        op: action,
        value: String(op?.value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_VALUE_LENGTH),
        reason: `only long-term entries can be declared — ${route.namespace} is cleared when a task ends`,
        at: now,
        turn,
      });
      continue;
    }

    if (action === "delete" && route.namespace === "open" && !records && !unpairedCloses) {
      discarded.push({
        key,
        op: action,
        value: "",
        reason: "an answered question must be replaced, not just removed",
        at: now,
        turn,
      });
      continue;
    }

    if (action === "delete") {
      const from = op.from === "profile" || op.from === "longterm" ? "longterm" : op.from === "working" ? "working" : route.layer;
      if (from === "longterm" && !longtermDeletes) {
        // Routing lets the extractor *write* long-term, because a preference
        // stated in passing is worth keeping and nobody wants a dialogue box
        // for it. Erasing one is the asymmetric case: working memory is
        // rebuilt every task and long-term is not, so a delete there is
        // permanent and belongs to the person, not the model.
        discarded.push({ key, op: action, reason: "long-term deletes are yours to make", at: now, turn });
        continue;
      }
      if (from === "longterm") {
        if (nextProfile.entries[key]) {
          delete nextProfile.entries[key];
          deleted.push(key);
          profileTouched = true;
        }
      } else if (key in nextWorking) {
        delete nextWorking[key];
        deleted.push(key);
      }
      continue;
    }

    const value = String(op.value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_VALUE_LENGTH);

    if (action === "promote") {
      const text = value || nextWorking[key]?.value || "";
      if (!text) {
        discarded.push({ key, op: action, reason: "nothing to promote", at: now, turn });
        continue;
      }
      const entry = writeProfile(nextProfile, key, text, source, now);
      stamped.push(entry.id);
      promoted.push(key);
      profileTouched = true;
      continue;
    }

    // `set`, routed by the namespace and nothing else.
    if (!value) {
      discarded.push({ key, op: action, reason: "empty value", at: now, turn });
      continue;
    }

    if (route.layer === "longterm") {
      const held = nextProfile.entries[key];
      if (held?.value === value) continue;
      // **Declared wins.** The model is not wrong here so much as unaware: it
      // has read one exchange and the user has read their own profile. So the
      // op is kept rather than dropped — as a proposal, where the person who
      // declared the entry can see both sentences side by side and pick one.
      if (held?.source === "declared" && origin === "model") {
        contested.push({ key, value, was: held.value, reason: "declared" });
        continue;
      }
      const entry = writeProfile(nextProfile, key, value, source, now);
      stamped.push(entry.id);
      set.push(key);
      profileTouched = true;
      continue;
    }

    // A `set` that changes nothing is not a change: it must not re-stamp the
    // timestamp that drives eviction, or flash the row in the UI.
    if (nextWorking[key]?.value === value) continue;
    const previous = nextWorking[key]
      ? [...(nextWorking[key].previous ?? []), nextWorking[key].value].slice(-HISTORY_DEPTH)
      : [];
    nextWorking[key] = { value, updatedAt: now, turn, previous };
    set.push(key);
    const held = nextProfile.entries[key];
    if (held && held.value !== value) contested.push({ key, value, was: held.value, reason: "task" });
  }

  return {
    working: evict(nextWorking, maxWorking),
    profile: nextProfile,
    set,
    deleted,
    promoted,
    stamped,
    profileTouched,
    contested,
    discarded,
    changed: [...set, ...deleted, ...promoted],
  };
}

/** Write one long-term entry, keeping the id a key already had. */
function writeProfile(profile, key, value, source, now) {
  const existing = profile.entries[key];
  const entry = {
    id: existing?.id ?? `e${profile.nextId ?? 1}`,
    key,
    value,
    updatedAt: now,
    // `null` means "do not restate the provenance" — which keeps a declared
    // entry declared when the person edits or approves a change to it, and
    // makes anything brand new `learned`.
    source: source ?? existing?.source ?? "learned",
  };
  if (!existing) profile.nextId = (profile.nextId ?? 1) + 1;
  profile.entries[key] = entry;
  return entry;
}

/**
 * Working memory is a fixed-size budget, not a log.
 *
 * This is the graceful degradation for the user who never presses the button:
 * without a task boundary working memory is just `facts`, and it stays inside
 * its budget by dropping the least recently updated key. Worse than a clean
 * boundary, better than unbounded growth.
 */
function evict(working, maxWorking) {
  const limit = Math.max(1, Math.floor(maxWorking));
  const keys = Object.keys(working);
  if (keys.length <= limit) return working;

  const ordered = keys.sort((a, b) => {
    const byTime = String(working[a].updatedAt ?? "").localeCompare(String(working[b].updatedAt ?? ""));
    return byTime !== 0 ? byTime : (working[a].turn ?? 0) - (working[b].turn ?? 0);
  });

  const kept = { ...working };
  for (const key of ordered.slice(0, keys.length - limit)) delete kept[key];
  return kept;
}

// ---- the strategy -----------------------------------------------------------

/**
 * Three memories with three lifetimes, on one wire.
 *
 *     system:   [persona] + <profile>…</profile> + <working>…</working> + [digest]
 *     messages: the exchanges since the digest's edge, verbatim
 *
 * Four sources, three lifetimes, one payload:
 *
 *   - **Short-term** is the verbatim exchanges plus the rolling digest that
 *     stands in for the ones that have scrolled past. It ends when a turn
 *     slides out of the window. The digest is compressed short-term — *not* a
 *     fourth layer, and not the same thing as working memory: the digest
 *     records what was discussed, working memory records what is currently
 *     true about the work.
 *   - **Working** is the distilled state of the task in hand, in
 *     `strategyState`, cleared when the user says the task is over.
 *   - **Long-term** is the profile, which lives outside `data/conversations/`
 *     entirely so that a new chat does not start from nothing.
 *
 * Two schedules, billed apart:
 *
 *   - Extraction runs on **every user turn**, patch-based, over the last
 *     exchange. It cannot wait for the fold — between folds a turn can slide
 *     out of the window uncaptured, and a digest is the wrong input for a
 *     constraint the user stated once in passing.
 *   - Folding runs at the **high-water mark**, through the existing
 *     `Summarizer`, on the scheme the summarization strategy already uses: the
 *     digest's edge and the verbatim region's edge are the same index, so
 *     every stored message is either folded in or on the wire and never in
 *     neither.
 */
export class MemoryStrategy extends ContextStrategy {
  #profileStore;
  #extractor;
  #promoter;
  #summarizer;
  #cachedFor = null;

  /**
   * @param {object} [params]
   * @param {number} [params.contextMessages]
   * @param {number} [params.maxWorking] - LRU budget for the user who never
   *   presses "Finish task".
   * @param {number | null} [params.foldSize]
   * @param {string} [params.model]
   * @param {string} [params.user] - Whose profile to read and write.
   * @param {import("../store/profileStore.js").ProfileStore} [params.profileStore]
   *   Injected the way the provider and the conversation store are. The
   *   default is the process-wide one; a test hands in the in-memory twin.
   * @param {MemoryExtractor} [params.extractor]
   * @param {Promoter} [params.promoter]
   * @param {import("../summarizer.js").Summarizer} [params.summarizer]
   */
  constructor({
    contextMessages = 10,
    maxWorking = 40,
    foldSize = null,
    maxTokens = 300,
    model,
    user = DEFAULT_USER,
    profileStore,
    extractor,
    promoter,
    summarizer,
  } = {}) {
    super();
    this.contextMessages = contextMessages;
    this.maxWorking = maxWorking;
    this.foldSize = foldSize;
    this.maxTokens = maxTokens;
    this.model = model;
    this.user = user;
    this.#profileStore = profileStore ?? null;
    this.#extractor = extractor ?? null;
    this.#promoter = promoter ?? null;
    this.#summarizer = summarizer ?? null;
  }

  get id() {
    return "memory";
  }

  get label() {
    return "Layered memory";
  }

  get description() {
    return "Profile, working memory and a rolling digest in the system prompt. Extracts every turn, folds at the mark, and keeps what you approve forever.";
  }

  /**
   * Switch profiles between turns.
   *
   * The store is one object shared by every profile and keyed by user, so
   * switching is a field assignment and not a reconstruction — and the
   * extractor, the promoter and the summarizer it has already built stay
   * built. An empty id is ignored rather than treated as "nobody": a request
   * that forgot to say whose profile it is should get the one it had, not a
   * blank one.
   */
  useProfile(user) {
    if (typeof user === "string" && user.trim()) this.user = user.trim().toLowerCase();
  }

  /** The store, resolved lazily so listing the catalogue touches no disk. */
  get profileStore() {
    this.#profileStore ??= defaultProfileStore();
    return this.#profileStore;
  }

  emptyState() {
    return {
      working: {},
      digest: null,
      digestThrough: 0,
      digestUpdatedAt: null,
      pastTasks: [],
      proposals: [],
      discarded: [],
      promotedAt: {},
      profileSeen: {},
      profileUser: null,
      attribution: [],
      usage: emptySpend(),
    };
  }

  /** Half the window, rounded down — the same self-pacing fold as `summary`. */
  get fold() {
    const explicit = Number(this.foldSize);
    if (Number.isFinite(explicit) && explicit >= 1) return Math.floor(explicit);
    return Math.max(1, Math.floor(this.contextMessages / 2));
  }

  async buildPayload({ history, systemPrompt, state, provider, model }) {
    // The turn number comes from the branch rather than from a counter in
    // state, because state is copied when a branch forks and a counter copied
    // from a longer branch is simply wrong on the shorter one.
    const turn = exchangeStarts(history).length;
    const current = normaliseState(state);
    current.digestThrough = snapToUserMessage(history, current.digestThrough);
    // Anything stamped with this turn or later was established further down
    // whichever branch this one was forked from. It is dropped rather than
    // shown: the model repeating something nobody on this branch ever said
    // does not read as a storage bug, it reads as a hallucination.
    current.working = entriesAsOf(current.working, turn - 1);

    const profile = await this.#loadProfile();
    const inherited = visibleProfile(profile, current.promotedAt, turn - 1);

    const extracted = await this.#extract({
      history,
      state: current,
      profile,
      provider,
      model,
      turn,
    });
    const folded = await this.#fold({ history, state: extracted.state, provider, model });
    const next = folded.state;

    // The long-term block is the inherited entries plus whatever this turn
    // just wrote — a preference stated in this message must be visible to the
    // answer to this message, which is the whole reason extraction runs first.
    const visible = { ...inherited };
    for (const key of extracted.profileKeys) {
      if (extracted.profile.entries[key]) visible[key] = extracted.profile.entries[key];
      else delete visible[key];
    }

    // **One key, one block.** A key the current task holds is sent from
    // working and left out of the profile, whichever came first. Sending both
    // would put "he was hired" and "he was fired" in front of the model at
    // once, under the same key, with no rule for which wins — and the more
    // recent statement is the one the user just made.
    //
    // **Except a declared entry, which is never shadowed.** The rule above
    // reads the task as the more recent statement, and for a fact about the
    // work that is right. For something the user *wrote down about how they
    // want to be answered* it is exactly wrong: they said it on purpose, in a
    // form, and the thing displacing it was inferred from one exchange by a
    // model. So a declared entry is always sent, and the disagreement becomes
    // the same correction proposal any other disagreement becomes. Silently
    // overriding a declared preference with task state is the failure this
    // exemption exists to make impossible.
    const shadowed = [];
    const exempt = [];
    const overridden = [];
    for (const key of Object.keys(visible)) {
      if (!(key in next.working)) continue;
      if (visible[key].source === "declared") {
        exempt.push(key);
        if (next.working[key].value !== visible[key].value) {
          overridden.push({ key, value: next.working[key].value, was: visible[key].value, reason: "declared" });
        }
        continue;
      }
      delete visible[key];
      shadowed.push(key);
    }
    next.proposals = withCorrections(next.proposals, overridden, turn);

    const blocks = {
      profile: profileBlock(visible),
      working: workingBlock(next.working),
      digest: summaryBlock(next.digest),
    };

    // **What the profile costs, per turn, as a number.** Every other figure in
    // this strategy's bill is a model call it made; this one is not a call at
    // all — it is the block riding along in the input of the turn's own
    // request, on every turn, forever. Leaving it out of the ledger is what
    // lets long-term memory look free, and it is the one layer whose cost is
    // paid again on every single turn whether or not it was used.
    //
    // It is an *estimate*, and deliberately a cheap one: measuring it exactly
    // would mean a second `count_tokens` round trip per turn to answer a
    // question about proportions. The estimator is the usual four-characters-
    // a-token, and the bucket says `estimated: true` so nothing downstream can
    // mistake it for the measured figures beside it.
    next.usage = addProfileSpend(next.usage, blocks.profile, model ?? provider?.model);

    next.profileSeen = snapshot(extracted.profile);
    // Whose profile this was. The panel is built from stored state by routes
    // that hold a record rather than a strategy, so without recording it here
    // the panel could not say which profile the rows above it came from — and
    // after a switch in the topbar it would show one profile's entries under
    // another profile's name.
    next.profileUser = this.user;
    next.attribution = [
      ...next.attribution.filter((row) => row.turn !== turn),
      {
        turn,
        profile: blocks.profile.length,
        working: blocks.working.length,
        digest: blocks.digest.length,
      },
    ].slice(-MAX_ATTRIBUTION);

    const overhead = combine(extracted.overhead, folded.overhead);
    const start = Math.min(Math.max(0, next.digestThrough), history.length);

    return {
      system: systemPrompt + blocks.profile + blocks.working + blocks.digest,
      messages: toWire(history.slice(start)),
      state: next,
      meta: {
        ...overhead,
        note: [extracted.note, folded.note].filter(Boolean).join(" · "),
        droppedMessages: start,
        changedKeys: extracted.changed,
        verbatimExchanges: exchangeStarts(history, start).length,
        layers: {
          profile: Object.keys(visible).length,
          working: Object.keys(next.working).length,
          digest: next.digest ? 1 : 0,
          shadowed,
          // Keys the task also holds that were sent from the profile anyway,
          // because the user declared them.
          declared: exempt,
        },
      },
    };
  }

  /**
   * Three sections, a proposal list and a list of what was thrown away.
   *
   * The profile section is the copy this branch last sent, kept in state
   * alongside the stamps. A panel is built synchronously, by routes that hold
   * a record rather than an agent, so it cannot await a profile read — and the
   * store is re-read on every turn regardless, which puts the ceiling on how
   * stale this can get at one turn.
   *
   * The last one matters more than it looks. A namespace the routing table
   * does not know is discarded in code, and without a line in the panel saying
   * *proposed, not stored: `random.thing`* that discarding is indistinguishable
   * from the extractor having found nothing at all.
   */
  panel(state, { turns = Infinity } = {}) {
    const current = normaliseState(state);
    const working = entriesAsOf(current.working, turns);
    const profile = visibleProfile({ entries: current.profileSeen }, current.promotedAt, turns);
    const proposals = current.proposals.filter((p) => (p.turn ?? 0) <= turns);
    const pending = proposals.filter((p) => p.status === "pending");
    /** The one unanswered correction per key, so a row can show its own. */
    const correctionFor = new Map();
    for (const proposal of pending) {
      if (proposal.kind === "correction") correctionFor.set(proposal.key, proposal);
    }

    return {
      kind: "memory",
      title: "Memory",
      /** Whose long-term memory the rows below were read from, last turn. */
      user: current.profileUser ?? null,
      profile: orderKeys(profile).map((key) => ({
        key,
        namespace: key.split(".")[0],
        value: profile[key].value,
        updatedAt: profile[key].updatedAt,
        source: profile[key].source ?? "learned",
        // You wrote this one down on purpose. It is the flag that decides
        // whether the extractor may overwrite the row and whether the task in
        // hand may displace it on the wire, so the panel marks it rather than
        // leaving the two rules invisible.
        declared: profile[key].source === "declared",
        // What the conversation wants this row to say instead, if anything —
        // the same proposal the list below shows, attached to the row it is
        // about. A correction you can only find by scrolling is one you
        // answer without looking at what it would replace.
        proposal: correctionFor.has(key)
          ? { id: correctionFor.get(key).id, value: correctionFor.get(key).value, reason: correctionFor.get(key).reason ?? "task" }
          : null,
        // A bare key in a namespace that is not singular can no longer be
        // written, so any that survive are from before that rule. They are
        // worth pointing at: the next fact about the user lands *beside* one
        // rather than replacing it, which is how a profile ends up asserting
        // two things that cannot both be true. Code cannot tell that
        // `profile` and `profile.location` mean the same thing — but it can
        // tell which of the two is the shape that was retired.
        legacy: Boolean(routeFor(key)?.bare && !routeFor(key)?.singular),
        // Held by the task in hand as well, with a different value.
        contested: Boolean(working[key] && working[key].value !== profile[key].value),
        // ...and whether it is on the wire regardless. A learned row loses to
        // the task; a declared one does not, which is the visible half of "a
        // declared preference is never silently overridden".
        sent: !(working[key] && working[key].value !== profile[key].value) || profile[key].source === "declared",
      })),
      task: orderKeys(working).map((key) => ({
        key,
        namespace: key.split(".")[0],
        value: working[key].value,
        turn: working[key].turn,
        updatedAt: working[key].updatedAt,
        promotable: Boolean(routeFor(key)?.promotable),
        // How many times this key has been overwritten. A key that quietly
        // rewrites itself every turn is as broken as one that goes stale, and
        // it is the harder of the two to notice — the block always looks
        // plausible, because it always agrees with the newest message.
        rewrites: (working[key].previous ?? []).length,
        previous: [...(working[key].previous ?? [])].reverse(),
      })),
      proposals: proposals.map((p) => ({
        id: p.id,
        key: p.key,
        value: p.value,
        status: p.status,
        kind: p.kind ?? "promotion",
        reason: p.reason ?? null,
        was: p.was ?? null,
      })),
      pastTasks: current.pastTasks
        .filter((task) => (task.turn ?? 0) <= turns)
        .map((task) => ({
          closedAt: task.closedAt,
          turn: task.turn,
          promoted: task.promoted ?? 0,
          entries: task.entries ?? [],
        })),
      discarded: current.discarded
        .filter((row) => (row.turn ?? 0) <= turns)
        .slice(-MAX_DISCARDED)
        .map((row) => ({ key: row.key, reason: row.reason, value: row.value ?? "", turn: row.turn })),
      digest: {
        text: current.digest,
        covers: current.digestThrough,
        updatedAt: current.digestUpdatedAt,
      },
      usage: current.usage,
      attribution: current.attribution.filter((row) => (row.turn ?? 0) <= turns),
      note: Object.keys(profile).length || Object.keys(working).length || current.digest
        ? pending.length
          ? `${pending.length} proposal${pending.length === 1 ? "" : "s"} waiting for you.`
          : ""
        : "Nothing is being carried yet — every block is omitted from the system prompt until it has something in it.",
    };
  }

  // ---- the task boundary ----------------------------------------------------

  /**
   * The "Finish task" button, in one call: propose, clear, keep the record.
   *
   * What it deliberately is **not**: a status field, an `openTask` op, or any
   * attempt to detect that the subject has changed. The user knows when they
   * are done and nothing else reliably does. Pressing the button is the whole
   * signal; the next turn starts a new task implicitly.
   *
   * Clearing is **not** deleting. The closed task moves to `pastTasks` and
   * simply stops being sent, so "what did we decide in the last one?" is still
   * answerable from the panel even though it costs no tokens.
   *
   * @param {{ state: object, history: object[], provider: object, model?: string }} params
   */
  async finishTask({ state, history = [], provider, model }) {
    const turn = exchangeStarts(history).length;
    const current = normaliseState(state);
    const working = entriesAsOf(current.working, turn);
    const keys = orderKeys(working);

    if (!keys.length) {
      return { ok: true, state: current, proposals: [], overhead: { ...NO_OVERHEAD }, note: "nothing in working memory — the task was already clear" };
    }

    const promotable = keys
      .filter((key) => routeFor(key)?.promotable)
      .map((key) => ({ key, value: working[key].value }));

    let proposed = [];
    let overhead = { ...NO_OVERHEAD };

    if (promotable.length) {
      const startedAt = Date.now();
      try {
        const result = await this.#promoterFor(provider).propose({
          entries: promotable,
          // The rest of working memory is the context a value needs to be
          // rephrased into something that stands alone next week.
          context: keys.filter((key) => !routeFor(key)?.promotable).map((key) => `${key}: ${working[key].value}`).join("\n"),
        });
        proposed = result.proposals
          .map((item) => ({ key: routeFor(item.key) ? item.key : promotable[0].key, value: item.value }))
          .slice(0, 12);
        overhead = overheadFrom({ usage: result.usage, model: result.model ?? model, ms: result.ms ?? Date.now() - startedAt });
      } catch (err) {
        // A failed promotion call must not take working memory with it: the
        // user pressed a button, the call fell over, and the honest outcome is
        // that nothing happened and they can press it again.
        console.error("[memory] promotion failed, the task is left open:", err?.message ?? err);
        return {
          ok: false,
          state: current,
          proposals: [],
          overhead: { ...NO_OVERHEAD, overheadMs: Date.now() - startedAt },
          note: "the promotion call failed — nothing was cleared, try again",
        };
      }
    }

    const proposals = proposed.map((item, index) => ({
      id: `p${turn}-${index + 1}-${Math.random().toString(36).slice(2, 7)}`,
      key: item.key,
      value: item.value,
      kind: "promotion",
      status: "pending",
      turn,
      createdAt: new Date().toISOString(),
    }));

    const next = {
      ...current,
      working: {},
      proposals: [...current.proposals, ...proposals],
      pastTasks: [
        ...current.pastTasks,
        {
          closedAt: new Date().toISOString(),
          turn,
          promoted: 0,
          entries: keys.map((key) => ({ key, value: working[key].value })),
        },
      ].slice(-MAX_PAST_TASKS),
      usage: addSpend(current.usage, "overheadWorking", overhead),
    };

    return {
      ok: true,
      state: next,
      proposals,
      overhead,
      note: proposals.length
        ? `task closed · ${keys.length} entries cleared · ${proposals.length} proposal${proposals.length === 1 ? "" : "s"} waiting for you`
        : `task closed · ${keys.length} entries cleared · nothing worth promoting`,
    };
  }

  /**
   * A human answering one proposal. Approval is the only way a promoted
   * decision reaches long-term — **never** auto-approve, or the explicit
   * policy this whole strategy exists to be quietly becomes an implicit one.
   *
   * @param {{ state: object, id: string, action: "approve" | "reject", value?: string, turns?: number }} params
   */
  async answerProposal({ state, id, action, value, turns = 0 }) {
    const current = normaliseState(state);
    const proposal = current.proposals.find((p) => p.id === id);
    if (!proposal) throw new Error("No such proposal.");
    if (proposal.status !== "pending") throw new Error("That proposal has already been answered.");

    if (action === "reject") {
      return {
        state: { ...current, proposals: current.proposals.map((p) => (p.id === id ? { ...p, status: "rejected" } : p)) },
        note: `rejected ${proposal.key}`,
      };
    }
    if (action !== "approve") throw new Error("An answer is either 'approve' or 'reject'.");

    // The edit the user made in the box is the thing that gets stored — this
    // is the moment they are allowed to disagree with the phrasing.
    const text = String(value ?? proposal.value).replace(/\s+/g, " ").trim();
    if (!text) throw new Error("An approved proposal needs a value.");

    const profile = await this.#loadProfile();
    const applied = applyOps(
      { working: current.working, profile },
      [{ op: "promote", key: proposal.key, value: text }],
      // A person is answering, so the write happens even onto a declared key —
      // and the entry keeps whichever provenance it already had. Approving a
      // correction to something you declared does not demote it to `learned`:
      // you are still the one deciding what it says.
      { turn: turns, allow: ["promote"], origin: "person" }
    );
    await this.#saveProfile(applied.profile);

    const promotedAt = { ...current.promotedAt };
    for (const entryId of applied.stamped) promotedAt[entryId] = turns;

    const pastTasks = [...current.pastTasks];
    for (let i = pastTasks.length - 1; i >= 0; i--) {
      if (pastTasks[i].turn === proposal.turn) {
        pastTasks[i] = { ...pastTasks[i], promoted: (pastTasks[i].promoted ?? 0) + 1 };
        break;
      }
    }

    return {
      state: {
        ...current,
        promotedAt,
        pastTasks,
        profileSeen: snapshot(applied.profile),
        proposals: current.proposals.map((p) => (p.id === id ? { ...p, status: "approved", value: text } : p)),
      },
      note: `promoted ${proposal.key} to long-term`,
    };
  }

  /**
   * The panel's own buttons — *forget* and *promote* — through the very same
   * `applyOps` the extractor's patch goes through. One code path to test, and
   * a row in the UI cannot do anything the patch format cannot express.
   *
   * @param {{ state: object, ops: object[], turns?: number }} params
   */
  async applyPanelOps({ state, ops, turns = 0, declared = false }) {
    const current = normaliseState(state);
    const profile = await this.#loadProfile();
    const applied = applyOps({ working: current.working, profile }, ops, {
      turn: turns,
      maxWorking: this.maxWorking,
      // A person pressing a button may do the things a model may not.
      allow: ["set", "delete", "promote"],
      longtermDeletes: true,
      unpairedCloses: true,
      origin: "person",
      // The profile form says so; *forget* and *promote* do not, and leave
      // whatever provenance the row already had alone.
      source: declared ? "declared" : null,
    });

    if (applied.profileTouched) await this.#saveProfile(applied.profile);

    const promotedAt = { ...current.promotedAt };
    for (const entryId of applied.stamped) promotedAt[entryId] = turns;

    return {
      state: {
        ...current,
        working: applied.working,
        promotedAt,
        profileSeen: snapshot(applied.profile),
        proposals: withCorrections(current.proposals, applied.contested, turns),
        discarded: mergeDiscarded(current.discarded, applied.discarded),
      },
      note: describe(applied) || "nothing changed",
    };
  }

  /** Forget the whole profile. The only way anything leaves long-term. */
  async clearProfile() {
    await this.profileStore.clear(this.user);
  }

  // ---- internals ------------------------------------------------------------

  /**
   * Extraction, every user turn, over the last exchange.
   *
   * Total failure is non-fatal — keep what we have, note it, answer the turn —
   * and a single malformed op is discarded on its own while the rest of the
   * patch still applies.
   */
  async #extract({ history, state, profile, provider, model, turn }) {
    const exchange = latestExchange(history);
    const unchanged = { state, profile, profileKeys: [], changed: [], note: "", overhead: { ...NO_OVERHEAD } };
    if (!exchange.length) return { ...unchanged, note: "nothing to extract from" };

    const startedAt = Date.now();
    let result;
    try {
      result = await this.#extractorFor(provider).extract({
        stored: [
          ...orderKeys(state.working).map((key) => ({ key, value: state.working[key].value })),
          ...orderKeys(profile.entries).map((key) => ({ key, value: profile.entries[key].value })),
        ],
        exchange,
      });
    } catch (err) {
      console.error("[memory] extraction failed, keeping what is stored:", err?.message ?? err);
      return {
        ...unchanged,
        note: "extraction failed — memory kept as it was",
        overhead: { ...NO_OVERHEAD, overheadMs: Date.now() - startedAt },
      };
    }

    const applied = applyOps({ working: state.working, profile }, result.ops, {
      turn,
      maxWorking: this.maxWorking,
      // The model proposes a key and a value. It may not promote, and it may
      // not say which layer anything belongs in.
      allow: ["set", "delete"],
      // The patch came from a model, which is what makes a declared entry
      // untouchable by it.
      origin: "model",
    });

    const profileKeys = [...applied.set, ...applied.deleted, ...applied.promoted].filter(
      (key) => routeFor(key)?.layer === "longterm"
    );
    if (applied.profileTouched) await this.#saveProfile(applied.profile);

    const overhead = overheadFrom({
      usage: result.usage,
      model: result.model ?? model,
      ms: result.ms ?? Date.now() - startedAt,
    });

    return {
      state: {
        ...state,
        working: applied.working,
        // A long-term entry the task has just contradicted is not rewritten
        // here. Long-term writes are human-approved, so the contradiction
        // becomes a proposal like any other — and until it is answered, the
        // payload simply stops asserting the stale half (see buildPayload).
        proposals: withCorrections(state.proposals, applied.contested, turn),
        discarded: mergeDiscarded(state.discarded, applied.discarded),
        usage: addSpend(state.usage, "overheadWorking", overhead),
      },
      profile: applied.profile,
      profileKeys,
      changed: applied.changed,
      note: describe(applied),
      overhead,
    };
  }

  /**
   * The fold, at the high-water mark, through the existing `Summarizer`.
   *
   * Identical in shape to the summarization strategy's, and deliberately so:
   * the digest here is the same object doing the same job, and a second
   * implementation of it would be a second thing to keep correct.
   */
  async #fold({ history, state, provider, model }) {
    const held = exchangeStarts(history, state.digestThrough).length;
    const mark = Math.max(2, Math.floor(this.contextMessages));
    if (held < mark) return { state, note: "", overhead: { ...NO_OVERHEAD } };

    const boundary = foldTo(history, state.digestThrough, this.fold);
    if (boundary <= state.digestThrough) return { state, note: "", overhead: { ...NO_OVERHEAD } };

    const from = state.digestThrough;
    const foldedExchanges = held - exchangeStarts(history, boundary).length;
    const slice = toWire(history.slice(from, boundary));

    const startedAt = Date.now();
    try {
      const result = await this.#summarizerFor(provider).summarize({
        previousSummary: state.digest,
        messages: slice,
      });
      const overhead = overheadFrom({
        usage: result.usage,
        model: result.model ?? model,
        ms: result.ms ?? Date.now() - startedAt,
      });

      return {
        state: {
          ...state,
          digest: result.text,
          digestThrough: boundary,
          digestUpdatedAt: new Date().toISOString(),
          usage: addSpend(state.usage, "overheadSummary", overhead),
        },
        note: `folded ${foldedExchanges} exchange${foldedExchanges === 1 ? "" : "s"} into the digest`,
        overhead,
      };
    } catch (err) {
      // Keep the digest, leave the edge where it was: the exchanges that
      // failed to fold are still verbatim, so nothing was lost and the fold is
      // simply retried next turn.
      console.error("[memory] the fold failed, keeping the previous digest:", err?.message ?? err);
      return {
        state,
        note: "the fold failed — retried next turn",
        overhead: { ...NO_OVERHEAD, overheadMs: Date.now() - startedAt },
      };
    }
  }

  async #loadProfile() {
    try {
      return await this.profileStore.load(this.user);
    } catch (err) {
      // An unreadable profile is a conversation with no long-term memory, not
      // a failed turn.
      console.error("[memory] could not read the profile:", err?.message ?? err);
      return { user: this.user, updatedAt: null, nextId: 1, entries: {} };
    }
  }

  async #saveProfile(profile) {
    try {
      await this.profileStore.save(this.user, profile);
    } catch (err) {
      console.error("[memory] could not write the profile:", err?.message ?? err);
    }
  }

  #extractorFor(provider) {
    if (this.#extractor && this.#cachedFor === null) return this.#extractor;
    this.#rebuild(provider);
    return this.#extractor;
  }

  #promoterFor(provider) {
    if (this.#promoter && this.#cachedFor === null) return this.#promoter;
    this.#rebuild(provider);
    return this.#promoter;
  }

  #summarizerFor(provider) {
    if (this.#summarizer && this.#cachedFor === null) return this.#summarizer;
    this.#rebuild(provider);
    return this.#summarizer;
  }

  /** The three helpers all speak to the conversation's provider by default. */
  #rebuild(provider) {
    if (this.#cachedFor === provider) return;
    this.#extractor = new MemoryExtractor({ provider, model: this.model, maxTokens: this.maxTokens });
    this.#promoter = new Promoter({ provider, model: this.model });
    this.#summarizer = new Summarizer({ provider, model: this.model });
    this.#cachedFor = provider;
  }
}

// ---- helpers ----------------------------------------------------------------

/** Both overheads of one turn, added up for the Agent's single bill. */
function combine(a, b) {
  return {
    overheadTokens: (a?.overheadTokens ?? 0) + (b?.overheadTokens ?? 0),
    overheadCost: a?.overheadCost == null && b?.overheadCost == null ? null : (a?.overheadCost ?? 0) + (b?.overheadCost ?? 0),
    overheadMs: (a?.overheadMs ?? 0) + (b?.overheadMs ?? 0),
    overheadCalls: (a?.overheadCalls ?? 0) + (b?.overheadCalls ?? 0),
    usage: {
      inputTokens: (a?.usage?.inputTokens ?? 0) + (b?.usage?.inputTokens ?? 0),
      outputTokens: (a?.usage?.outputTokens ?? 0) + (b?.usage?.outputTokens ?? 0),
    },
  };
}

/**
 * The two schedules, billed apart.
 *
 * The Agent adds every strategy call to one overhead figure, which is the
 * right number for comparing strategies against each other and the wrong one
 * for tuning this one: extraction runs every turn and the fold runs every
 * `window / 2` turns, and knowing which of the two is actually costing you is
 * the difference between widening the window and narrowing it.
 */
function emptySpend() {
  return {
    overheadWorking: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    overheadSummary: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    // The third figure is not a call. It is the `<profile>` block riding in
    // the input of the turn's own request, every turn, and it is `estimated`
    // rather than measured — see `addProfileSpend`.
    overheadProfile: { calls: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: true },
  };
}

/**
 * Four characters to a token.
 *
 * Crude, and knowingly so. The alternative is a `count_tokens` round trip per
 * turn spent on a number nobody acts on to four significant figures, and the
 * figure this feeds is labelled `estimated` wherever it is shown. What it has
 * to be is *consistent*: two profiles compared against each other are measured
 * by the same ruler, however approximate the ruler is.
 */
function estimateBlockTokens(text) {
  const length = String(text ?? "").trim().length;
  return length ? Math.ceil(length / 4) : 0;
}

/**
 * The profile block's share of this turn's input, added to the running total.
 *
 * `turns` rather than `calls`: nothing was called. A bucket claiming calls it
 * never made would be added to the strategy's call count by any code that
 * treats the three buckets alike, and then the overhead figure would be
 * counting a block as a request.
 */
function addProfileSpend(usage, block, model) {
  const inputTokens = estimateBlockTokens(block);
  const base = usage?.overheadProfile ?? emptySpend().overheadProfile;
  if (!inputTokens) return { ...emptySpend(), ...usage, overheadProfile: { ...base, turns: base.turns + 1 } };

  const cost = estimateCost({ model, inputTokens, outputTokens: 0 });
  return {
    ...emptySpend(),
    ...usage,
    overheadProfile: {
      ...base,
      turns: base.turns + 1,
      inputTokens: base.inputTokens + inputTokens,
      costUsd: base.costUsd + (cost.inputCost ?? 0),
    },
  };
}

function addSpend(usage, bucket, overhead) {
  const base = usage?.[bucket] ?? { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  return {
    ...emptySpend(),
    ...usage,
    [bucket]: {
      calls: base.calls + (overhead?.overheadCalls ?? 0),
      inputTokens: base.inputTokens + (overhead?.usage?.inputTokens ?? 0),
      outputTokens: base.outputTokens + (overhead?.usage?.outputTokens ?? 0),
      costUsd: base.costUsd + (overhead?.overheadCost ?? 0),
    },
  };
}

/**
 * The same refusal, said once.
 *
 * A model that keeps proposing the same unroutable key — and they do, because
 * nothing tells the model its last proposal went nowhere — would otherwise
 * fill the panel with identical lines until the real ones scrolled off.
 */
function mergeDiscarded(existing, incoming) {
  if (!incoming.length) return existing;
  const seen = new Set(incoming.map((row) => `${row.key}\u0000${row.reason}`));
  return [...existing.filter((row) => !seen.has(`${row.key}\u0000${row.reason}`)), ...incoming].slice(
    -MAX_DISCARDED
  );
}

/**
 * Turn a contradiction into a proposal, once.
 *
 * Re-offering a correction the user has already answered would nag on every
 * remaining turn of the conversation, so a key is only offered again when the
 * task says something new about it.
 */
function withCorrections(proposals, contested, turn) {
  if (!contested?.length) return proposals;
  const next = [...proposals];

  for (const row of contested) {
    if (next.some((proposal) => proposal.key === row.key && proposal.value === row.value)) continue;
    next.push({
      id: `c${turn}-${next.length + 1}-${Math.random().toString(36).slice(2, 7)}`,
      key: row.key,
      value: row.value,
      was: row.was,
      kind: "correction",
      // Which disagreement this is, so the panel can say the right sentence:
      // a `task` correction is long-term going stale against the work in hand,
      // a `declared` one is the conversation arguing with something the user
      // wrote down on purpose. The second deserves more deference than the
      // first, and neither is resolved without them.
      reason: row.reason ?? "task",
      status: "pending",
      turn,
      createdAt: new Date().toISOString(),
    });
  }

  return next;
}

/** One human line for the per-turn counter. */
function describe({ set, deleted, promoted, discarded, contested = [] }) {
  const parts = [];
  if (set.length) parts.push(`${set.length} key${set.length === 1 ? "" : "s"} set`);
  if (deleted.length) parts.push(`${deleted.length} forgotten`);
  if (promoted.length) parts.push(`${promoted.length} promoted`);
  // A refused write onto a declared entry is not nothing happening, and it is
  // not a malformed op either. Left out of this line it reads as a turn where
  // the extractor found nothing.
  const declared = contested.filter((row) => row.reason === "declared").length;
  if (declared) parts.push(`${declared} held back by what you declared`);
  const unknown = discarded.filter((row) => row.reason === "unknown namespace");
  if (unknown.length) parts.push(`${unknown.length} proposed, not stored`);
  else if (discarded.length) parts.push(`${discarded.length} malformed op${discarded.length === 1 ? "" : "s"} discarded`);
  return parts.length ? parts.join(", ") : "nothing new established";
}

/**
 * The newest user message, with the reply before it for context. Two messages
 * is enough for "yes, do that" to mean something, and small enough that the
 * extraction call stays a rounding error next to the turn it precedes.
 */
function latestExchange(history) {
  const messages = history ?? [];
  const last = messages.length - 1;
  if (last < 0) return [];
  const from = last > 0 && messages[last - 1].role === "assistant" ? last - 1 : last;
  return messages.slice(from).map(({ role, content }) => ({ role, content }));
}

function extractionPrompt(stored, exchange) {
  return [
    "ALREADY STORED — current values. Do not restate any of these unchanged:",
    stored.length ? stored.map((entry) => `${entry.key}: ${entry.value}`).join("\n") : "(nothing yet)",
    "",
    "LATEST EXCHANGE:",
    ...exchange.map((m) => `[${m.role}] ${m.content}`),
    "",
    "Return the operations.",
  ].join("\n");
}

function promotionPrompt(entries, context) {
  return [
    "PROMOTION CANDIDATES:",
    ...entries.map((entry) => `${entry.key}: ${entry.value}`),
    "",
    "THE TASK THEY CAME FROM:",
    context || "(nothing else was recorded)",
    "",
    "Return the proposals.",
  ].join("\n");
}

/**
 * Pull the JSON array out of whatever came back. A model that ignored "no code
 * fences" or prefixed a sentence has still done the work, and throwing that
 * away would cost a turn its memory for a formatting slip.
 */
function parseJsonArray(raw) {
  const text = String(raw ?? "").replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Entries as they stood after `turns` exchanges — the `factsAsOf` rule, which
 * this strategy applies to working memory *and* to long-term.
 *
 * A leak here is the expensive kind. A branch shown something its parent
 * promoted after the fork does not look like a storage bug from the outside:
 * it looks like the model making things up.
 */
export function entriesAsOf(entries, turns) {
  if (!Number.isFinite(turns)) return entries ?? {};
  const kept = {};
  for (const [key, entry] of Object.entries(entries ?? {})) {
    if ((entry.turn ?? 0) <= turns) kept[key] = entry;
  }
  return kept;
}

/**
 * The long-term entries a branch is allowed to see.
 *
 * Entries this branch's lineage promoted carry a turn stamp in `promotedAt`
 * and are hidden until the branch itself has got that far. Entries written by
 * some other conversation carry no stamp here at all and are always visible —
 * which is the entire point of the layer.
 *
 * @param {{ entries: Record<string, object> }} profile
 * @param {Record<string, number>} promotedAt
 * @param {number} turns
 */
export function visibleProfile(profile, promotedAt = {}, turns = Infinity) {
  const kept = {};
  for (const [key, entry] of Object.entries(profile?.entries ?? {})) {
    const stamp = promotedAt?.[entry.id];
    if (Number.isFinite(turns) && Number.isInteger(stamp) && stamp > turns) continue;
    kept[key] = entry;
  }
  return kept;
}

/** What the panel shows when it cannot read the profile store: last turn's copy. */
function snapshot(profile) {
  const entries = {};
  for (const [key, entry] of Object.entries(profile?.entries ?? {})) {
    // `source` rides along so the panel can say which rows the user wrote and
    // which the extractor put there on its own. Long-term never expires, so
    // "who decided this about me?" is a question worth being able to answer
    // months later — and it is the field that decides whether a model is
    // allowed to overwrite the row at all.
    entries[key] = {
      id: entry.id,
      key,
      value: entry.value,
      updatedAt: entry.updatedAt,
      source: entry.source === "declared" ? "declared" : "learned",
    };
  }
  return entries;
}

/** Namespace order first, then alphabetical — so a block reads goal-first. */
function orderKeys(entries) {
  return Object.keys(entries ?? {}).sort((a, b) => {
    const rank = NAMESPACES.indexOf(a.split(".")[0]) - NAMESPACES.indexOf(b.split(".")[0]);
    return rank !== 0 ? rank : a.localeCompare(b);
  });
}

/** Whatever came off disk, coerced into a state this strategy can work with. */
export function normaliseState(state) {
  const empty = {
    working: {},
    digest: null,
    digestThrough: 0,
    digestUpdatedAt: null,
    pastTasks: [],
    proposals: [],
    discarded: [],
    promotedAt: {},
    profileSeen: {},
    profileUser: null,
    attribution: [],
    usage: emptySpend(),
  };

  const source = state && typeof state === "object" ? state : {};
  const working = {};
  for (const [key, entry] of Object.entries(source.working ?? {})) {
    const value = String(entry?.value ?? "").trim();
    if (!KEY_PATTERN.test(key) || !value) continue;
    working[key] = {
      value,
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
      turn: Number.isInteger(entry.turn) ? entry.turn : 0,
      previous: Array.isArray(entry.previous) ? entry.previous.filter((v) => typeof v === "string").slice(-HISTORY_DEPTH) : [],
    };
  }

  const profileSeen = {};
  for (const [key, entry] of Object.entries(source.profileSeen ?? {})) {
    const value = String(entry?.value ?? "").trim();
    if (!KEY_PATTERN.test(key) || !value) continue;
    profileSeen[key] = {
      id: typeof entry.id === "string" ? entry.id : key,
      key,
      value,
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
      source: entry.source === "declared" ? "declared" : "learned",
    };
  }

  const promotedAt = {};
  for (const [id, turn] of Object.entries(source.promotedAt ?? {})) {
    if (Number.isInteger(turn)) promotedAt[id] = turn;
  }

  return {
    ...empty,
    ...source,
    working,
    profileSeen,
    promotedAt,
    profileUser: typeof source.profileUser === "string" ? source.profileUser : null,
    digest: typeof source.digest === "string" && source.digest.trim() ? source.digest : null,
    digestThrough: Number.isInteger(source.digestThrough) ? source.digestThrough : 0,
    digestUpdatedAt: typeof source.digestUpdatedAt === "string" ? source.digestUpdatedAt : null,
    pastTasks: Array.isArray(source.pastTasks) ? source.pastTasks : [],
    proposals: Array.isArray(source.proposals) ? source.proposals : [],
    discarded: Array.isArray(source.discarded) ? source.discarded : [],
    attribution: Array.isArray(source.attribution) ? source.attribution : [],
    usage: { ...emptySpend(), ...(source.usage ?? {}) },
  };
}
