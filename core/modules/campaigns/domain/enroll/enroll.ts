// Enrolling an approved lead (docs/flows.md "Approve → enrollment"): the body of the subscriber to
// contacts.lead_approved (events.ts). It writes with the delivery's transaction, in which contacts'
// and linkedin's checks run too, with the lead locked from the start, and in this order: a
// redelivery, a person already enrolled, a person in a not-interested reply's cool-down (gamma-p4-050,
// ../replies/) and an erased person change nothing; a suppressed person gets an exited enrollment
// and no step; a lead no longer approved, nothing; a campaign owner without a connected account, or
// no longer an active member (exit_detail owner_removed), an exited enrollment and no step; anyone
// else an active enrollment with a step per step of the version, all planned, and the lead
// in_campaign. Every enrollment written joins the current version of the campaign routing chose
// (gamma-p3-065, route.ts), read under the lead's lock before those checks, which it changes none
// of: an agent's lead its agent's campaign, any other lead the seeded campaign
// (../campaigns/commands.ts seededEnrollment, which seeds the campaign on first use, gamma-p3-030);
// template_id its key_ref, template_version its version_no. It sends from the campaign owner's
// account, never the approver's (gamma-p6-040): the agent's owner's, or the seeded campaign's, the
// workspace's Owner's; an enrollment made before keeps its own. An enrollment in a draft or paused
// campaign waits for its launch or resume (../pause/). A throw fails the delivery, which runs again
// from the top.
import { lockLeadStatus, recordLeadStatus, suppressionOf } from "@whytide/contacts";
import type { Prisma, TenantClient } from "@whytide/db";
import { senderOf } from "@whytide/linkedin";
import { currentTenant, newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import { seededEnrollment } from "../campaigns/commands.ts";
import { versionOf } from "../campaigns/reads.ts";
import { LIVE_ENROLLMENT_STATUSES } from "../constants.ts";
import { isActiveMember } from "../owner.ts";
import { checkedCode } from "../steps/codes.ts";
import { EXIT_DETAILS } from "../steps/constants.ts";
import { routedCampaign } from "./route.ts";
import { plannedSteps } from "./steps.ts";

/** An approval as contacts.lead_approved carries it, with the event's id. */
export type Approval = {
  readonly sourceEventId: string;
  readonly personId: string;
  /** Who approved: never whose account sends (gamma-p6-040). */
  readonly approvedBy: string;
};

/** What a delivery did: nothing (the first three, and not_approved), an exit, or an enrollment. */
export type EnrollOutcome =
  | "redelivered"
  | "enrolled_already"
  | "cool_down"
  | "person_gone"
  | "suppressed"
  | "not_approved"
  | "no_sender"
  | "enrolled";

/** Enrolls the approved lead in its campaign's version, or records why not (the file's header). */
export async function enrollApproved(tx: TenantClient, approval: Approval): Promise<EnrollOutcome> {
  const { sourceEventId, personId } = approval;
  // The lead locked first: a block's change of the lead waits for this delivery's end, or this
  // delivery reads the block, its entry included, once it has committed.
  const lead = await lockLeadStatus(personId);
  // The campaign, read under the lock (route.ts): the lead's, when there is one to read.
  const routed = lead === null ? null : await routedCampaign(personId);
  if ((await tx.enrollment.count({ where: { sourceEventId } })) > 0) return "redelivered";
  // A paused enrollment is live too: the person has one at most (gamma-p3-060).
  const active = { personId, status: { in: [...LIVE_ENROLLMENT_STATUSES] } };
  if ((await tx.enrollment.count({ where: active })) > 0) return "enrolled_already";
  const now = new Date();
  // A not-interested reply blocks a new enrollment until its cool-down ends: no row, as above.
  const coolingDown = { personId, coolDownUntil: { gt: now } };
  if ((await tx.enrollment.count({ where: coolingDown })) > 0) return "cool_down";
  const suppression = await suppressionOf(personId, { newEnrollment: true });
  const gone = suppression.suppressed && suppression.reason === "person_not_found";
  if (lead === null || gone) return "person_gone";
  const { version, ownerUserId } =
    routed === null
      ? await seededEnrollment()
      : {
          version: await versionOf(routed, routed.currentVersionId),
          ownerUserId: routed.ownerUserId,
        };
  const { workspaceId } = currentTenant();
  const enrollment = { id: newId(ids.enrollment), workspaceId, personId, sourceEventId };
  const template = { templateId: version.keyRef, templateVersion: version.versionNo };
  if (suppression.suppressed) {
    const exitDetail = checkedCode(EXIT_DETAILS, "exit_detail", suppression.reason);
    const exit = { status: "exited", exitReason: "suppressed", exitDetail, endedAt: now } as const;
    await insert(tx, { ...enrollment, ...template, ...exit });
    return "suppressed";
  }
  // Only an approved lead: one suppressed, in a campaign or done since Approve is left as it is.
  if (lead !== "approved") return "not_approved";
  // The campaign owner's account, while the owner is an active member: never the approver's.
  const removed = ownerUserId !== null && !(await isActiveMember(ownerUserId));
  const sender = ownerUserId === null || removed ? null : await senderOf(ownerUserId);
  if (sender === null) {
    const exitDetail = removed ? checkedCode(EXIT_DETAILS, "exit_detail", "owner_removed") : null;
    const exit = { status: "exited", exitReason: "no_sender", exitDetail, endedAt: now } as const;
    await insert(tx, { ...enrollment, ...template, ...exit });
    return "no_sender";
  }
  const started = { senderAccountId: sender.id, status: "active", startedAt: now } as const;
  // Another delivery of the person may have enrolled them since the count: its row stands alone.
  if (!(await insert(tx, { ...enrollment, ...template, ...started }))) return "enrolled_already";
  const steps = plannedSteps({ ...enrollment, senderAccountId: sender.id }, now, version);
  await tx.stepExecution.createMany({ data: steps });
  await recordLeadStatus(personId, "in_campaign", {
    templateId: version.keyRef,
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
