// A first message left without a due time (beta-p4-040, from beta-p4-050's review; README.md "The
// queue"; docs/runbook.md "A first message with no due time"): the acceptance found the sender
// account gone, or no weekday in its days, so message_1 stayed `planned` with `due_at` null. Each
// queue run, in the workspace's tenant run before it lists the due steps, gives such a step of an
// active enrollment whose connection request was accepted, or skipped as already connected (the
// same write, ../send/connected.ts, connect-already-connected), its due time once linkedin holds the
// account again and its days have a weekday: drawn as for an acceptance detected now
// (../acceptance.ts firstMessageDueAt), so no backlog falls due at once. Conditional on the step
// still `planned` without one, as the acceptance's own write is.
import { tenantClient } from "@whytide/db";
import { currentTenant } from "@whytide/platform";
import { type AccountHours, accountOf, firstMessageDueAt } from "../acceptance.ts";
import { random } from "../clock.ts";
import { ALREADY_CONNECTED } from "../send/constants.ts";
import { TEMPLATE_STEPS } from "../template/constants.ts";

const [INVITE, FIRST_MESSAGE] = TEMPLATE_STEPS;

/** The first messages given a due time at `at`. */
export async function recoverFirstMessages(at: Date): Promise<number> {
  const { workspaceId } = currentTenant();
  const stuck = await tenantClient.$queryRaw<{ id: string; sender_account_id: string }[]>`
    SELECT m.id, m.sender_account_id FROM step_executions m
    JOIN step_executions c ON c.workspace_id = m.workspace_id AND c.enrollment_id = m.enrollment_id
    JOIN enrollments e ON e.workspace_id = m.workspace_id AND e.id = m.enrollment_id
    WHERE m.workspace_id = ${workspaceId} AND m.step_key = ${FIRST_MESSAGE.stepKey}
      AND m.status = 'planned' AND m.due_at IS NULL AND e.status = 'active'
      AND c.step_key = ${INVITE.stepKey}
      AND (c.accepted_at IS NOT NULL OR (c.status = 'skipped' AND c.skip_reason = ${ALREADY_CONNECTED}))
    ORDER BY m.id`;
  const accounts = new Map<string, AccountHours | null>();
  let recovered = 0;
  for (const step of stuck) {
    const accountId = step.sender_account_id;
    if (!accounts.has(accountId)) accounts.set(accountId, await accountOf(accountId));
    const account = accounts.get(accountId) ?? null;
    const dueAt = account === null ? null : firstMessageDueAt(at, account, random);
    if (dueAt === null) continue;
    const where = { id: step.id, status: "planned", dueAt: null } as const;
    recovered += (await tenantClient.stepExecution.updateMany({ where, data: { dueAt } })).count;
  }
  return recovered;
}
