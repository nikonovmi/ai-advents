/**
 * **The patch format: one place, one vocabulary, one rule about failure.**
 *
 * A model returns a patch as JSON, and the part it gets wrong is never the
 * content — it is the envelope. The key in the `op` field. The verb missing.
 * A verb it invented. A JSON array wrapped in prose. Each of those used to be
 * handled somewhere else, in its own way, and each of them **threw a turn's
 * memory away in silence** — which is how the same bug arrived three times
 * wearing three different panel rows, every one of them useless.
 *
 * So the whole format lives here: the key grammar, the routing table, the op
 * vocabulary, the coercion, and the split into the two mutation paths. One
 * module to read when you want to know what a patch may say, and one place to
 * change when the answer moves.
 *
 * **The rule that makes it hold** is not the coercion — coercion always runs
 * out — it is this:
 *
 *   > Every item in a patch either **lands** or is **reported, with a reason**.
 *   > There is no third outcome.
 *
 * Nothing here returns a shorter array and leaves it at that. Reading a patch
 * hands back what could be used *and* what could not, and the caller is
 * expected to carry the second list somewhere a person can see it. That is
 * what makes a formatting slip a line in the panel instead of a fact that
 * quietly never existed — and what turns "it's still broken" into a sentence
 * naming the field that was wrong.
 */

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
 *   - `personOnly` — **no model op may ever write it**, at any point in the
 *                    conversation, including the `promotable` path that runs
 *                    at the task boundary. Exactly one namespace has it, and
 *                    the reason is in `invariants.js`: a rule the assistant
 *                    can write for itself is a rule it can also decide does
 *                    not apply today, at which point it is not a constraint.
 *   - `project`    — keyed by the codebase rather than by the human, and so
 *                    held in a store of its own. One person, two repositories,
 *                    two sets of rules.
 *
 * **`rule` versus `invariant`.** They were one namespace away from being the
 * same thing, which is the worst place for two things to be: the extractor
 * would route into `rule` and nobody would know which of the two they had
 * meant. So the line is drawn and written down here —
 *
 *   - `rule` is **how this user likes to be worked with**, stated absolutely.
 *     "Never use em-dashes", "always show the SQL". It is about the assistant,
 *     it follows the person between projects, and the extractor may write it
 *     because getting it wrong costs a sentence of tone.
 *   - `invariant` is **what the project cannot do**. "Stays on Postgres", "no
 *     ORM". It is about the codebase, it stays behind when the person moves
 *     on, and only a person may write it because getting it wrong costs the
 *     architecture.
 *
 * The test that separates them is the one in the README: *if this task were
 * cancelled, would it still be true?* "Ship before March 14" would not be —
 * that is a `constraint`. "Stays on Postgres" would.
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
  invariant: { layer: "longterm", evict: "never", personOnly: true, project: true },
};

/** The namespaces, in the order a block lists them. */
export const NAMESPACES = Object.keys(ROUTES);

/**
 * The namespaces a *model* may propose a key in.
 *
 * `invariant` is missing, and that absence is the prompt half of the
 * person-only policy. It is a filter and not a gate — `applyOps` is what
 * actually refuses the write — but a namespace the extractor is never told
 * about is a namespace it almost never reaches for, and the cheapest refusal
 * is the one that never has to happen.
 */
export const PROPOSABLE = NAMESPACES.filter((namespace) => !ROUTES[namespace].personOnly);

/** `constraint.database`, `preference.tooling`, or a bare `goal`. */
export const KEY_PATTERN = new RegExp(`^(${NAMESPACES.join("|")})(\\.[a-z0-9][a-z0-9_-]*){0,2}$`);

/** The three verbs that change memory. Anything else in an `op` is a mistake. */
export const MEMORY_OPS = new Set(["set", "delete", "promote"]);

/**
 * The four ops that describe the *task* rather than memory.
 *
 * They travel in the same patch because they come out of one call — paying for
 * a second round trip to ask "and what stage are we in?" would be absurd — and
 * they are separated before either mutation path sees the other's ops, so
 * `applyOps` goes on refusing everything that is not a routable key and
 * `transition` goes on being the only way a stage changes.
 */
/**
 * `awaiting` is still routed here although nothing applies it any more: the op
 * was removed, and `applyTaskOps` refuses it with the reason. Dropping it from
 * this set instead would send it to `applyOps`, which would refuse it as an
 * unroutable *key* — a true sentence about the wrong thing.
 */
export const TASK_OPS = new Set(["step", "awaiting", "stage", "refused"]);

/** How much of a rejected value is worth quoting back in the panel. */
const MAX_VALUE_LENGTH = 240;

/**
 * What a key resolves to, or null when nothing does.
 *
 * Exported because this is the function the routing test drives: every
 * namespace resolves to exactly one layer, and an unknown one resolves to
 * nothing at all rather than to a guess.
 *
 * @param {string} key
 * @returns {{ namespace: string, layer: "working" | "longterm", evict: string, promotable: boolean, personOnly: boolean, project: boolean, singular: boolean, bare: boolean } | null}
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
    // No model op writes this, ever — not a `set`, not a `delete`, and not a
    // `promote` a human clicked, because the sentence being promoted was still
    // drafted by a model. See `applyOps`.
    personOnly: Boolean(route.personOnly),
    // Held in the project's own store rather than in the user's profile.
    project: Boolean(route.project),
    bare: text === namespace,
  };
}

/**
 * **What an op actually says, whatever shape it arrived in.**
 *
 * Two rules, and neither of them can invent anything:
 *
 *   - **A key in the verb's place is a `set`.** `{"op":"open.region","value":…}`
 *     has no key and an `op` that parses as one. Only with a value, so nothing
 *     is conjured out of an empty op.
 *   - **A routable key with a value and no verb anyone knows is a `set`.**
 *     `{"key":"open.region","value":…}`, `{"op":"add",…}`, `{"op":"record",…}`
 *     — there is nothing else they could mean. `delete` and `promote` are
 *     explicit and carry no value, so neither is reachable by accident.
 *
 * A verb that *is* known stays exactly what it says, so `promote` from a model
 * is still refused rather than quietly rewritten into something allowed. This
 * is the same forgiveness `parseJsonArray` gives the response as a whole, at
 * the level below it: a model that ignored the format has still done the work.
 */
export function coerceOp(raw) {
  const key = typeof raw?.key === "string" ? raw.key.trim().toLowerCase() : "";
  const action = typeof raw?.op === "string" ? raw.op.trim().toLowerCase() : "";
  const hasValue = Boolean(String(raw?.value ?? raw?.text ?? "").trim());

  if (MEMORY_OPS.has(action) || TASK_OPS.has(action)) return { key, action };
  if (!key && action && routeFor(action) && hasValue) return { key: action, action: "set" };
  if (key && routeFor(key) && hasValue) return { key, action: "set" };
  return { key, action };
}

/**
 * **Read a patch: what can be used, and what could not, with reasons.**
 *
 * The one entry point. It replaces a `splitTaskOps` that silently dropped
 * whatever it did not recognise into the memory pile, where `applyOps` dropped
 * it again under a reason about namespaces that was true of a dozen unrelated
 * mistakes.
 *
 * Nothing is discarded here without a row in `rejected` saying which field was
 * wrong. A caller that throws that list away has reintroduced the bug, which
 * is why every caller in this codebase merges it into the panel's *Proposed,
 * not stored* list.
 *
 * @param {unknown} ops
 * @param {{ turn?: number, at?: string }} [stamp]
 * @returns {{ taskOps: object[], memoryOps: object[], rejected: object[] }}
 */
export function readPatch(ops, { turn = 0, at = new Date().toISOString() } = {}) {
  const taskOps = [];
  const memoryOps = [];
  const rejected = [];

  for (const raw of Array.isArray(ops) ? ops : []) {
    if (!raw || typeof raw !== "object") {
      rejected.push(reject({ reason: "not an operation", turn, at, value: describe(raw) }));
      continue;
    }

    const { key, action } = coerceOp(raw);

    if (TASK_OPS.has(action)) {
      taskOps.push({ ...raw, op: action });
      continue;
    }
    if (MEMORY_OPS.has(action)) {
      memoryOps.push({ ...raw, op: action, key });
      continue;
    }

    // Past coercion. Say which field was wrong, because "unknown namespace"
    // was true of every one of these and told you nothing about any of them.
    rejected.push(
      reject({
        key,
        op: action,
        value: String(raw?.value ?? raw?.text ?? ""),
        turn,
        at,
        reason: reasonFor(key, action, raw),
      })
    );
  }

  return { taskOps, memoryOps, rejected };
}

/** Why one item could not be used — the sentence a person reads in the panel. */
function reasonFor(key, action, raw) {
  const hasValue = Boolean(String(raw?.value ?? raw?.text ?? "").trim());
  if (!key && !action) return "no op and no key";
  if (!key) return `no key, and \`${action}\` is not an op`;
  if (!routeFor(key)) return "unknown namespace";
  if (!hasValue) return `\`${key}\` with no value, and \`${action || "(no op)"}\` is not an op`;
  return `\`${action || "(no op)"}\` is not an op`;
}

function reject({ key = "", op = "", value = "", reason, turn, at }) {
  return {
    key: key || "(no key)",
    op: op || "(no op)",
    value: String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_VALUE_LENGTH),
    reason,
    turn,
    at,
  };
}

/** Whatever it was, in a few words, so the panel can quote it back. */
function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "string" ? value : String(value);
}

/**
 * Pull the JSON array out of whatever came back. A model that ignored "no code
 * fences" or prefixed a sentence has still done the work, and throwing that
 * away would cost a turn its memory for a formatting slip.
 *
 * A response with no array in it at all is the one thing this cannot read, and
 * it says so rather than returning an empty patch that looks like a model
 * having found nothing to say.
 *
 * @returns {{ items: unknown[], rejected: object[] }}
 */
export function parseJsonArray(raw, { turn = 0, at = new Date().toISOString() } = {}) {
  const text = String(raw ?? "").replace(/```(?:json)?/gi, "").trim();
  if (!text) return { items: [], rejected: [] };

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) {
    return { items: [], rejected: [reject({ reason: "the reply held no JSON array", value: text, turn, at })] };
  }

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { items: [], rejected: [reject({ reason: "the JSON array would not parse", value: text.slice(start, end + 1), turn, at })] };
  }
  if (!Array.isArray(parsed)) {
    return { items: [], rejected: [reject({ reason: "the JSON was not an array", value: text.slice(start, end + 1), turn, at })] };
  }
  return { items: parsed, rejected: [] };
}
