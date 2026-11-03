// Whether the connection request a withdrawal takes back was accepted (README.md "Withdrawals"):
// the acceptance's accepted_at on the enrollment's connect step (../acceptance.ts), read in the
// caller's tenant run with no cache, by the gate before the claim and right before the call, and by
// the settle. An accepted one is never withdrawn, and its enrollment goes on.
import { tenantClient } from "@whytide/db";
import { INVITE_STEP } from "./constants.ts";

/** When the enrollment's connection request was accepted; null when it was not. */
export async function inviteAcceptedAt(enrollmentId: string): Promise<Date | null> {
  const invite = await tenantClient.stepExecution.findFirst({
    where: { enrollmentId, stepKey: INVITE_STEP.stepKey },
    select: { acceptedAt: true },
  });
  return invite?.acceptedAt ?? null;
}
