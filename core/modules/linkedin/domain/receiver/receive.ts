// The provider-event receiver (README.md "The webhook", docs/flows.md): a person event the adapter
// verified, invite.accepted or message.received, kept only when it concerns a person an account of
// ours invited or messaged, recorded once and handed on through the outbox before the host's 204.
// The order is the filter, the file, one transaction. A dropped event reaches no table, no file and
// no log line: the counter linkedin.events_dropped alone, by kind. A kept message's payload goes to
// the files port first, outside any run, at a key its event's key names, unless the event has its
// receipt already: a redelivery after inbox's store deleted the file writes it no more (beta-p5-010).
// Then one run in the account's workspace writes the receipt (a repeat ends there), the outreach
// row's change and the event, which commit together or not at all. A failed run leaves at most an
// orphan file, which raw/'s 72 hours expire. No provider or files call runs inside a run. The
// event's key is kept only as its keyed hash (domain/hash.ts): an acceptance's names a member.
import { outboxWriter, type TenantClient } from "@whytide/db";
import { AppError, newId, publish } from "@whytide/platform";
import {
  filesConfig,
  filesPort,
  getAdapter,
  type InviteAccepted,
  type MessageReceived,
} from "@whytide/providers";
import { errors } from "../../errors.ts";
import { events } from "../../events.ts";
import { ids } from "../../ids.ts";
import { linkedinMetrics } from "../../metrics.ts";
import type { MessageFile } from "../../schemas/receiver.ts";
import { now } from "../clock.ts";
import { eventKeyHash } from "../hash.ts";
import { inWorkspace } from "../store.ts";
import { MESSAGE_FILE_SUFFIX, MESSAGE_FILE_TYPE, MESSAGES_FOLDER } from "./constants.ts";
import { findOutreach, type Outreach, type PersonEvent } from "./filter.ts";

/** An account the event's reference names, in its workspace. */
export type ReceivingAccount = { readonly id: string; readonly workspaceId: string };

/**
 * The person event for the accounts its reference's hash found across workspaces: the first account
 * with an outreach row the event concerns keeps it; with none, the event is dropped. The receipt is
 * global, so an event goes to one account only (README.md "Open questions"). An event kept while
 * LINKEDIN_HASH_KEY is empty is linkedin_hash_key_missing (500), before any write: the provider
 * delivers it again.
 */
export async function receive(
  provider: string,
  event: PersonEvent,
  accounts: readonly ReceivingAccount[],
): Promise<void> {
  for (const account of accounts) {
    const filter = (tx: TenantClient) => findOutreach(tx, account.id, event);
    const outreach = await inWorkspace(account.workspaceId, filter);
    if (outreach === null) continue;
    // HMAC-SHA-256 of `event:<adapter>:<key>` under LINKEDIN_HASH_KEY: the key is never kept.
    const keyHash = eventKeyHash(provider, event.eventKey);
    if (keyHash === null) throw new AppError(errors.linkedin_hash_key_missing);
    if (event.kind === "message.received") await keepMessage(account, outreach, event, keyHash);
    else await keepAcceptance(account, outreach, event, keyHash);
    return;
  }
  linkedinMetrics["linkedin.events_dropped"].add(1, { kind: event.kind });
}

/**
 * A kept message: nothing for an event with its receipt already; else its file, then one run: the
 * receipt, an inbound message's last_inbound_at (and the row's chat when it had none), and
 * linkedin.message_received naming the file.
 */
async function keepMessage(
  account: ReceivingAccount,
  outreach: Outreach,
  event: MessageReceived,
  keyHash: string,
): Promise<void> {
  const { workspaceId } = account;
  // A redelivery ends before the file, which inbox's store may have deleted since.
  if (await inWorkspace(workspaceId, (tx) => received(tx, keyHash))) return;
  const { chatRef, messageRef, senderMemberRef, attendeeMemberRefs, fromAccount, text } = event;
  const sentAt = event.sentAt.toISOString();
  const file: MessageFile = {
    chatRef,
    messageRef,
    senderMemberRef,
    attendeeMemberRefs,
    fromAccount,
    sentAt,
    text,
  };
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  const { key } = await files.put({
    workspaceId,
    key: `${MESSAGES_FOLDER}${keyHash}${MESSAGE_FILE_SUFFIX}`,
    body: JSON.stringify(file),
    contentType: MESSAGE_FILE_TYPE,
  });
  const direction = fromAccount ? "out" : "in";
  await inWorkspace(workspaceId, async (tx) => {
    if (!(await stillThere(tx, outreach)) || !(await receipt(tx, keyHash, event.kind))) return;
    if (direction === "in") await markInbound(tx, outreach, event);
    const payload = {
      sender_account_id: account.id,
      person_id: outreach.personId,
      direction,
      file_key: key,
    } as const;
    await publish(outboxWriter(tx, workspaceId), events["linkedin.message_received"], payload);
  });
}

/**
 * A kept acceptance, in one run: the receipt; then, for a row not accepted yet, `accepted_at` (the
 * provider's time, else the detection's) and `accepted_detected_at`, and linkedin.invite_accepted.
 * A row accepted already publishes nothing.
 */
async function keepAcceptance(
  account: ReceivingAccount,
  outreach: Outreach,
  event: InviteAccepted,
  keyHash: string,
): Promise<void> {
  const { workspaceId } = account;
  const detectedAt = now();
  await inWorkspace(workspaceId, async (tx) => {
    if (!(await stillThere(tx, outreach)) || !(await receipt(tx, keyHash, event.kind))) return;
    const accepted = { acceptedAt: event.occurredAt ?? detectedAt, acceptedDetectedAt: detectedAt };
    const where = { id: outreach.id, acceptedAt: null };
    const { count } = await tx.senderOutreach.updateMany({ where, data: accepted });
    if (count === 0) return;
    const payload = {
      sender_account_id: account.id,
      person_id: outreach.personId,
      detected_at: detectedAt.toISOString(),
    };
    await publish(outboxWriter(tx, workspaceId), events["linkedin.invite_accepted"], payload);
  });
}

/** The row the filter found, read again in the run: erased since, the event goes no further. */
async function stillThere(tx: TenantClient, outreach: Outreach): Promise<boolean> {
  const row = await tx.senderOutreach.findFirst({
    where: { id: outreach.id },
    select: { id: true },
  });
  return row !== null;
}

/** The event has its receipt: a repeat. */
async function received(tx: TenantClient, eventKeyHash: string): Promise<boolean> {
  const row = await tx.linkedinEventReceipt.findUnique({
    where: { eventKeyHash },
    select: { id: true },
  });
  return row !== null;
}

/** The event's receipt, unless it has one already: false for a repeat, which ends the run. */
async function receipt(
  tx: TenantClient,
  eventKeyHash: string,
  kind: PersonEvent["kind"],
): Promise<boolean> {
  const row = { id: newId(ids.linkedin_event_receipt), eventKeyHash, kind, receivedAt: now() };
  // ON CONFLICT DO NOTHING: a delivery at the same time waits on the key, then counts none.
  const { count } = await tx.linkedinEventReceipt.createMany({ data: [row], skipDuplicates: true });
  return count === 1;
}

/** The latest inbound message's time, never an earlier one's; the row's chat when it had none. */
async function markInbound(tx: TenantClient, outreach: Outreach, event: MessageReceived) {
  const { id } = outreach;
  const later = [{ lastInboundAt: null }, { lastInboundAt: { lt: event.sentAt } }];
  const data = { lastInboundAt: event.sentAt };
  await tx.senderOutreach.updateMany({ where: { id, OR: later }, data });
  const unknownChat = { id, providerChatRef: null };
  await tx.senderOutreach.updateMany({
    where: unknownChat,
    data: { providerChatRef: event.chatRef },
  });
}
