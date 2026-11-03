// linkedin's step of the deletion script (core/modules/privacy README.md "Erasers"), which privacy
// registers: the person's outreach rows and the action-log rows that name the person's id. The raw
// message files hold no person id and expire within 72 hours (docs/data.md).
import { tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";
import { errors } from "../errors.ts";

/** Deletes the person's rows in the caller's tenant run; the rows deleted, by table. */
export async function erasePerson(
  personId: string,
): Promise<{ sender_outreach: number; sender_action_log: number }> {
  // Prisma drops an undefined value from a where: unchecked, that would be every row of the workspace.
  if (typeof personId !== "string" || personId.trim() === "") {
    throw new AppError(errors.read_input_invalid, { details: { fields: ["personId"] } });
  }
  const outreach = await tenantClient.senderOutreach.deleteMany({ where: { personId } });
  const log = await tenantClient.senderActionLog.deleteMany({ where: { objectRef: personId } });
  return { sender_outreach: outreach.count, sender_action_log: log.count };
}
