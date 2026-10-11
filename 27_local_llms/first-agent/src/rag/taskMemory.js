/**
 * **A Knowledge chat's task memory (Day 25).**
 *
 * Small, per chat, stored on the conversation record:
 *
 * ```js
 * { goal: string | null,
 *   clarified: [{ id, text, turn }],      // details the user has clarified
 *   constraints: [{ id, text, turn }],    // rules and terms the user set
 *   open_questions: [{ id, text, turn, question }] }  // clarifying questions we asked, still unanswered
 * ```
 *
 * It is not the lifecycle's working-task state (`src/context/taskState.js`):
 * no stages, no plan, no invariants. The router proposes a patch, a list of
 * operations, never a rewrite; `applyPatch` validates and applies them one by
 * one. An unknown op or id is logged and skipped, never fatal, and nothing
 * leaves the memory except through `remove` or `resolve_question`.
 *
 * Ids are `<prefix><turn>` (`d3`, `k2`, `q6`), with `b`, `c`, … for a second
 * item of the same kind in one turn, so they never repeat within a chat.
 */

export const MEMORY_OPS = ["set_goal", "add_clarified", "add_constraint", "remove", "resolve_question"];
const LISTS = { clarified: "d", constraints: "k", open_questions: "q" };
export const MAX_ITEM_CHARS = 300;

export const emptyMemory = () => ({ goal: null, clarified: [], constraints: [], open_questions: [] });

const text = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_CHARS) : "");

/** Whatever is stored (or nothing) → a valid memory. */
export function taskMemoryOf(value) {
  const out = emptyMemory();
  if (!value || typeof value !== "object") return out;
  out.goal = text(value.goal) || null;
  for (const key of Object.keys(LISTS)) {
    const seen = new Set();
    for (const item of Array.isArray(value[key]) ? value[key] : []) {
      const id = String(item?.id ?? "");
      const t = text(item?.text);
      if (!id || !t || seen.has(id)) continue;
      seen.add(id);
      out[key].push({ id, text: t, turn: Number.isInteger(item.turn) ? item.turn : null, ...(key === "open_questions" && item.question ? { question: text(item.question) } : {}) });
    }
  }
  return out;
}

export const isEmptyMemory = (m) => !m.goal && !m.clarified.length && !m.constraints.length && !m.open_questions.length;

/** Every id in the memory, with the list it is in. */
function idsOf(memory) {
  const out = new Map();
  for (const key of Object.keys(LISTS)) for (const item of memory[key]) out.set(item.id, key);
  return out;
}

/** The next free id for a list in this turn: `k4`, then `k4b`, `k4c`, … */
function nextId(memory, key, turn) {
  const taken = idsOf(memory);
  const base = `${LISTS[key]}${turn}`;
  if (!taken.has(base)) return base;
  for (let i = 1; i < 26; i++) {
    const id = base + String.fromCharCode(97 + i);
    if (!taken.has(id)) return id;
  }
  return `${base}_${taken.size}`;
}

/**
 * Apply the router's operations in order. Each is validated on its own; a bad
 * one is skipped with a reason and the rest still apply.
 *
 * @param {object} memory - the memory before the turn
 * @param {unknown} patch - the router's `memory_patch`
 * @param {{ turn: number, log?: (line: string) => void }} o
 * @returns {{ memory: object, applied: object[], skipped: Array<{ op: object, reason: string }> }}
 *   `applied` holds each op as applied, with the id it created or removed.
 */
export function applyPatch(memory, patch, { turn, log = () => {} }) {
  const next = structuredClone(taskMemoryOf(memory));
  const applied = [];
  const skipped = [];
  const skip = (op, reason) => {
    skipped.push({ op, reason });
    log(`[chat] memory op skipped (${reason}): ${JSON.stringify(op)}`);
  };
  for (const op of Array.isArray(patch) ? patch : []) {
    if (!op || typeof op !== "object" || !MEMORY_OPS.includes(op.op)) {
      skip(op, "unknown op");
      continue;
    }
    if (op.op === "set_goal") {
      const goal = text(op.text);
      if (!goal) skip(op, "empty text");
      else if (goal === next.goal) skip(op, "unchanged");
      else {
        applied.push({ op: "set_goal", text: goal, previous: next.goal });
        next.goal = goal;
      }
    } else if (op.op === "add_clarified" || op.op === "add_constraint") {
      const key = op.op === "add_clarified" ? "clarified" : "constraints";
      const t = text(op.text);
      if (!t) skip(op, "empty text");
      else if (next[key].some((item) => item.text.toLowerCase() === t.toLowerCase())) skip(op, "duplicate");
      else {
        const id = nextId(next, key, turn);
        next[key].push({ id, text: t, turn });
        applied.push({ op: op.op, id, text: t });
      }
    } else {
      const id = String(op.id ?? "").trim();
      const list = idsOf(next).get(id);
      if (!list) skip(op, "unknown id");
      else if (op.op === "resolve_question" && list !== "open_questions") skip(op, "not an open question");
      else {
        const item = next[list].find((x) => x.id === id);
        next[list] = next[list].filter((x) => x.id !== id);
        applied.push({ op: op.op, id, text: item.text, list });
      }
    }
  }
  return { memory: next, applied, skipped };
}

/** Add the clarifying question of an "I don't know" — done by code, not the router. */
export function addOpenQuestion(memory, { text: question, about, turn }) {
  const next = structuredClone(taskMemoryOf(memory));
  const t = text(question);
  if (!t) return { memory: next, added: null };
  const id = nextId(next, "open_questions", turn);
  const item = { id, text: t, turn, ...(about ? { question: text(about) } : {}) };
  next.open_questions.push(item);
  return { memory: next, added: item };
}

/** What changed between two memories: ids added and removed, and whether the goal moved. For the panel's highlight. */
export function memoryDiff(before, after) {
  const a = idsOf(taskMemoryOf(before));
  const b = idsOf(taskMemoryOf(after));
  return {
    added: [...b.keys()].filter((id) => !a.has(id)),
    removed: [...a.keys()].filter((id) => !b.has(id)).map((id) => {
      const list = a.get(id);
      const item = taskMemoryOf(before)[list].find((x) => x.id === id);
      return { id, list, text: item.text };
    }),
    goalChanged: (taskMemoryOf(before).goal ?? null) !== (taskMemoryOf(after).goal ?? null),
    previousGoal: taskMemoryOf(before).goal ?? null,
  };
}

/** The memory as the router and the answering model read it: one line per item, with ids. */
export function renderMemory(memory, { ids = true } = {}) {
  const m = taskMemoryOf(memory);
  if (isEmptyMemory(m)) return "(empty)";
  const line = (item) => `- ${ids ? `[${item.id}] ` : ""}${item.text}`;
  const section = (title, items, fmt = line) => (items.length ? [`${title}:`, ...items.map(fmt)] : [`${title}: (none)`]);
  return [
    `Goal: ${m.goal ?? "(none)"}`,
    ...section("Clarified details", m.clarified),
    ...section("Constraints and terms", m.constraints),
    ...section("Open questions (asked by the assistant, not yet answered)", m.open_questions, (q) => `${line(q)}${q.question ? ` (about: "${q.question}")` : ""}`),
  ].join("\n");
}
