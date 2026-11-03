// The reply signal (README.md "The webhook"): the time of the latest message a person sent the
// account, which the receiver sets in the run that publishes it, so campaigns' gate never reads a
// reply whose event does not exist, or the reverse.
import { tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";
import { errors } from "../../errors.ts";

/**
 * The latest inbound message's time from the person to the account, or null when none came, in the
 * caller's tenant run: another workspace's rows are not read. read_input_invalid for an empty id.
 */
export async function lastInboundAt(accountId: string, personId: string): Promise<Date | null> {
  // Prisma drops an undefined value from a where: unchecked, that would be any row of the workspace.
  const fields = Object.entries({ accountId, personId })
    .filter(([, id]) => typeof id !== "string" || id === "")
    .map(([field]) => field);
  if (fields.length > 0) throw new AppError(errors.read_input_invalid, { details: { fields } });
  const row = await tenantClient.senderOutreach.findFirst({
    where: { senderAccountId: accountId, personId },
    select: { lastInboundAt: true },
  });
  return row?.lastInboundAt ?? null;
}
