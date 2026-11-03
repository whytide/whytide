// A reply's label (README.md "API"), in the caller's tenant run: one row per inbound message, written
// by the first press and changed in place by a press on the other label, with who pressed and when.
// A press on the label the row holds changes nothing: a PUT sets a state, so a repeat answers the
// row as it stands.
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { ids } from "../../ids.ts";
import type { LabelState } from "../threads/queries.ts";
import type { ReplyLabelValue } from "./constants.ts";

/**
 * Labels the workspace's inbound message as the member: its row, as it now stands.
 * inbox_message_not_found; message_not_inbound for a message the account sent.
 */
export async function setLabel(
  messageId: string,
  label: ReplyLabelValue,
  labeledBy: string,
): Promise<LabelState> {
  // Prisma drops an undefined value from a where: unchecked, that would be any message.
  if (typeof messageId !== "string" || messageId === "") {
    throw new AppError(errors.inbox_message_not_found);
  }
  const message = await tenantClient.message.findFirst({
    where: { id: messageId },
    select: { direction: true },
  });
  if (message === null) throw new AppError(errors.inbox_message_not_found);
  if (message.direction !== "in") throw new AppError(errors.message_not_inbound);
  const { workspaceId } = currentTenant();
  const labeledAt = new Date();
  const row = { id: newId(ids.reply_label), workspaceId, messageId, label, labeledBy, labeledAt };
  // INSERT … ON CONFLICT DO NOTHING, then the change: two presses at once keep one row, the later's.
  const { count } = await tenantClient.replyLabel.createMany({ data: [row], skipDuplicates: true });
  if (count === 0) {
    await tenantClient.replyLabel.updateMany({
      where: { messageId, label: { not: label } },
      data: { label, labeledBy, labeledAt },
    });
  }
  return tenantClient.replyLabel.findFirstOrThrow({
    where: { messageId },
    select: { label: true, labeledBy: true, labeledAt: true },
  });
}
