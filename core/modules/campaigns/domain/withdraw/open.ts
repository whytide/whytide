// The withdrawal job's run in one workspace (README.md "Withdrawals"; docs/flows.md "The
// withdrawal"), in its tenant run: for each active enrollment whose connection request went out at
// least INVITE_WITHDRAW_AFTER_DAYS ago and was not accepted, one withdraw step, `scheduled` and due
// now, with no approval item: a withdrawal sends nothing to the person. The job only writes rows;
// the plan, the gate, linkedin's reservation and its activity send it, as any step. Its key is the
// connection request's followed by WITHDRAW_KEY_SUFFIX, and the unique (workspace_id, enrollment_id,
// step_key) skips a second one, so a second run, or the next day's, opens none. The acceptance's
// accepted_at is read here, and again by the gate right before the call.
import { type Prisma, tenantClient } from "@whytide/db";
import { currentTenant, newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import { requireInstant } from "../gate/instant.ts";
import {
  INVITE_STEP,
  INVITE_WITHDRAW_AFTER_DAYS,
  MS_PER_DAY,
  WITHDRAW_KEY_SUFFIX,
  WITHDRAW_POSITION,
  WITHDRAW_STEP_KEY,
} from "./constants.ts";

const CONNECT = {
  enrollmentId: true,
  personId: true,
  senderAccountId: true,
  templateId: true,
  templateVersion: true,
  stepTemplateHash: true,
  idempotencyKey: true,
} as const;

/** The withdrawals opened at `at` in the run's workspace (the file's header): how many are new. */
export async function openWithdrawals(at: Date): Promise<{ opened: number }> {
  const now = requireInstant(at, "at");
  const sentBy = new Date(now.getTime() - INVITE_WITHDRAW_AFTER_DAYS * MS_PER_DAY);
  // The active enrollments first: an ended one's connection request stays unaccepted for good.
  const active = await tenantClient.enrollment.findMany({
    where: { status: "active" },
    select: { id: true },
  });
  if (active.length === 0) return { opened: 0 };
  // The steps in a query of their own: the tenant client refuses a relation in a query.
  const invites = await tenantClient.stepExecution.findMany({
    where: {
      enrollmentId: { in: active.map(({ id }) => id) },
      stepKey: INVITE_STEP.stepKey,
      status: "succeeded",
      acceptedAt: null,
      executedAt: { lte: sentBy },
    },
    orderBy: [{ executedAt: "asc" }, { id: "asc" }],
    select: CONNECT,
  });
  if (invites.length === 0) return { opened: 0 };
  const { workspaceId } = currentTenant();
  const rows: Prisma.StepExecutionCreateManyInput[] = invites.map((invite) => ({
    ...invite,
    id: newId(ids.step_execution),
    workspaceId,
    stepKey: WITHDRAW_STEP_KEY,
    position: WITHDRAW_POSITION,
    actionType: "withdraw",
    idempotencyKey: `${invite.idempotencyKey}${WITHDRAW_KEY_SUFFIX}`,
    status: "scheduled",
    dueAt: now,
  }));
  // ON CONFLICT DO NOTHING: an enrollment with its withdraw step already keeps that one.
  const { count } = await tenantClient.stepExecution.createMany({
    data: rows,
    skipDuplicates: true,
  });
  return { opened: count };
}
