import { readPatch } from "./patch.js";

/**
 * **The task lifecycle, as data.**
 *
 * Day 11 gave the task a start and an end — the next message opens one, the
 * *Finish task* button closes it. That is a boundary, not a shape: between the
 * two ends there was one undifferentiated state in which the assistant behaved
 * identically whether nobody had said what the work was yet, the work was half
 * done, or it was written and waiting to be checked.
 *
 * Nothing new needs storing for this. `strategyState` is already per-branch,
 * deep-copied on fork and persisted, so the whole machine rides in the memory
 * strategy's own state and inherits branching and restart-survival for free.
 *
 * Three rules hold here, and they are the same three `memory.js` holds:
 *
 *   - **The edges are a table**, in one place, in code. Which stages follow
 *     which is a lookup, never a judgement, and never something a model is
 *     asked about.
 *   - **One mutation path.** `transition()` is to the stage what `applyOps` is
 *     to the keys: buttons, model proposals and the scenario harness all go
 *     through it, so an illegal edge is refused once rather than in three
 *     places that can drift apart.
 *   - **Failure degrades.** An illegal edge is discarded and recorded; it is
 *     never coerced to a nearby valid state, and it never costs the turn.
 */

/** The four stages, in the order the strip draws its dots. */
export const STAGES = ["planning", "execution", "validation", "done"];

/**
 * **The legal edges.**
 *
 * The backward ones are not optional, and they are the reason this is a table
 * rather than an index into `STAGES`. Validation failing is the interesting
 * case and the common one; a machine that can only move forward would leave
 * the only useful answer to "it does not meet the goal" unrepresentable, and
 * the work would carry on in `validation` pretending otherwise.
 *
 * `done` is terminal on purpose. Reopening it would mean a closed task could
 * gain entries after its promotion call had already run, which is the one way
 * "promotion fires exactly once" stops being structurally true. Resumed work
 * is a **new task referencing the old one** — see `emptyTask`.
 */
export const TRANSITIONS = {
  planning: ["execution"],
  execution: ["validation", "planning"],
  validation: ["done", "execution"],
  done: [],
};

/**
 * One instruction line per stage, contributed to `<working>` in the system
 * prompt. Without these the machine is decoration: the same question asked in
 * two stages has to come back visibly different, or nothing has been built
 * except a diagram of itself.
 *
 * **Planning is the one that matters.** Every conversation starts here,
 * including "what's the weather", so its instruction is mostly a list of
 * things not to do: do not gate the answer behind questions, do not ask four
 * of them, do not assume what you could record as unknown. The last clause is
 * the one that changes behaviour most — a model that knows the goal is about
 * to freeze argues with a wrong one now instead of working around it later.
 */
export const STAGE_PROMPTS = {
  planning:
    "STAGE — planning. Your job here is to understand the task, not to do it. **Do not produce the deliverable** — no plan, no code, no draft, no design, not even a short one, and not because the user said 'go ahead' or 'just do it'. If they push for it, say the work happens in execution and name what you still need before it can start. The exception is a direct question that is not the task itself ('what's the weather', 'what does this flag do'): answer that briefly and carry on — this stage never holds an ordinary answer back. " +
    "Otherwise: ask for what you are missing, at most one or two questions per turn, and only where a different answer would change the work. State any assumption you are making out loud so it can be corrected. The goal above is about to be frozen and the conversation so far will be replaced by a written brief, so anything not established here is lost to the work. " +
    "When the goal and the constraints are recorded and no open questions remain, stop asking and say so in these words: \"Everything's clear — we can switch to execution now. Or add more details if you want to refine it first.\" Do not say that while anything material is still unknown.",
  execution:
    "STAGE — execution. Work inside the goal and the constraints recorded above and add nothing to them. If something outside them turns out to be needed, name it and say it is outside the agreed scope; do not quietly widen the work to cover it.",
  validation:
    "STAGE — validation. Check what has been produced against the recorded goal and constraints, one at a time, and report what fails, what is unverified and what passes. Do not silently fix anything you find: a fix is a return to execution, and that is the user's call, not yours.",
  /**
   * The invariants' row in validation, added to the stage line only when there
   * are any.
   *
   * Validation is the **last** place to catch a violation, not the first — the
   * block has been on the wire since planning and the refusal happens in
   * execution. What it adds is the enumeration: one row per rule, checked
   * deliberately rather than remembered in passing.
   *
   * `unverified` is a first-class verdict and the whole reason this line
   * exists. From inside a chat it is the honest answer far more often than
   * people expect — nothing here ran the code — and a model with only two
   * boxes to tick will tick `pass`.
   */
  validationInvariants:
    " Then enumerate the rules in <invariants>, one row each, in the form `<subject>: pass | fail | unverified — why`. **Measure the work against the rule's own text and check, as they are written in that block, and against nothing else** — not against what was agreed in the conversation, and not against a rule anyone said was lifted, and not against a goal or constraint that says the opposite of one. If it is in the block it is in force, and work that does the thing a rule names is a `fail` — however that came about, and however the rest of memory describes the task. **`unverified` is a real verdict and the right one whenever you have not actually seen the thing the check looks at**; never report it as a pass, and never report a pass you inferred from the absence of evidence.",
  done: "STAGE — done. This task is closed. Nothing further is worked on under it; if the user wants more, that is a new task.",
};

/** What the step line says the moment a stage is entered, before the model refines it. */
const DEFAULT_STEP = {
  planning: "working out what the task is",
  execution: "doing the work",
  validation: "checking the work against the goal",
  done: "finished",
};

/**
 * Whose turn it is the moment a stage is entered.
 *
 * There is no `blocked` state, and there should not be: blocked is
 * `actor: 'user'`, which is the same fact said in a way the strip can render
 * and the next turn can act on. A separate state would have to be entered and
 * left by somebody, and nobody ever remembers to leave it.
 */
export const DEFAULT_EXPECTED = {
  planning: { actor: "user", what: "say what the task is, and answer the open questions" },
  execution: { actor: "agent", what: "do the work inside the recorded goal and constraints" },
  validation: { actor: "agent", what: "check the work against the goal and report what fails" },
  done: { actor: "user", what: "start a new task when there is more to do" },
};

/** How much of the log and of the refusal list is worth keeping. */
const MAX_LOG = 60;
const MAX_REFUSED = 8;
/** How many invariant refusals one task keeps. */
const MAX_REFUSALS = 12;
const MAX_LINE = 160;

/**
 * A task at its beginning: an **empty log**, which derives to `planning`.
 *
 * Every conversation starts in `planning` and there is no null/no-task state,
 * so this is what the strategy's `emptyState` holds from the first turn rather
 * than something created when the user declares an intention. The seed is an
 * empty log rather than a synthetic `→ planning` entry because the log is the
 * record of things that *happened*, and starting is not one of them.
 *
 * @param {{ previous?: string | null, at?: string }} [params]
 */
export function emptyTask({ previous = null, at = new Date().toISOString() } = {}) {
  return {
    id: `t${Math.random().toString(36).slice(2, 8)}`,
    /** The task this one resumes, when it is a successor to a closed one. */
    previous: previous ?? null,
    startedAt: at,
    updatedAt: at,
    /** Append-only. The current stage is derived from the last entry. */
    transitions: [],
    step: DEFAULT_STEP.planning,
    // Which exchange the step line was written on. It carries no meaning on
    // its own and is never shown; it exists so that a branch can tell its own
    // step line from one its parent wrote after the fork. See `taskAsOf`.
    stepTurn: 0,
    /** What the model thinks the next edge is. A suggestion, never a state. */
    suggestion: null,
    /** Edges that were asked for and refused, so the panel can say so. */
    refused: [],
    /**
     * Requests refused because they would have broken a project invariant —
     * `{ invariant, request, alternative }`, written by the model through the
     * `refused` op. Distinct from `refused` above, which is about *edges of
     * this machine* rather than about the work.
     */
    refusals: [],
  };
}

/**
 * **The stage, derived.** One source of truth — the last thing that happened —
 * which is what gives the transcript dividers, the audit trail and
 * resume-after-restart without any of the three being maintained separately.
 */
export function stageOf(task) {
  const log = task?.transitions;
  const last = Array.isArray(log) && log.length ? log[log.length - 1].to : null;
  return STAGES.includes(last) ? last : "planning";
}

/**
 * **Whose turn it is, derived from the stage** — the way the stage itself is
 * derived from the log.
 *
 * It used to be a stored field the extractor wrote with an `awaiting` op, and
 * that op is gone. The reason is worth keeping written down, because it is the
 * same mistake in two directions:
 *
 *   - `actor: "user"` said *nobody has answered this yet*, which is what an
 *     `open.*` key already says — in a form that has a key, a row in the panel,
 *     a `forget` button and a way to be closed. The field had none of those, so
 *     a stale one could only be argued with.
 *   - `actor: "agent"` said *I am about to do something*, which is what an
 *     assumption the assistant states is: a `decision.*`, overwritten the
 *     moment the user says otherwise.
 *
 * What was left once both of those went home is exactly the stage's own
 * default, which is a lookup and cannot go stale. The `▶` button sends this
 * sentence, and a per-stage sentence is what it always wanted.
 */
export function expectedActionOf(task) {
  return { ...DEFAULT_EXPECTED[stageOf(task)] };
}

/** Whether the table has this edge at all. */
export function isLegal(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

/**
 * **`true`, or the reason it cannot happen.**
 *
 * A pure function of the state, and the only place a rule about an edge is
 * written down. The string it returns is the disabled button's tooltip, which
 * is the whole reason it returns a sentence rather than a code: the person
 * looking at a greyed-out button is the person who needs the rule explained,
 * and a rule explained in a second place is a rule that will disagree with
 * itself.
 *
 * Illegal edges answer here too. A caller that only knows "blocked, and why"
 * should not need a second call to tell a guard from a missing edge.
 *
 * @param {string} from
 * @param {string} to
 * @param {Record<string, { value: string }>} working
 * @returns {true | string}
 */
export function guardFor(from, to, working = {}) {
  if (!STAGES.includes(to)) return `${to} is not a stage.`;
  if (from === "done") return "This task is done. Resuming means starting a new task that references it.";
  if (!isLegal(from, to)) return `${from} does not lead to ${to}.`;

  // Leaving planning freezes the goal, so there had better be one. This is the
  // guard that gives the planning-stage instruction something real to be
  // pointed at: an agent told to surface unknowns as `open.*` is an agent
  // whose user can see what the button is waiting for.
  if (from === "planning" && to === "execution" && !hasGoal(working)) {
    return "Nothing is recorded as the goal yet — say what the task is first.";
  }

  return true;
}

/**
 * What proceeds anyway, with something said out loud.
 *
 * Unanswered `open.*` keys are the case this exists for, and they are worth
 * saying on **both** of the edges that walk away from them:
 *
 *   - **Leaving `planning`** is the moment the goal freezes and the unknowns
 *     stop being things anyone is going to ask about. Surfacing clarifications
 *     as `open.*` rather than assuming them is only worth doing if something
 *     downstream reads them, and this is the something.
 *   - **Entering `done`** finishes the work with those holes still in it.
 *
 * Neither blocks, and that is deliberate. Plenty of real work starts, and
 * finishes, with questions nobody ever answered; a machine that refuses to let
 * you begin until the form is complete is a machine people route around. And
 * blocking here while `→ done` only warns would put a stricter gate on
 * *starting* work than on declaring it finished, which is backwards.
 *
 * @returns {string | null}
 */
export function warningFor(from, to, working = {}, task = null) {
  const relevant = to === "done" || (from === "planning" && to === "execution");
  if (!relevant) return null;

  const parts = [];

  const open = Object.keys(working ?? {}).filter((key) => key === "open" || key.startsWith("open."));
  if (open.length) {
    /**
     * **"Recorded as open", not "unanswered".** The two are not the same claim
     * and the difference is a whole turn wide: extraction runs before the
     * reply, so at the moment anyone reads this the newest reply has not been
     * read into memory. A question the assistant opened and then answered
     * itself — in the same turn, which is the common shape of *"everything's
     * clear, we can switch to execution now"* — is still sitting here as a row.
     *
     * Saying `still unanswered` about it is the warning asserting something it
     * has no way to know, and it is worse than no warning: it sends people
     * looking for a question they have already settled. So it reports the row
     * and names the gap, and the brief — the one thing that reads every
     * planning message, including that reply — settles it on the way out.
     */
    const count = `${open.length} question${open.length === 1 ? " is" : "s are"} recorded as open`;
    parts.push(
      to === "done"
        ? `${count} — the task finishes with ${open.length === 1 ? "it" : "them"} still open: ${open.join(", ")}.`
        : `${count}: ${open.join(", ")}. The last reply has not been read into memory yet, so ` +
          `${open.length === 1 ? "it may already be answered" : "some may already be answered"} — the brief ` +
          `is written from the whole conversation and will say. Leaving planning freezes the goal, and ` +
          `these stop being things the agent asks about.`
    );
  }

  return parts.length ? parts.join(" ") : null;
}

/**
 * Every edge out of the current stage, each with its verdict — what the strip
 * renders its buttons from, so the buttons cannot offer an edge the table does
 * not have.
 *
 * @returns {{ to: string, allowed: boolean, reason: string | null, warning: string | null }[]}
 */
export function edgesFrom(task, working = {}) {
  const from = stageOf(task);
  return (TRANSITIONS[from] ?? []).map((to) => {
    const guard = guardFor(from, to, working);
    return {
      to,
      allowed: guard === true,
      reason: guard === true ? null : guard,
      warning: guard === true ? warningFor(from, to, working, task) : null,
    };
  });
}

/**
 * **The one mutation path.** Mirrors `applyOps`: it takes the state and an
 * event, it returns the next state and a description of what it did, and it
 * never throws. Buttons, model proposals and the demo harness all arrive here.
 *
 * An illegal or guarded edge is **discarded and recorded** — the state comes
 * back unchanged, the refusal goes on a short list the panel can show, and a
 * line goes to the log. Coercing it to a nearby valid stage would be the worst
 * of the options: the machine would look like it worked, and the stage would
 * be something nobody chose.
 *
 * @param {object} state - The task record.
 * @param {object} event
 * @param {string} event.to - The stage being asked for.
 * @param {"user" | "model" | "system"} [event.by] - Who asked.
 * @param {string} [event.reason] - Why, in a few words. Kept in the log.
 * @param {Record<string, { value: string }>} [event.working] - What the guards read.
 * @param {number} [event.turn] - Which exchange this happened after, so the
 *   transcript can draw its divider in the right place.
 * @param {string} [event.at]
 * @returns {{ task: object, ok: boolean, from: string, to: string, entered: string | null, reason: string | null, warning: string | null }}
 */
export function transition(state, event = {}) {
  const task = normaliseTask(state);
  const from = stageOf(task);
  const to = typeof event.to === "string" ? event.to.trim().toLowerCase() : "";
  const by = ["user", "model", "system"].includes(event.by) ? event.by : "user";
  const at = typeof event.at === "string" ? event.at : new Date().toISOString();
  const turn = Number.isInteger(event.turn) ? event.turn : 0;
  const working = event.working ?? {};

  const guard = guardFor(from, to, working);
  if (guard !== true) {
    // Logged, not swallowed. "The button did nothing" and "the model proposed
    // an edge the table does not have" are different events, and only one of
    // them is worth a person's attention.
    console.error(`[task] refused ${from} → ${to || "(nothing)"} by ${by}: ${guard}`);
    return {
      task: {
        ...task,
        refused: [...task.refused, { from, to: to || "(nothing)", by, reason: guard, at, turn }].slice(-MAX_REFUSED),
      },
      ok: false,
      from,
      to,
      entered: null,
      reason: guard,
      warning: null,
    };
  }

  const warning = warningFor(from, to, working, task);
  const entry = { from, to, at, by, turn, reason: line(event.reason) || null };

  return {
    task: {
      ...task,
      transitions: [...task.transitions, entry].slice(-MAX_LOG),
      // Both are replaced rather than carried over. "Drafting the migration
      // plan" is worse than useless once the stage says validation: it is a
      // status line that is confidently describing the previous stage, and the
      // next extraction is a whole turn away.
      step: DEFAULT_STEP[to],
      stepTurn: turn,
      // The suggestion has either just been taken or just been overtaken.
      suggestion: null,
      updatedAt: at,
    },
    ok: true,
    from,
    to,
    entered: to,
    reason: null,
    warning,
  };
}

// ---- what the model may say about the task ---------------------------------

/**
 * Split a patch into the ops about *memory* and the ops about the *task*.
 *
 * Kept as a name because it is what the split is called everywhere else, but
 * the work — the op vocabulary, the coercion, and the list of what was neither
 * — belongs to `readPatch` in `patch.js`. Two readers of the same format were
 * two places for it to drift, and the drift is what threw three turns of
 * memory away.
 */
export function splitTaskOps(ops) {
  const { taskOps, memoryOps } = readPatch(ops);
  return { taskOps, memoryOps };
}

/**
 * The model's ops about the task, applied — with the one that matters held
 * back.
 *
 * `step` is **written**. It is descriptive, it gates nothing, and it is what
 * makes resume work after a week's gap — a status line nobody will ever click a
 * button to keep fresh is a status line that goes stale in two turns and is
 * then worse than nothing. Whose turn it is is not written by anybody: it is
 * derived from the stage. See `expectedActionOf`.
 *
 * `stage` is **not written**. It becomes a suggestion rendered beside the
 * button it corresponds to, and the stage changes on a click or not at all.
 * The model is told what stage it is in; it is never consulted about it, and
 * the difference is the difference between a state machine and a model's
 * running guess at one.
 *
 * **Nothing is dropped in silence here either.** Every op that cannot be used
 * comes back in `rejected`, in the shape `applyOps` uses, so the caller can
 * put it in the same list the panel already draws. A `step` with no text and a
 * `refused` naming no rule used to `continue` and vanish, which is how a model
 * getting a field name wrong looked exactly like a model saying nothing.
 *
 * @returns {{ task: object, suggested: string | null, wrote: string[], rejected: object[] }}
 */
export function applyTaskOps(state, ops, { turn = 0, at = new Date().toISOString() } = {}) {
  let task = normaliseTask(state);
  const wrote = [];
  const rejected = [];
  let suggested = null;
  const drop = (op, reason, value = "") =>
    rejected.push({
      key: "(no key)",
      op,
      value: String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LINE),
      reason,
      turn,
      at,
    });

  for (const op of Array.isArray(ops) ? ops : []) {
    if (op.op === "step") {
      const value = line(op.value);
      if (!value) {
        drop("step", "a step with nothing in it", op.value);
        continue;
      }
      if (value === task.step) continue;
      task = { ...task, step: value, stepTurn: turn, updatedAt: at };
      wrote.push("step");
      continue;
    }

    /**
     * **`awaiting` is gone, and an op still asking for it says why.**
     *
     * It had two meanings and both belong somewhere with a key. *Nobody has
     * answered this* is an `open.*`; *here is what I am going to do* is a
     * `decision.*`, which the user overrides by saying otherwise. What the op
     * actually produced was a third thing with no key, no row and no way to
     * close it, so a sentence like "confirm whether to use iterative DFS" sat
     * in the warning for three turns after the rule that settled it had been
     * quoted in the reply.
     *
     * Refused rather than ignored: the prompt no longer offers this op, so one
     * arriving means a model is working from an older idea of the format, and
     * that is worth being able to see in the panel.
     */
    if (op.op === "awaiting") {
      drop(
        "awaiting",
        "awaiting was removed — an unanswered question is an open.*, a stated assumption is a decision.*",
        op.what ?? op.value
      );
      continue;
    }

    // **`refused`. Written, not gating — like `step` and `awaiting`.**
    //
    // Nothing reaches `applyOps` when the model suggests an ORM in a
    // paragraph, so code cannot be what catches it; the prompt is. This op is
    // the model saying, in the same patch it reports its progress in, *I was
    // asked for X, rule Y forbids it, here is what I offered instead* — and it
    // is the visible artefact of the whole feature. "What happens when a
    // request conflicts" becomes a line under the rule on screen rather than a
    // paragraph in a transcript somebody has to go and read.
    //
    // It gates nothing, and it must not: the refusal already happened, in
    // prose, in the reply. This is the record of it.
    if (op.op === "refused") {
      const invariant = line(op.invariant).toLowerCase().replace(/\s+/g, "");
      const request = line(op.request ?? op.value);
      if (!invariant || !request) {
        drop(
          "refused",
          invariant ? `a refusal under \`${invariant}\` with no request` : "a refusal naming no invariant",
          request
        );
        continue;
      }
      const entry = {
        invariant,
        request,
        // **A refusal must always carry an exit.** A dead end is a bad
        // refusal: it gets routed around by dropping the constraint from the
        // conversation entirely. So the alternative is recorded beside it, and
        // its absence is visible rather than invisible.
        alternative: line(op.alternative) || null,
        turn,
        at,
      };
      if (task.refusals.some((row) => row.invariant === entry.invariant && row.request === entry.request)) continue;
      task = { ...task, refusals: [...task.refusals, entry].slice(-MAX_REFUSALS), updatedAt: at };
      wrote.push("refused");
      continue;
    }

    // `stage`. Recorded as a proposal with the reason it gave, and applied by
    // nobody. An illegal one is still worth keeping: "the model thinks this is
    // finished while the table says we are in planning" is information about
    // the conversation, and the guard will say why the button is grey.
    const to = typeof op.to === "string" ? op.to.trim().toLowerCase() : line(op.value).toLowerCase();
    if (to === stageOf(task)) continue;
    if (!STAGES.includes(to)) {
      drop("stage", `\`${to || "(nothing)"}\` is not a stage`, op.reason);
      continue;
    }
    suggested = to;
    task = { ...task, suggestion: { to, reason: line(op.reason) || null, turn, at } };
  }

  return { task, suggested, wrote, rejected };
}

// ---- what the task contributes to the prompt -------------------------------

/**
 * The stage's lines for the `<working>` block: where we are, what is in
 * progress, whose turn it is, and the one instruction that stage carries.
 *
 * They go inside `<working>` rather than in a block of their own because they
 * are the same kind of claim as the keys under them — *what is currently true
 * about the work* — and a fourth block would be a fourth thing the model has
 * to be told how to read.
 */
export function taskLines(task, { invariants = 0 } = {}) {
  const current = normaliseTask(task);
  const stage = stageOf(current);
  const lines = [`stage: ${stage}`];
  if (current.step) lines.push(`step: ${current.step}`);
  const { actor, what } = expectedActionOf(current);
  lines.push(`awaiting: ${actor === "agent" ? "you, the assistant" : "the user"}${what ? ` — ${what}` : ""}`);
  // The enumeration rides on the instruction the stage already carries rather
  // than arriving as a block of its own, and only when there is something to
  // enumerate — nothing pays for a layer it is not using.
  lines.push(
    stage === "validation" && invariants > 0
      ? STAGE_PROMPTS.validation + STAGE_PROMPTS.validationInvariants
      : STAGE_PROMPTS[stage]
  );
  return lines;
}

/**
 * **The freeze.** Which keys a model may no longer write.
 *
 * `goal` is freely writable while the task is being planned and a correction
 * proposal afterwards, in exactly the way a `declared` profile entry is — the
 * same rule, the same shape, a different reason for it. It is also the fix for
 * goal drift: drift is a planning-stage phenomenon, so the write policy
 * tightens at the moment the task is committed to rather than being policed by
 * a prompt for the whole conversation.
 *
 * Going *back* to planning thaws it again, and that is the point of the
 * backward edge rather than a hole in it: `execution → planning` is what you
 * press when the goal turns out to be the thing that was wrong.
 */
export function frozenKeys(task) {
  return stageOf(task) === "planning" ? [] : ["goal"];
}

/**
 * **The turn the work itself began on** — the last crossing out of `planning`,
 * or `null` while the task has never left it.
 *
 * Derived from the log rather than stored beside it, for the reason the stage
 * is: a field saying *the work started here* is a second thing that can
 * disagree with the transitions it was read from.
 *
 * The *last* crossing rather than the first, because `execution → planning` is
 * a legal edge. A task sent back to be re-planned and started again is working
 * from the later brief, and the earlier attempt is not the work in hand.
 */
export function workStartedOn(task) {
  const log = normaliseTask(task).transitions;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].from === "planning" && log[i].to !== "planning") {
      return Number.isInteger(log[i].turn) ? log[i].turn : null;
    }
  }
  return null;
}

/**
 * **The task as it stood after `turns` exchanges** — `entriesAsOf`, for the
 * lifecycle.
 *
 * A branch copies its parent's whole `strategyState` at fork time, later
 * entries and all, which is why working memory is stamped and filtered. The
 * transition log needs exactly the same treatment and for exactly the same
 * reason: a fork that inherits a `validation` its own branch never reached
 * does not look like a storage bug from the outside. It looks like the agent
 * insisting on work nobody on that branch ever asked for — and every one of
 * the four stages would be telling the model something false about where it
 * is.
 *
 * The two descriptive fields fall back to the stage's defaults rather than to
 * the parent's sentences, because "writing the migration script" is a claim
 * about work that, on this branch, was never done.
 */
export function taskAsOf(task, turns) {
  const current = normaliseTask(task);
  if (!Number.isFinite(turns)) return current;

  const transitions = current.transitions.filter((entry) => (entry.turn ?? 0) <= turns);
  if (transitions.length === current.transitions.length &&
      current.stepTurn <= turns &&
      current.refusals.every((row) => (row.turn ?? 0) <= turns) &&
      (!current.suggestion || current.suggestion.turn <= turns)) {
    return current;
  }

  const stage = STAGES.includes(transitions[transitions.length - 1]?.to)
    ? transitions[transitions.length - 1].to
    : "planning";

  return {
    ...current,
    transitions,
    step: current.stepTurn <= turns ? current.step : DEFAULT_STEP[stage],
    stepTurn: Math.min(current.stepTurn, turns),
    suggestion: current.suggestion && current.suggestion.turn <= turns ? current.suggestion : null,
    refused: current.refused.filter((row) => (row.turn ?? 0) <= turns),
    // A refusal a parent branch's turn produced is not something this branch
    // ever said, for exactly the reason its working keys are not.
    refusals: current.refusals.filter((row) => (row.turn ?? 0) <= turns),
  };
}

// ---- helpers ---------------------------------------------------------------

function hasGoal(working) {
  const entry = working?.goal;
  return Boolean(typeof entry?.value === "string" ? entry.value.trim() : entry);
}

function line(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LINE);
}

/** Whatever came off disk, coerced into a task this machine can work with. */
export function normaliseTask(task) {
  const source = task && typeof task === "object" ? task : {};
  const transitions = (Array.isArray(source.transitions) ? source.transitions : [])
    .filter((entry) => STAGES.includes(entry?.to) && (entry.from == null || STAGES.includes(entry.from)))
    .map((entry) => ({
      from: entry.from ?? null,
      to: entry.to,
      at: typeof entry.at === "string" ? entry.at : null,
      by: ["user", "model", "system"].includes(entry.by) ? entry.by : "user",
      turn: Number.isInteger(entry.turn) ? entry.turn : 0,
      reason: typeof entry.reason === "string" && entry.reason.trim() ? line(entry.reason) : null,
    }))
    .slice(-MAX_LOG);

  const stage = STAGES.includes(transitions[transitions.length - 1]?.to)
    ? transitions[transitions.length - 1].to
    : "planning";
  return {
    id: typeof source.id === "string" && source.id ? source.id : `t${Math.random().toString(36).slice(2, 8)}`,
    previous: typeof source.previous === "string" && source.previous ? source.previous : null,
    startedAt: typeof source.startedAt === "string" ? source.startedAt : null,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
    transitions,
    step: line(source.step) || DEFAULT_STEP[stage],
    stepTurn: Number.isInteger(source.stepTurn) ? source.stepTurn : 0,
    suggestion:
      source.suggestion && STAGES.includes(source.suggestion.to)
        ? {
            to: source.suggestion.to,
            reason: typeof source.suggestion.reason === "string" ? line(source.suggestion.reason) : null,
            turn: Number.isInteger(source.suggestion.turn) ? source.suggestion.turn : 0,
            at: typeof source.suggestion.at === "string" ? source.suggestion.at : null,
          }
        : null,
    refused: (Array.isArray(source.refused) ? source.refused : [])
      .filter((row) => typeof row?.reason === "string")
      .slice(-MAX_REFUSED),
    refusals: (Array.isArray(source.refusals) ? source.refusals : [])
      .filter((row) => typeof row?.invariant === "string" && row.invariant && typeof row?.request === "string")
      .map((row) => ({
        invariant: line(row.invariant).toLowerCase(),
        request: line(row.request),
        alternative: line(row.alternative) || null,
        turn: Number.isInteger(row.turn) ? row.turn : 0,
        at: typeof row.at === "string" ? row.at : null,
      }))
      .slice(-MAX_REFUSALS),
  };
}
