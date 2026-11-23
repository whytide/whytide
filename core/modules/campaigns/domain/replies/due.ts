// What the reply actions leave due at the queue run's start (README.md "Reply actions"; docs/flows.md
// "A reply's label"; workflows/index.ts campaigns_due_steps), each in the workspace's tenant run.
// First, in the run of gamma-p3-060's resumeDueEnrollments and before it: each paused enrollment
// whose time has come and whose person is suppressed now is exited, the lead then the enrollment
// locked before the suppression is read, as the suppression subscriber would exit it, so a
// suppression whose delivery has not run yet never sees the enrollment resumed. Then the not-now
// reminders: each enrollment whose remind_at has come and whose reminder has not gone gets
// reminded_at and publishes campaigns.reply_notice_due (not_now, for remind_user_id), both
// conditioned on reminded_at still null, so a reminder is published once; the notice's run mails it.
import { lockLeadStatus, suppressionOf } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { currentTenant, publish } from "@whytide/platform";
import { events } from "../../events.ts";
import { requireInstant } from "../gate/instant.ts";
import { exitSuppressed } from "../gate/suppressed.ts";
import { checkedCode } from "../steps/codes.ts";
import { STEP_REASON_CODES } from "../steps/constants.ts";
import { lockEnrollment } from "../steps/skip.ts";

/** The paused enrollments due by `at` whose person is suppressed, exited instead: how many. */
export async function exitSuppressedDue(at: Date): Promise<number> {
  const now = requireInstant(at, "at");
  const due = await tenantClient.enrollment.findMany({
    where: { status: "paused", pausedUntil: { lte: now } },
    select: { id: true, personId: true },
    orderBy: { id: "asc" },
  });
  let exited = 0;
  for (const { id, personId } of due) {
    await lockLeadStatus(personId);
    await lockEnrollment(tenantClient, id);
    const suppression = await suppressionOf(personId, { newEnrollment: false });
    if (!suppression.suppressed) continue;
    const reason = checkedCode(STEP_REASON_CODES, "skip_reason", suppression.reason);
    await exitSuppressed(tenantClient, { enrollmentId: id, personId, reason, at: now });
    exited += 1;
  }
  return exited;
}

/** The reminders due by `at` marked sent and their notices published: how many. */
export async function publishDueReminders(at: Date): Promise<number> {
  const now = requireInstant(at, "at");
  const due = await tenantClient.enrollment.findMany({
    where: { remindAt: { lte: now }, remindedAt: null },
    select: { id: true, personId: true, remindUserId: true },
    orderBy: [{ remindAt: "asc" }, { id: "asc" }],
  });
  const { workspaceId } = currentTenant();
  let published = 0;
  for (const { id, personId, remindUserId } of due) {
    // The CHECK enrollments_remind sets the user with the instant.
    if (remindUserId === null) continue;
    const { count } = await tenantClient.enrollment.updateMany({
      where: { id, remindAt: { lte: now }, remindedAt: null },
      data: { remindedAt: now },
    });
    if (count === 0) continue;
    const notice = { enrollmentId: id, personId, kind: "not_now", threadId: null } as const;
    await publish(outboxWriter(tenantClient, workspaceId), events["campaigns.reply_notice_due"], {
      ...notice,
      ownerUserId: remindUserId,
    });
    published += 1;
  }
  return published;
}
