// A reply's label (README.md "API"; docs/flows.md "The label"; gamma-p4-055), in the caller's tenant
// run: the thread's owner chooses one of campaigns' 7 labels for an inbound message of their own
// thread, another member's or another workspace's being not found, as gamma-p6-060 rules. The
// person's lead is locked before any write, as the classifier and an erasure take it; then the row,
// one per message, changed in place: the class, beta's word that follows it (word.ts), the member and
// the time; then, for the person's newest reply, campaigns' applyReplyLabel acts on it as on a
// confident label, with the return date of the reply's classification for an out-of-office. An older
// reply's label is recorded and acts on nothing (gamma-p4-040's latest-reply rule) but its opt-out,
// which suppresses wherever it is found, as the classifier's does. A PUT sets a state: the label the
// row holds already writes nothing and acts on nothing. No model, no provider.
import { applyReplyLabel, type ReplyActionLabel } from "@whytide/campaigns";
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { ids } from "../../ids.ts";
import { isNewest, optOutOnly } from "../classify/write.ts";
import { lockKnown } from "../store/person.ts";
import type { LabelState } from "../threads/queries.ts";
import { RETURN_DATE_CLASS } from "./constants.ts";
import { betaWord } from "./word.ts";

/** The label as the route answers it: the class always set, as the thread's owner chose it. */
export type ChosenLabel = LabelState & { readonly classLabel: ReplyActionLabel };

const STATE = { label: true, classLabel: true, labeledBy: true, labeledAt: true } as const;

/**
 * Labels an inbound message of the caller's own thread with the class, as `labeledBy`, the caller:
 * the row as it now stands. inbox_message_not_found for no such message, another member's or one
 * whose person is erased; message_not_inbound for a message the account sent.
 */
export async function setLabel(
  messageId: string,
  classLabel: ReplyActionLabel,
  labeledBy: string,
): Promise<ChosenLabel> {
  // Prisma drops an undefined value from a where: unchecked, that would be any message.
  if (typeof messageId !== "string" || messageId === "") {
    throw new AppError(errors.inbox_message_not_found);
  }
  const message = await tenantClient.message.findFirst({
    where: { id: messageId },
    select: { personId: true, threadId: true, direction: true, sentAt: true },
  });
  if (message === null) throw new AppError(errors.inbox_message_not_found);
  const { personId, threadId, sentAt } = message;
  const thread = await tenantClient.thread.findFirst({
    where: { id: threadId },
    select: { ownerUserId: true },
  });
  // Another member's message says nothing of whose it is: as another workspace's.
  if (thread?.ownerUserId !== labeledBy) throw new AppError(errors.inbox_message_not_found);
  if (message.direction !== "in") throw new AppError(errors.message_not_inbound);
  if (!(await lockKnown(personId))) throw new AppError(errors.inbox_message_not_found);

  const stored = await tenantClient.replyLabel.findFirst({ where: { messageId }, select: STATE });
  if (stored !== null && stored.classLabel === classLabel) return { ...stored, classLabel };
  const chosen = { label: betaWord(classLabel), classLabel, labeledBy, labeledAt: new Date() };
  const { workspaceId } = currentTenant();
  const row = { id: newId(ids.reply_label), workspaceId, messageId, ...chosen };
  // INSERT … ON CONFLICT DO NOTHING, then the change: one row per message, as beta's label kept it.
  const { count } = await tenantClient.replyLabel.createMany({ data: [row], skipDuplicates: true });
  if (count === 0) await tenantClient.replyLabel.updateMany({ where: { messageId }, data: chosen });
  if (!(await isNewest(personId, messageId))) {
    await optOutOnly(personId, classLabel);
    return chosen;
  }
  await applyReplyLabel(personId, {
    ...{
      label: classLabel,
      suggested: false,
      returnDate: await returnDateOf(messageId, classLabel),
    },
    // The reply's own instant, as the classifier gives it: campaigns' repeat rule compares the two.
    ...{ repliedAt: sentAt, threadId, ownerUserId: thread.ownerUserId },
  });
  return chosen;
}

/** An out-of-office's return date, the reply's classification's; null for another class or none. */
async function returnDateOf(
  messageId: string,
  classLabel: ReplyActionLabel,
): Promise<string | null> {
  if (classLabel !== RETURN_DATE_CLASS) return null;
  const classification = await tenantClient.replyClassification.findFirst({
    where: { messageId },
    select: { entities: true },
  });
  const date = (classification?.entities as { returnDate?: unknown } | null)?.returnDate;
  return typeof date === "string" ? date : null;
}
