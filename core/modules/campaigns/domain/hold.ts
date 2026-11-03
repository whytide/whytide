// The hold on reply (README.md "The hold on reply"; architecture §14.3): a reply holds every pending
// step of the person, in every enrollment, blocks their pending items in "Up next", ends each active
// enrollment as replied and records the lead's reply, all in the caller's transaction (inbox's store,
// beta-p5-010; the gate's reply check), so the reply and the hold commit together or not at all.
// Held steps keep their rows, so gamma can resume them. An executing step is the sender's, whose gate
// runs again before the call.
import { cancelItems } from "@whytide/approvals";
import { errors as contactsErrors, lockLeadStatus, recordLeadStatus } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";
import { PENDING_STEP_STATUSES } from "./gate/constants.ts";
import { requireInstant } from "./gate/instant.ts";
import { checkedCode } from "./steps/codes.ts";
import { STEP_REASON_CODES } from "./steps/constants.ts";

/**
 * Ends each active enrollment of the person as `replied` at `at`, holds their pending steps (`held`,
 * `skip_reason` replied) with their pending items blocked (approvals' cancelItems) and moves their
 * lead to `replied`, unless it is suppressed, in the caller's tenant run; the ids of the steps it
 * held. A second call changes nothing and records no second status change. person_not_found for no
 * id, before any write.
 */
export async function holdForReply(personId: string, options: { at: Date }): Promise<string[]> {
  // Prisma drops an undefined value from a where: unchecked, that would be every person's steps.
  if (typeof personId !== "string" || personId.trim() === "") {
    throw new AppError(contactsErrors.person_not_found);
  }
  const at = requireInstant(options?.at, "at");
  const skipReason = checkedCode(STEP_REASON_CODES, "skip_reason", "replied");
  // The lead first, as the enrollment locks it (enroll/enroll.ts), so a reply racing an approval's
  // delivery holds the enrollment it makes; then the enrollments, then the steps.
  const lead = await lockLeadStatus(personId);
  await tenantClient.enrollment.updateMany({
    where: { personId, status: "active" },
    data: { status: "replied", endedAt: at },
  });
  const held = await tenantClient.stepExecution.updateManyAndReturn({
    where: { personId, status: { in: [...PENDING_STEP_STATUSES] } },
    data: { status: "held", skipReason },
    select: { id: true },
  });
  // A press in "Up next" after this finds the item decided: approval_item_not_pending.
  await cancelItems(held.map(({ id }) => id));
  // A never-contact entry or an opt-out outranks the reply: a suppressed lead stays suppressed.
  if (lead !== null && lead !== "suppressed") {
    await recordLeadStatus(personId, "replied", { actor: { type: "system" } });
  }
  return held.map(({ id }) => id);
}
