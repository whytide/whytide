// Enrolling an approved lead (docs/flows.md "Approve → enrollment"): the body of the subscriber to
// contacts.lead_approved (events.ts). It writes with the delivery's transaction, in which contacts'
// and linkedin's checks run too, with the lead locked from the start, and in this order: a
// redelivery, a person already enrolled and an erased person change nothing; a suppressed person gets
// an exited enrollment and no step; a lead no longer approved, nothing; an approver without a
// connected account, an exited enrollment and no step; anyone else an active enrollment with the
// template's four steps, all planned, and the lead in_campaign. A throw fails the delivery, which
// runs again from the top.
import { lockLeadStatus, recordLeadStatus, suppressionOf } from "@whytide/contacts";
import type { Prisma, TenantClient } from "@whytide/db";
import { senderOf } from "@whytide/linkedin";
import { currentTenant, newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import { checkedCode } from "../steps/codes.ts";
import { EXIT_DETAILS } from "../steps/constants.ts";
import { TEMPLATE_ID, TEMPLATE_VERSION } from "../template/constants.ts";
import { plannedSteps } from "./steps.ts";

/** An approval as contacts.lead_approved carries it, with the event's id. */
export type Approval = {
  readonly sourceEventId: string;
  readonly personId: string;
  readonly approvedBy: string;
};

/** What a delivery did: nothing (the first three, and not_approved), an exit, or an enrollment. */
export type EnrollOutcome =
  | "redelivered"
  | "enrolled_already"
  | "person_gone"
  | "suppressed"
  | "not_approved"
  | "no_sender"
  | "enrolled";

/** Enrolls the approved lead in the template, or records why not (the file's header). */
export async function enrollApproved(tx: TenantClient, approval: Approval): Promise<EnrollOutcome> {
  const { sourceEventId, personId, approvedBy } = approval;
  // The lead locked first: a block's change of the lead waits for this delivery's end, or this
  // delivery reads the block, its entry included, once it has committed.
  const lead = await lockLeadStatus(personId);
  if ((await tx.enrollment.count({ where: { sourceEventId } })) > 0) return "redelivered";
  const active = { personId, status: "active" } as const;
  if ((await tx.enrollment.count({ where: active })) > 0) return "enrolled_already";
  const suppression = await suppressionOf(personId, { newEnrollment: true });
  const gone = suppression.suppressed && suppression.reason === "person_not_found";
  if (lead === null || gone) return "person_gone";
  const now = new Date();
  const { workspaceId } = currentTenant();
  const enrollment = { id: newId(ids.enrollment), workspaceId, personId, sourceEventId };
  const template = { templateId: TEMPLATE_ID, templateVersion: TEMPLATE_VERSION };
  if (suppression.suppressed) {
    const exitDetail = checkedCode(EXIT_DETAILS, "exit_detail", suppression.reason);
    const exit = { status: "exited", exitReason: "suppressed", exitDetail, endedAt: now } as const;
    await insert(tx, { ...enrollment, ...template, ...exit });
    return "suppressed";
  }
  // Only an approved lead: one suppressed, in a campaign or done since Approve is left as it is.
  if (lead !== "approved") return "not_approved";
  const sender = await senderOf(approvedBy);
  if (sender === null) {
    const exit = { status: "exited", exitReason: "no_sender", endedAt: now } as const;
    await insert(tx, { ...enrollment, ...template, ...exit });
    return "no_sender";
  }
  const started = { senderAccountId: sender.id, status: "active", startedAt: now } as const;
  // Another delivery of the person may have enrolled them since the count: its row stands alone.
  if (!(await insert(tx, { ...enrollment, ...template, ...started }))) return "enrolled_already";
  const steps = plannedSteps({ ...enrollment, senderAccountId: sender.id }, now);
  await tx.stepExecution.createMany({ data: steps });
  await recordLeadStatus(personId, "in_campaign", {
    templateId: TEMPLATE_ID,
    actor: { type: "system" },
  });
  return "enrolled";
}

/**
 * Writes the enrollment unless one with its event, or the person's active one, is there, skipping a
 * conflict with either unique key; whether it was written.
 */
async function insert(tx: TenantClient, data: Prisma.EnrollmentCreateManyInput): Promise<boolean> {
  const { count } = await tx.enrollment.createMany({ data: [data], skipDuplicates: true });
  return count > 0;
}
