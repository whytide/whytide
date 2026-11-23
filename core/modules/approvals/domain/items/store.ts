// What the items' commands and queries share (README.md "Public interface"): the input check, an
// item as they read it, and its sender, read through linkedin (an account) or email (a mailbox, on
// an email item, gamma-p4-090), in the caller's tenant run; who owns it, and the items of a member's
// own senders (gamma-p6-050). Nothing here logs.
import { findMailbox } from "@whytide/email";
import { findSenderAccount, errors as linkedinErrors } from "@whytide/linkedin";
import { AppError, isAppError } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";
import {
  type ActionType,
  type ApprovalBy,
  type Channel,
  type DecisionOrigin,
  EMAIL_ACTION,
  FALLBACK_TIME_ZONE,
  ID_MAX,
  type ItemStatus,
} from "./constants.ts";

/** An id as the commands take one. */
export const id = z.string().min(1).max(ID_MAX);

/** An item as the commands and queries read it; `approval_items` holds no text. */
export type Item = {
  readonly id: string;
  readonly stepExecutionId: string;
  readonly personId: string;
  /** linkedin's account; null on an email item, whose sender is its mailbox. */
  readonly senderAccountId: string | null;
  readonly mailboxId: string | null;
  readonly actionType: ActionType;
  readonly stepKey: string;
  readonly draftId: string | null;
  readonly scheduledFor: Date;
  readonly status: ItemStatus;
  readonly approvedContentHash: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly decisionOrigin: DecisionOrigin | null;
  readonly waitCode: string | null;
  readonly waitUntil: Date | null;
  readonly approvalBy: ApprovalBy;
  readonly createdAt: Date;
};

/** The columns of an Item, for a select. */
export const itemColumns = {
  id: true,
  stepExecutionId: true,
  personId: true,
  senderAccountId: true,
  mailboxId: true,
  actionType: true,
  stepKey: true,
  draftId: true,
  scheduledFor: true,
  status: true,
  approvedContentHash: true,
  decidedBy: true,
  decidedAt: true,
  decisionOrigin: true,
  waitCode: true,
  waitUntil: true,
  approvalBy: true,
  createdAt: true,
} as const;

/** The input as the schema reads it, or approvals_input_invalid naming the fields, no value. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
  throw new AppError(errors.approvals_input_invalid, { details: { fields } });
}

/** Who an item goes out from: linkedin's account, or email's mailbox, by its address. */
export type Sender = {
  readonly id: string;
  /** `linkedin` for an account, `email` for a mailbox. */
  readonly channel: Channel;
  readonly ownerUserId: string;
  readonly label: string;
  readonly timeZone: string;
};
/** An item's sender as its row names it. */
export type SenderRef = {
  readonly senderAccountId: string | null;
  readonly mailboxId: string | null;
};

/** The item's channel: an email's from its mailbox, else LinkedIn's. */
export const channelOf = ({ actionType }: { readonly actionType: ActionType }): Channel =>
  actionType === EMAIL_ACTION ? "email" : "linkedin";

/** The id the item's sender goes by: its mailbox's, else its account's (their prefixes differ). */
export const senderIdOf = ({ senderAccountId, mailboxId }: SenderRef): string =>
  mailboxId ?? senderAccountId ?? "";

/** The item's sender, or null once the workspace has none of the id. */
export async function senderOf(ref: SenderRef): Promise<Sender | null> {
  if (ref.mailboxId !== null) {
    const mailbox = await findMailbox(ref.mailboxId);
    if (mailbox === null) return null;
    const { id, ownerUserId, emailAddress: label, timeZone } = mailbox;
    return { id, channel: "email", ownerUserId, label, timeZone };
  }
  if (ref.senderAccountId === null) return null;
  try {
    const { id, ownerUserId, label, timeZone } = await findSenderAccount(ref.senderAccountId);
    return { id, channel: "linkedin", ownerUserId, label, timeZone };
  } catch (error) {
    if (isAppError(error) && error.code === linkedinErrors.sender_account_not_found) return null;
    throw error;
  }
}

/** Each sender of the items once, by its id (senderIdOf): one read per sender, in the caller's run. */
export async function sendersOf(refs: Iterable<SenderRef>): Promise<Map<string, Sender | null>> {
  const senders = new Map<string, Sender | null>();
  for (const ref of refs) {
    const key = senderIdOf(ref);
    if (!senders.has(key)) senders.set(key, await senderOf(ref));
  }
  return senders;
}

/** The zone the sender's days are counted in: its own, else FALLBACK_TIME_ZONE. */
export const zoneOf = (sender: Sender | null | undefined): string =>
  sender?.timeZone ?? FALLBACK_TIME_ZONE;

/** Whether the user owns the sender: the one person who decides its items. */
export const owns = (sender: Sender | null | undefined, userId: string): sender is Sender =>
  sender !== null && sender !== undefined && sender.ownerUserId === userId;

/** The items of the senders, as a where: an account's by its id, an email's by its mailbox's. */
export const sentFrom = (senders: readonly Sender[]) => {
  const idsOf = (channel: Channel) =>
    senders.filter((sender) => sender.channel === channel).map(({ id }) => id);
  return {
    OR: [{ senderAccountId: { in: idsOf("linkedin") } }, { mailboxId: { in: idsOf("email") } }],
  };
};
