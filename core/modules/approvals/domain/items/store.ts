// What the items' commands and queries share (README.md "Public interface"): the input check, an
// item as they read it, and the sender accounts they read through linkedin, in the caller's tenant
// run. Nothing here logs.
import { findSenderAccount, errors as linkedinErrors, type SenderAccount } from "@whytide/linkedin";
import { AppError, isAppError } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";
import { type ActionType, FALLBACK_TIME_ZONE, ID_MAX, type ItemStatus } from "./constants.ts";

/** An id as the commands take one. */
export const id = z.string().min(1).max(ID_MAX);

/** An item as the commands and queries read it; `approval_items` holds no text. */
export type Item = {
  readonly id: string;
  readonly stepExecutionId: string;
  readonly personId: string;
  readonly senderAccountId: string;
  readonly actionType: ActionType;
  readonly stepKey: string;
  readonly draftId: string | null;
  readonly scheduledFor: Date;
  readonly status: ItemStatus;
  readonly approvedContentHash: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly waitCode: string | null;
  readonly waitUntil: Date | null;
  readonly createdAt: Date;
};

/** The columns of an Item, for a select. */
export const itemColumns = {
  id: true,
  stepExecutionId: true,
  personId: true,
  senderAccountId: true,
  actionType: true,
  stepKey: true,
  draftId: true,
  scheduledFor: true,
  status: true,
  approvedContentHash: true,
  decidedBy: true,
  decidedAt: true,
  waitCode: true,
  waitUntil: true,
  createdAt: true,
} as const;

/** The input as the schema reads it, or approvals_input_invalid naming the fields, no value. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
  throw new AppError(errors.approvals_input_invalid, { details: { fields } });
}

/** The sender account, or null once the workspace has none of the id. */
export async function senderOf(accountId: string): Promise<SenderAccount | null> {
  try {
    return await findSenderAccount(accountId);
  } catch (error) {
    if (isAppError(error) && error.code === linkedinErrors.sender_account_not_found) return null;
    throw error;
  }
}

/** Each account of the ids once, by id: one read per account, in the caller's run. */
export async function sendersOf(
  accountIds: Iterable<string>,
): Promise<Map<string, SenderAccount | null>> {
  const senders = new Map<string, SenderAccount | null>();
  for (const accountId of new Set(accountIds)) senders.set(accountId, await senderOf(accountId));
  return senders;
}

/** The zone the account's days are counted in: its own, else FALLBACK_TIME_ZONE. */
export const zoneOf = (sender: SenderAccount | null | undefined): string =>
  sender?.timeZone ?? FALLBACK_TIME_ZONE;

/** Whether the user owns the account: the one person who decides its items. */
export const owns = (sender: SenderAccount | null | undefined, userId: string): boolean =>
  sender !== null && sender !== undefined && sender.ownerUserId === userId;
