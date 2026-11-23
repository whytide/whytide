// A reply's row (README.md "Replies from the inbox"), in the caller's tenant run: read by its id, a
// reply's only, and settled refused or failed with its code, a registered one or none, once: a row
// settled already, or erased meanwhile, changes nothing.
import { tenantClient } from "@whytide/db";
import { registeredErrors } from "@whytide/platform";
import type { SendStatus } from "./constants.ts";

export type ReplyRow = {
  readonly id: string;
  readonly threadId: string;
  readonly personId: string;
  /** Personal data: the member's words, for the request file only. */
  readonly body: string;
  readonly sendStatus: SendStatus;
};

/** The reply's row, or null for no reply of the id: none, another message, or erased. */
export async function replyRow(messageId: string): Promise<ReplyRow | null> {
  // Prisma drops an undefined value from a where: unchecked, that would be any message.
  if (typeof messageId !== "string" || messageId === "") return null;
  const row = await tenantClient.message.findFirst({
    where: { id: messageId, sendStatus: { not: null } },
    select: { id: true, threadId: true, personId: true, body: true, sendStatus: true },
  });
  return row === null || row.sendStatus === null ? null : { ...row, sendStatus: row.sendStatus };
}

/** The sending row refused before the call or failed after it, with the code when registered. */
export async function settleRow(
  messageId: string,
  status: "refused" | "failed",
  code: string | null,
): Promise<void> {
  const errorCode = code !== null && registeredErrors().has(code) ? code : null;
  await tenantClient.message.updateMany({
    where: { id: messageId, sendStatus: "sending" },
    data: { sendStatus: status, errorCode },
  });
}
