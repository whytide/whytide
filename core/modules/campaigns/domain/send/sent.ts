// A step's send as others read it once it went out (README.md "Public interface"), in the caller's
// tenant run: ids, the action and the time only, never a text.
import { tenantClient } from "@whytide/db";
import type { ActionType } from "../constants.ts";

export type SentStep = {
  readonly personId: string;
  readonly senderAccountId: string;
  readonly actionType: ActionType;
  readonly executedAt: Date;
  readonly approvalItemId: string | null;
  readonly draftId: string | null;
};

/** The step's send, when it is `succeeded`; null for any other step, or no step of the workspace. */
export async function sentStep(stepExecutionId: string): Promise<SentStep | null> {
  // Prisma drops an undefined value from a where: unchecked, that would be any step.
  if (typeof stepExecutionId !== "string" || stepExecutionId === "") return null;
  const row = await tenantClient.stepExecution.findFirst({
    where: { id: stepExecutionId, status: "succeeded" },
    select: {
      personId: true,
      senderAccountId: true,
      actionType: true,
      executedAt: true,
      approvalItemId: true,
      draftId: true,
    },
  });
  if (row?.executedAt == null) return null;
  return { ...row, executedAt: row.executedAt };
}
