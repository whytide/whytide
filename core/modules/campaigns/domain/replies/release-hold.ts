// The hold released (README.md "Reply actions"; docs/flows.md "A reply's label"): an out-of-office
// reply's way back into the sequence, in the caller's tenant run, under the locks it took (the lead,
// then the enrollment). The suppression is read first: a person suppressed now is exited, their held
// steps cancelled with the reason, and nothing released (nothing lifts a suppression). The hold
// stays when no release could end well: another live enrollment of the person (one at most), a reply
// newer than this one on the sender's outreach row, or a held step whose item was approved, which
// approvals answers again as it is and messaging cannot approve twice, so no new approval would
// follow. Otherwise the enrollment is `active` again, resumed at `at`, after which the gate's reply
// check counts replies, and its held steps wait again: `planned`, so the queue opens a new item and
// its approval for each, and the gate checks each before any send; a withdrawal, which needs none,
// `scheduled` for the plan. A step with a due time is due no earlier than `firstDueAt`; one without
// waits for its anchor, as before the hold: the step before it sent (by the version's delays), or
// the acceptance.
import { cancelItems, decisionsFor } from "@whytide/approvals";
import { lockLeadStatus, recordLeadStatus, suppressionOf } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { lastInboundAt } from "@whytide/linkedin";
import { LIVE_ENROLLMENT_STATUSES } from "../constants.ts";
import { requireInstant } from "../gate/instant.ts";
import { needsApproval } from "../steps/actions.ts";
import { checkedCode } from "../steps/codes.ts";
import { EXIT_DETAILS, STEP_REASON_CODES } from "../steps/constants.ts";

/** What a release did: the enrollment active again, exited as suppressed, or left held. */
export type Release = "released" | "exited_suppressed" | "kept_held";

type Held = { readonly id: string; readonly actionType: string; readonly dueAt: Date | null };
type Replied = {
  readonly id: string;
  readonly personId: string;
  readonly senderAccountId: string | null;
  readonly templateId: string;
};

/** A released step's columns: no reason, no place in a day, no item until the queue opens one. */
const RELEASED = {
  skipReason: null,
  errorCode: null,
  scheduledFor: null,
  quotaDay: null,
  approvalItemId: null,
} as const;

/** The `replied` enrollment's hold released, or why not (the file's header). */
export async function releaseHold(
  enrollmentId: string,
  options: { readonly at: Date; readonly firstDueAt: Date },
): Promise<Release> {
  const at = requireInstant(options?.at, "at");
  const firstDueAt = requireInstant(options?.firstDueAt, "firstDueAt");
  const enrollment = await tenantClient.enrollment.findFirst({
    where: { id: enrollmentId, status: "replied" },
    select: { id: true, personId: true, senderAccountId: true, templateId: true },
  });
  if (enrollment === null) return "kept_held";
  const held = await tenantClient.stepExecution.findMany({
    where: { enrollmentId, status: "held" },
    select: { id: true, actionType: true, dueAt: true },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  const suppression = await suppressionOf(enrollment.personId, { newEnrollment: false });
  if (suppression.suppressed) {
    await exitSuppressed(enrollment, held, suppression.reason, at);
    return "exited_suppressed";
  }
  if (await keepsHold(enrollment, held, at)) return "kept_held";

  await tenantClient.enrollment.updateMany({
    where: { id: enrollmentId, status: "replied" },
    data: { status: "active", endedAt: null, resumedAt: at },
  });
  for (const step of held) {
    const status = needsApproval(step.actionType) ? "planned" : "scheduled";
    const dueAt =
      step.dueAt === null ? null : new Date(Math.max(step.dueAt.getTime(), firstDueAt.getTime()));
    await tenantClient.stepExecution.updateMany({
      where: { id: step.id, status: "held" },
      data: { status, dueAt, ...RELEASED },
    });
  }
  const lead = await lockLeadStatus(enrollment.personId);
  if (lead !== null && lead !== "suppressed") {
    await recordLeadStatus(enrollment.personId, "in_campaign", {
      templateId: enrollment.templateId,
      actor: { type: "system" },
    });
  }
  return "released";
}

/** The enrollment `exited` (`suppressed`, the reason), its held steps cancelled, items blocked. */
async function exitSuppressed(
  enrollment: Replied,
  held: readonly Held[],
  code: string,
  at: Date,
): Promise<void> {
  const exitDetail = checkedCode(EXIT_DETAILS, "exit_detail", code);
  const skipReason = checkedCode(STEP_REASON_CODES, "skip_reason", code);
  await tenantClient.enrollment.updateMany({
    where: { id: enrollment.id, status: "replied" },
    data: { status: "exited", exitReason: "suppressed", exitDetail, endedAt: at },
  });
  const ids = held.map(({ id }) => id);
  await tenantClient.stepExecution.updateMany({
    where: { id: { in: ids }, status: "held" },
    data: { status: "cancelled", skipReason },
  });
  await cancelItems(ids);
}

/** Whether the hold stays (the file's header): another live enrollment, a newer reply, an approval. */
async function keepsHold(enrollment: Replied, held: readonly Held[], at: Date): Promise<boolean> {
  const { id, personId, senderAccountId } = enrollment;
  const live = { personId, status: { in: [...LIVE_ENROLLMENT_STATUSES] }, id: { not: id } };
  if ((await tenantClient.enrollment.count({ where: live })) > 0) return true;
  // A replied enrollment began with its sender: one without fails closed.
  if (senderAccountId === null) return true;
  const inbound = await lastInboundAt(senderAccountId, personId);
  if (inbound !== null && inbound > at) return true;
  const decisions = await decisionsFor(held.map((step) => step.id));
  return decisions.some(({ status }) => status === "approved");
}
