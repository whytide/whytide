// The message writes (README.md "The store", "The platform's own messages"), in the caller's tenant
// run: a message once per provider message, the person's or the account's, its text in `body` only;
// the account's either the campaign's, with its step and approval, or the user's, typed by hand.
import { tenantClient } from "@whytide/db";
import { currentTenant, newId } from "@whytide/platform";
import { ids } from "../../ids.ts";

export type InboundMessage = {
  readonly threadId: string;
  readonly personId: string;
  /** Personal data: this column only, never an event, an input, a result or a log line. */
  readonly body: string;
  readonly providerMessageRef: string;
  /** The provider's time. */
  readonly sentAt: Date;
  /** The store's time. */
  readonly receivedAt: Date;
  readonly optOutMatched: boolean;
};
/** The account's message: as InboundMessage, without the opt-out, which reads replies only. */
export type OutboundMessage = Omit<InboundMessage, "optOutMatched">;
/** A campaign message's step, and who approved its text when (approvals' approvedContent). */
export type Approval = {
  readonly stepExecutionId: string;
  readonly approvedBy: string;
  readonly approvedAt: Date;
};

/**
 * Inserts the person's message, `direction = in` with no `sent_by`: its id, or null when a row of
 * the workspace already holds its provider_message_ref, a repeat (ON CONFLICT DO NOTHING).
 */
export async function insertInbound(message: InboundMessage): Promise<string | null> {
  const { workspaceId } = currentTenant();
  const id = newId(ids.message);
  const { count } = await tenantClient.message.createMany({
    data: [{ id, workspaceId, direction: "in", sentBy: null, ...message }],
    skipDuplicates: true,
  });
  return count === 1 ? id : null;
}

/**
 * Inserts the account's message, `direction = out`: the campaign's with the step and the approval
 * given, else the user's. Its id, or null when a row of the workspace already holds its
 * provider_message_ref or its step (ON CONFLICT DO NOTHING).
 */
export async function insertOutbound(
  message: OutboundMessage,
  approval: Approval | null,
): Promise<string | null> {
  const { workspaceId } = currentTenant();
  const id = newId(ids.message);
  const by = approval === null ? { sentBy: "user" as const } : { sentBy: "campaign" as const };
  const { count } = await tenantClient.message.createMany({
    data: [{ id, workspaceId, direction: "out", ...by, ...approval, ...message }],
    skipDuplicates: true,
  });
  return count === 1 ? id : null;
}

/** Whether a row of the workspace holds the step's message, or the provider's message. */
export async function storedMessage(
  where: { readonly stepExecutionId: string } | { readonly providerMessageRef: string },
): Promise<boolean> {
  return (await tenantClient.message.findFirst({ where, select: { id: true } })) !== null;
}

/**
 * The echo stored first as the user's (the provider's echo came before the step's event) made the
 * campaign's: its step, its approval and the approved text. Whether a row was the echo's.
 */
export async function claimEcho(
  providerMessageRef: string,
  body: string,
  approval: Approval,
): Promise<boolean> {
  const echo = {
    providerMessageRef,
    direction: "out",
    sentBy: "user",
    stepExecutionId: null,
  } as const;
  const { count } = await tenantClient.message.updateMany({
    where: echo,
    data: { sentBy: "campaign", body, ...approval },
  });
  return count === 1;
}
