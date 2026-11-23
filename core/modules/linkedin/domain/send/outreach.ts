// The person's outreach row as the sends keep it (docs/data.md "sender_outreach"), in the caller's run:
// what a send or its check got from the provider, keyed by account and person, naming the step that
// sent last; the reply linkedin_check_reply finds; and sentMessageRef, inbox's match for the echo of a
// sent message (beta-p5-020), a reply from the inbox's too, with its time (gamma-p4-060). Provider
// refs stay here: no answer, event or log line carries one.
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { ids } from "../../ids.ts";
import { SEND_REF } from "../../schemas/quota.ts";

export type Outreach = {
  readonly id: string;
  readonly providerMemberRef: string | null;
  readonly providerChatRef: string | null;
  readonly providerInvitationRef: string | null;
  readonly lastSentAt: Date | null;
};
/** The send's step, as its request file names it. */
export type SentStep = {
  readonly accountId: string;
  readonly personId: string;
  readonly memberRef: string;
  readonly stepExecutionId: string;
};
/**
 * What went out, at the provider's time. `found`: the check saw an invite or a withdrawal, without
 * its ref or its time, so the row's time is set only where none is.
 */
export type Sent =
  | {
      readonly actionType: "message";
      readonly at: Date;
      readonly messageRef: string;
      readonly chatRef: string;
    }
  | {
      readonly actionType: "invite" | "withdraw";
      readonly at: Date;
      readonly invitationRef?: string;
      readonly found: boolean;
    };
const SHOWN = {
  id: true,
  providerMemberRef: true,
  providerChatRef: true,
  providerInvitationRef: true,
  lastSentAt: true,
} as const;

/** The account's row for the person, or null. */
export function outreachOf(accountId: string, personId: string): Promise<Outreach | null> {
  return tenantClient.senderOutreach.findFirst({
    where: { senderAccountId: accountId, personId },
    select: SHOWN,
  });
}

/** The send on the person's row, made when missing, as the step that sent last. */
export async function recordSend(step: SentStep, sent: Sent): Promise<void> {
  const key = { senderAccountId: step.accountId, personId: step.personId };
  const row = { id: newId(ids.sender_outreach), workspaceId: currentTenant().workspaceId, ...key };
  // ON CONFLICT DO NOTHING: the receiver or a twin may have made it meanwhile.
  await tenantClient.senderOutreach.createMany({ data: [row], skipDuplicates: true });
  const base = { providerMemberRef: step.memberRef, lastStepExecutionId: step.stepExecutionId };
  if (sent.actionType === "message") {
    const { chatRef, messageRef, at } = sent;
    const data = { ...base, providerChatRef: chatRef, lastMessageRef: messageRef, lastSentAt: at };
    await tenantClient.senderOutreach.updateMany({ where: key, data });
    return;
  }
  // sentMessageRef answers a message step only.
  const { invitationRef } = sent;
  const ref = invitationRef === undefined ? {} : { providerInvitationRef: invitationRef };
  const data = { ...base, ...ref, lastMessageRef: null };
  await tenantClient.senderOutreach.updateMany({ where: key, data });
  const invite = sent.actionType === "invite";
  const unset = invite ? { invitedAt: null } : { withdrawnAt: null };
  const where = sent.found ? { ...key, ...unset } : key;
  const time = invite ? { invitedAt: sent.at } : { withdrawnAt: sent.at };
  await tenantClient.senderOutreach.updateMany({ where, data: time });
}

/** The person's message at `at` on the row, never an earlier one's (as the receiver's). */
export async function markReplied(id: string, at: Date): Promise<void> {
  const later = [{ lastInboundAt: null }, { lastInboundAt: { lt: at } }];
  await tenantClient.senderOutreach.updateMany({
    where: { id, OR: later },
    data: { lastInboundAt: at },
  });
}

/**
 * The message ref and the chat ref of the row whose last send was the step's message, or the inbox
 * reply's (SEND_REF), with the provider's time when the row holds one; else null, in the caller's
 * tenant run. read_input_invalid for an id that is neither.
 */
export async function sentMessageRef(
  stepExecutionId: string,
): Promise<{ messageRef: string; chatRef: string; sentAt: Date | null } | null> {
  // Prisma drops an undefined value from a where: unchecked, that would be any row of the workspace.
  if (typeof stepExecutionId !== "string" || !SEND_REF.test(stepExecutionId)) {
    throw new AppError(errors.read_input_invalid, { details: { fields: ["stepExecutionId"] } });
  }
  const row = await tenantClient.senderOutreach.findFirst({
    where: { lastStepExecutionId: stepExecutionId },
    select: { lastMessageRef: true, providerChatRef: true, lastSentAt: true },
  });
  const { lastMessageRef: messageRef, providerChatRef: chatRef, lastSentAt: sentAt } = row ?? {};
  return messageRef && chatRef ? { messageRef, chatRef, sentAt: sentAt ?? null } : null;
}
