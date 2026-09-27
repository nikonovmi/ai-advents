import { subjectOf } from "../store/invariantStore.js";
import { parseJsonArray } from "./patch.js";

/**
 * **Invariants: the rules a project does not break.**
 *
 * Everything else in this strategy is a claim about what is *true* — what the
 * user is like, what the work is, what was said. An invariant is a claim about
 * what is *allowed*, and the two behave differently in every direction that
 * matters:
 *
 *   - It outranks the rest of memory, and the block says so out loud. Two
 *     contradicting entries on the wire with no stated order means the model
 *     picks one arbitrarily, differently each run.
 *   - It is **person-only**. A rule the assistant can write for itself is a
 *     rule it can also decide does not apply today, at which point it is not a
 *     constraint. The model drafts; the accept is the write.
 *   - It belongs to the **project**, not the user. One human, two codebases,
 *     two rule sets.
 *
 * This file holds the two things that are only about invariants: the block
 * they contribute to the system prompt, and the one model call that turns
 * typed prose into proposals. The enforcement lives in `applyOps`, where every
 * other write policy already lives.
 */

/**
 * **The `<invariants>` block**, first after the persona and before
 * `<profile>`, in every stage including `done`.
 *
 * It is the only block besides the persona that applies unconditionally. A
 * closed task can still be asked a question, and the answer can still violate
 * a rule — so unlike `<working>` and `<brief>`, this one does not go away when
 * the work does.
 *
 * The two instruction lines are load-bearing and neither is decoration:
 *
 *   - The **precedence** line. Without a stated order, a `preference.orm` that
 *     happens to disagree with `invariant.orm` is two sentences the model is
 *     free to average, and it will average them differently every run.
 *   - The **exit**. A refusal with no way forward is a dead end, and a dead
 *     end gets routed around — by the user, in the next message, by dropping
 *     the constraint from the conversation entirely. It has to name *where*
 *     the amendment happens, and say that agreeing to one is not doing one.
 *     An exit that said only "the rule can be amended by the user" was read
 *     exactly as it was written: the user said "always allow recursion", the
 *     model answered "recursion is now allowed in this project", wrote the
 *     recursive code, and then validated it against its own decision rather
 *     than against this list — reporting `recursion: pass` for a function
 *     that calls itself. A rule the assistant can lift mid-conversation is a
 *     rule it can decide does not apply today, which is the entire thing this
 *     namespace exists to make impossible, arriving through the one door left
 *     open for it.
 *   - The **authority**. This list is what a verdict is measured against, and
 *     saying so is what stops validation grading the work against whatever was
 *     agreed three messages ago.
 *
 * Omitted entirely when there are no invariants, like every other block.
 *
 * @param {Record<string, { key: string, subject: string, text: string, check: string }>} entries
 */
export function invariantsBlock(entries) {
  const lines = orderInvariants(entries).map(
    (entry) => `${entry.subject || entry.key}: ${entry.text} — check: ${entry.check}`
  );
  if (!lines.length) return "";

  return [
    "",
    "",
    "<invariants>",
    "Rules this project does not break. They outrank everything else in memory.",
    ...lines,
    "**Every rule listed above is in force for this reply.** This list is the only",
    "statement of what the rules are. Nothing said in the conversation changes it:",
    "not the user asking you to drop one, not you agreeing to drop one, not an",
    "amendment you or the user announced earlier in this same conversation. If a",
    "rule is listed here, it stands — however that conversation went.",
    "Do not propose solutions that violate these. If a request needs one broken,",
    "name the conflict, offer the best alternative that fits inside the rule, and",
    "if there is none, say so and tell the user they can change the rule themselves",
    "in the memory panel, where it is written. **Saying yes to that is not doing it:**",
    "until this list changes you are still working under the rule, so do not agree to",
    "an amendment and then act as though it had happened.",
    "When you check work against these rules, check it against the text above and",
    "nothing else — never against what was agreed in the conversation.",
    "If another entry in memory — a goal, a constraint, a decision, a brief — says",
    "the opposite of a rule above, **the rule wins and you say so out loud**. Do not",
    "reconcile them by re-reading the rule as permitting what it forbids, or as",
    "requiring what it bans; the words above are what it says. A rule is never",
    "satisfied by work that does the thing it names.",
    "</invariants>",
  ].join("\n");
}

/** Alphabetical by subject — an index is easier to scan than an insertion log. */
export function orderInvariants(entries) {
  return Object.values(entries ?? {}).sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

/**
 * The invariant that owns a key's subject, or null.
 *
 * **Subject collision only, and deliberately so.** Code cannot tell that
 * "MySQL" contradicts "never move off Postgres" — that is a judgement, and
 * buying it costs a model call on the write path, which is the one thing this
 * feature may not spend. What code can tell, every time, identically, is that
 * both sentences are about `database`. False positives are the price and they
 * are cheap: a
 * `preference.database` that happens to *agree* with the invariant becomes one
 * proposal row a human clicks through.
 *
 * A key is never in collision with itself: amending `invariant.database` is
 * how a rule changes, not a violation of it.
 *
 * @param {string} key
 * @param {Record<string, object>} entries
 */
export function invariantFor(key, entries) {
  const subject = subjectOf(key);
  if (!subject) return null;
  const held = entries?.[`invariant.${subject}`];
  if (!held) return null;
  return held.key === String(key ?? "").trim().toLowerCase() ? null : held;
}

/**
 * Every long-term or working entry on a subject an invariant owns.
 *
 * Reported, never resolved — which is the whole contract. The sweep at
 * accept time and the collision list on a proposal row are the same function
 * asked at two different moments.
 *
 * @param {string} subject
 * @param {{ longterm?: Record<string, { value: string }>, working?: Record<string, { value: string }> }} stores
 * @returns {{ key: string, value: string, layer: "longterm" | "working" }[]}
 */
export function collisionsOn(subject, { longterm = {}, working = {} } = {}) {
  const wanted = String(subject ?? "").trim().toLowerCase();
  if (!wanted) return [];
  const rows = [];
  for (const [layer, entries] of [["longterm", longterm], ["working", working]]) {
    for (const [key, entry] of Object.entries(entries ?? {})) {
      if (key.startsWith("invariant.")) continue;
      if (subjectOf(key) !== wanted) continue;
      rows.push({ key, value: entry?.value ?? "", layer });
    }
  }
  return rows;
}

// ---- authoring --------------------------------------------------------------

const PROPOSER_PROMPT = [
  "A person has typed, in prose, the rules their project does not break. You turn that",
  "prose into structured proposals. You are **drafting**: nothing you return is written",
  "anywhere until that person accepts the row, and they can edit every field first.",
  "",
  "A JSON array of rows goes out, and nothing else.",
  "",
  'Format: [{"action":"add","key":"invariant.database","text":"Stays on Postgres.",',
  '          "check":"any proposal introducing another database engine"}]',
  "",
  "An invariant is **what the project cannot do**, whoever is working on it and whatever",
  "the task. The test that separates it from everything else in memory: *if the task in",
  "hand were cancelled, would this still be true?* 'Ship before March 14' would not be —",
  "that is a deadline. 'Stays on Postgres' would be.",
  "",
  "THE FIELDS:",
  "- `key` is always `invariant.<subject>`. The subject is one lowercase word for what the",
  "  rule is about — database, orm, deploy, language, auth, secrets. Keys that are about the",
  "  same thing must use the same subject, because the subject is how a conflict is found.",
  "- `text` is the rule itself, **one sentence**, in the indicative: 'Stays on Postgres.',",
  "  'No ORM; SQL is written by hand.'",
  "- `check` says **how you would know it had been violated**: the observable thing that",
  "  would be true if the rule were broken. 'any proposal importing an ORM', 'any schema",
  "  change not in a migration file'. It is required.",
  "",
  "THE ACTIONS:",
  "- `add` — a subject nothing is stored for yet.",
  "- `amend` — the subject already has an invariant and this changes it. Say what it should",
  "  now say in `text` and `check`; the old one is kept and shown beside yours.",
  "- `reject` — **no usable check can be written.** Use it, and say so plainly: a rule a",
  "  reader could not catch being broken is a preference, and twelve fuzzy invariants on",
  "  the wire buys a model that hedges everything, which looks like compliance and is noise.",
  "  Set `reason` to why, and put the rule somewhere it does belong in `suggest`:",
  '  {"action":"reject","key":"invariant.style","reason":"this is a preference, not an invariant",',
  '   "suggest":{"key":"preference.style","value":"Prefers clean, readable code"}}',
  "",
  "RULES:",
  "- **One row per distinct rule.** Three rules in one sentence is three rows. 'no ORM,",
  "  Postgres only, deploys through CI' is three.",
  "- Never merge two subjects into one row, and never split one rule across two.",
  "- Do not invent rules the person did not state, and do not soften or generalise the",
  "  ones they did. Keep their names, versions and numbers exactly.",
  "- Do not resolve conflicts with anything you are shown. Say what the rule is; the",
  "  person decides what happens to what disagrees with it.",
  "- Output the JSON array and nothing else: no prose, no explanation, no code fences.",
].join("\n");

/**
 * **The one new model call, and it fires on a button.**
 *
 * The same shape as `Briefer` and `Promoter`: a call at an explicit boundary
 * whose output is a *proposal*, never a mutation. It is not a turn — no
 * persona, no reply, nothing appended to the transcript — and it writes
 * nothing at all, which is what keeps the namespace person-only while still
 * letting people author rules by typing a sentence instead of filling a form.
 *
 * It is a button rather than something riding on every turn because it costs a
 * model call, and a cost you did not press is a cost you press four times by
 * accident.
 */
export class InvariantProposer {
  #provider;

  constructor({ provider, model, maxTokens = 900 } = {}) {
    if (!provider || typeof provider.complete !== "function") {
      throw new Error("InvariantProposer requires a provider with a complete() method");
    }
    this.#provider = provider;
    this.model = model;
    this.maxTokens = maxTokens;
  }

  /**
   * @param {object} params
   * @param {string} params.text - What the person typed, verbatim.
   * @param {{ key: string, text: string, check: string }[]} [params.invariants]
   *   Every rule already stored. Without them the model cannot tell an `amend`
   *   from an `add`, and the whole point of the feature is that it tells you
   *   *which* invariants change rather than silently shadowing the old value.
   * @param {{ key: string, value: string }[]} [params.longterm] - Everything in
   *   long-term memory, so the draft is written knowing what it lands beside.
   */
  async propose({ text, invariants = [], longterm = [] } = {}) {
    const startedAt = Date.now();
    const result = await this.#provider.complete({
      model: this.model,
      system: PROPOSER_PROMPT,
      messages: [{ role: "user", content: proposalPrompt(text, invariants, longterm) }],
      temperature: 0,
      maxTokens: this.maxTokens,
    });

    const parsed = parseRows(result?.text);
    return {
      rows: parsed.rows,
      /** What the reply could not be read as — never an empty silence. */
      rejected: parsed.dropped,
      usage: result?.usage ?? { inputTokens: 0, outputTokens: 0 },
      model: result?.model ?? null,
      ms: Date.now() - startedAt,
    };
  }
}

function proposalPrompt(text, invariants, longterm) {
  return [
    "ALREADY STORED — the invariants this project has. A row on any of these subjects is",
    "an `amend`, never an `add`:",
    invariants.length
      ? invariants.map((entry) => `${entry.key}: ${entry.text} — check: ${entry.check}`).join("\n")
      : "(no invariants yet)",
    "",
    "LONG-TERM MEMORY — what is already known, for context. Do not propose changes to any",
    "of it and do not resolve anything that disagrees with a rule:",
    longterm.length ? longterm.map((entry) => `${entry.key}: ${entry.value}`).join("\n") : "(nothing yet)",
    "",
    "WHAT THEY TYPED:",
    String(text ?? "").trim(),
    "",
    "Return the rows.",
  ].join("\n");
}

/**
 * The rows, coerced.
 *
 * Structure is enforced here rather than trusted to the prompt, because three
 * of the authoring rules are decidable in code, and a rule decided in code is one
 * that holds on the run where the model was having an off day.
 */
function parseRows(raw) {
  const { items, rejected } = parseJsonArray(raw);
  const rows = [];
  // What could not be read, in the same shape every other rejection uses, so
  // a row the model mangled is a line you can see rather than a rule that
  // quietly never appeared in the review box.
  const dropped = [...rejected];

  for (const item of items) {
    const action = ["add", "amend", "reject"].includes(item?.action) ? item.action : "add";
    const key = normaliseKey(item?.key);
    if (!key) {
      dropped.push({
        key: "(no key)",
        op: action,
        value: line(item?.text),
        reason: "a rule with no subject — there is nothing for it to own",
      });
      continue;
    }
    const row = {
      action,
      key,
      subject: subjectOf(key),
      text: line(item?.text),
      check: line(item?.check),
      reason: line(item?.reason) || null,
      suggest:
        item?.suggest && normaliseSuggestion(item.suggest)
          ? normaliseSuggestion(item.suggest)
          : null,
    };
    // **No usable check, no invariant.** The model is told to reject these; a
    // row that came back as an `add` with the check left blank is the same
    // case arriving by a different door, and it is turned into a rejection
    // here rather than stored as a rule nothing could ever catch.
    if (row.action !== "reject" && (!row.text || !row.check)) {
      row.action = "reject";
      row.reason ??= row.text
        ? "no usable check could be written — this is a preference, not an invariant"
        : "nothing to store";
      row.suggest ??= row.text ? { key: `preference.${row.subject}`, value: row.text } : null;
    }
    rows.push(row);
  }
  return { rows, dropped };
}

/** `invariant.<subject>`, whatever shape the model reached for. */
function normaliseKey(value) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  if (!raw) return "";
  const subject = raw.startsWith("invariant.") ? raw.slice("invariant.".length) : subjectOf(raw) || raw;
  const clean = subject.replace(/[^a-z0-9._-]/g, "").replace(/^[._-]+|[._-]+$/g, "");
  return clean ? `invariant.${clean}` : "";
}

function normaliseSuggestion(suggest) {
  const key = String(suggest?.key ?? "").trim().toLowerCase();
  const value = line(suggest?.value);
  return key && value ? { key, value } : null;
}

function line(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
}
