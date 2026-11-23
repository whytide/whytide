// A member's reply from the inbox, the route's run (README.md "Replies from the inbox"; docs/flows.md
// "A reply from the inbox"), in the request's tenant run: the caller's own thread, else
// thread_not_found as another workspace's; its channel sending, else reply_channel_unavailable; the
// text within the channel's; the person's lead locked, as the store locks it, then contacts'
// suppression of an existing conversation, else person_suppressed with its reason; then the row,
// `sending`, and inbox.reply_requested, whose subscriber starts inbox_send_reply. Nothing is sent
// here.
import { errors as contactsErrors, lockLeadStatus, suppressionOf } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId, publish } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { events } from "../../events.ts";
import { ids } from "../../ids.ts";
import { replyStateOf } from "./channel.ts";
import { now as clock } from "./clock.ts";

export type ReplyRequested = { readonly messageId: string; readonly status: "sending" };

const THREAD = {
  id: true,
  channel: true,
  senderAccountId: true,
  ownerUserId: true,
  personId: true,
} as const;

/** The reply's row, sending, and its event; the checks' codes otherwise, nothing written. */
export async function requestReply(threadId: string, text: string): Promise<ReplyRequested> {
  const { workspaceId, principal } = currentTenant();
  // Prisma drops an undefined value from a where: unchecked, that would be any thread. The
  // caller's own only, as every read of the inbox (gamma-p6-060): another member's is not found.
  const where = { id: threadId, ownerUserId: principal.userId };
  const thread =
    typeof threadId === "string" && threadId !== ""
      ? await tenantClient.thread.findFirst({ where, select: THREAD })
      : null;
  if (thread === null) throw new AppError(errors.thread_not_found);
  const state = await replyStateOf(thread, principal.userId);
  // Another member's thread says nothing of whose it is.
  if (!state.own) throw new AppError(errors.thread_not_found);
  if (!state.channelAvailable) throw new AppError(errors.reply_channel_unavailable);
  const body = typeof text === "string" ? text.trim() : "";
  if (body === "" || body.length > state.textMax) {
    throw new AppError(errors.reply_text_invalid, { details: { max: state.textMax } });
  }
  await lockLeadStatus(thread.personId);
  const suppression = await suppressionOf(thread.personId, { newEnrollment: false });
  if (suppression.suppressed) {
    const details = { reason: suppression.reason };
    throw new AppError(contactsErrors.person_suppressed, { details });
  }
  const messageId = newId(ids.message);
  const now = clock();
  await tenantClient.message.create({
    data: {
      ...{ id: messageId, workspaceId, threadId: thread.id, personId: thread.personId, body },
      ...{ direction: "out", sentBy: "user", createdBy: principal.userId, sendStatus: "sending" },
      ...{ sentAt: now, receivedAt: now },
    },
  });
  const outbox = outboxWriter(tenantClient, workspaceId);
  await publish(outbox, events["inbox.reply_requested"], { messageId });
  return { messageId, status: "sending" };
}
