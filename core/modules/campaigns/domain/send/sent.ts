// A step's send as others read it once it went out (README.md "Public interface"), in the caller's
// tenant run: ids, the action and the time only, never a text. LinkedIn's sends only: an email
// step's is none of them (gamma-p3-030).
import { tenantClient } from "@whytide/db";
import type { LinkedInAction } from "../constants.ts";
import { linkedinActionType, linkedinOnly, linkedinSenderAccount } from "../steps/actions.ts";

export type SentStep = {
  readonly personId: string;
  readonly senderAccountId: string;
  readonly actionType: LinkedInAction;
  readonly executedAt: Date;
  readonly approvalItemId: string | null;
  readonly draftId: string | null;
};

/** The LinkedIn step's send, when it is `succeeded`; null for any other, or none of the workspace. */
export async function sentStep(stepExecutionId: string): Promise<SentStep | null> {
  // Prisma drops an undefined value from a where: unchecked, that would be any step.
  if (typeof stepExecutionId !== "string" || stepExecutionId === "") return null;
  const row = await tenantClient.stepExecution.findFirst({
    where: { id: stepExecutionId, status: "succeeded", ...linkedinOnly() },
    select: {
      id: true,
      personId: true,
      senderAccountId: true,
      actionType: true,
      executedAt: true,
      approvalItemId: true,
      draftId: true,
    },
  });
  if (row?.executedAt == null) return null;
  const { personId, executedAt, approvalItemId, draftId } = row;
  const senderAccountId = linkedinSenderAccount(row);
  return {
    personId,
    senderAccountId,
    actionType: linkedinActionType(row),
    executedAt,
    approvalItemId,
    draftId,
  };
}
