// The thread upsert (README.md "The store"), in the caller's tenant run: one thread per chat of the
// workspace, made by its first message, its last_message_at moved forward only.
import { tenantClient } from "@whytide/db";
import { currentTenant, newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import { INBOX_CHANNEL } from "./constants.ts";

export type ThreadInput = {
  readonly senderAccountId: string;
  /** The sender account's owner, who reads the thread. */
  readonly ownerUserId: string;
  readonly personId: string;
  /** The provider's chat. */
  readonly providerThreadRef: string;
  readonly sentAt: Date;
};

/**
 * The chat's thread, its id: made with the account, its owner and the person when new (INSERT … ON
 * CONFLICT DO NOTHING, so two stores at once keep one row), its last_message_at then moved forward to
 * `sentAt`, never back. An existing thread keeps its account, owner and person.
 */
export async function upsertThread(input: ThreadInput): Promise<string> {
  const { workspaceId } = currentTenant();
  const { senderAccountId, ownerUserId, personId, providerThreadRef, sentAt } = input;
  const chat = { channel: INBOX_CHANNEL, providerThreadRef } as const;
  const row = { id: newId(ids.thread), workspaceId, ...chat, senderAccountId, ownerUserId };
  await tenantClient.thread.createMany({
    data: [{ ...row, personId, lastMessageAt: sentAt }],
    skipDuplicates: true,
  });
  await tenantClient.thread.updateMany({
    where: { ...chat, lastMessageAt: { lt: sentAt } },
    data: { lastMessageAt: sentAt },
  });
  const { id } = await tenantClient.thread.findFirstOrThrow({ where: chat, select: { id: true } });
  return id;
}
