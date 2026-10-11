/**
 * **After a failed run: a corrected plan, as a proposal.**
 *
 * The ticker calls this once per failed run. It asks the planner for a repair
 * — the goal, the plan that ran, what each step produced and the error — and
 * stores the answer as the schedule's pending proposal, reason "repair", with
 * the failed run beside it. It never touches the plan: the next interval run
 * executes the same accepted plan, and nothing changes until a person accepts.
 *
 * A repair the planner could not make valid is stored too, with its errors, so
 * the panel can say so; it cannot be accepted. A proposal that is already
 * pending — a repair of an earlier failure, or a plan the person generated —
 * is left alone: a pipeline failing every 15 seconds asks the planner once,
 * not every tick, and never overwrites what somebody is looking at.
 *
 * @param {{
 *   planner: Pick<import("./planner.js").Planner, "repair">,
 *   scheduler: Pick<import("../scheduler/client.js").SchedulerClient, "getSchedule" | "updateSchedule">,
 *   log?: Pick<Console, "log">,
 * }} deps
 * @returns {(failed: { run: { id: number }, schedule: object, outcome: { error?: string, steps?: object[] } }) => Promise<object | null>}
 *   The stored proposal, or null when there was nothing to do.
 */
export function repairer({ planner, scheduler, log = console }) {
  return async ({ run, schedule, outcome }) => {
    const current = (await scheduler.getSchedule(schedule.conversationId)) ?? schedule;
    if (!current.plan?.length) return null;
    if (current.proposal) {
      log.log(`[repair] run ${run.id} failed; schedule ${current.id} already has a proposal pending, so no new one`);
      return null;
    }

    const failed = { id: run.id, error: outcome.error ?? "The run failed without saying why." };
    const result = await planner.repair({ goal: current.goal ?? "", plan: current.plan, run: failed, steps: outcome.steps ?? [] });
    const proposal = {
      steps: result.steps,
      ...(result.notes ? { notes: result.notes } : {}),
      createdAt: result.createdAt,
      reason: "repair",
      run: failed,
      ...(result.ok ? {} : { errors: result.errors }),
    };
    await scheduler.updateSchedule(current.id, { proposal });
    log.log(`[repair] run ${run.id} failed; proposed a ${result.ok ? "" : "(still invalid) "}repair for schedule ${current.id}`);
    return proposal;
  };
}
