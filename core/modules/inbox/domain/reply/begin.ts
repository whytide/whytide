// A reply's send before the call (README.md "Replies from the inbox"; docs/flows.md "A reply from the
// inbox"), the first run of inbox_send_reply, as campaigns' claim before its sender's call: the row
// still sending; the person's lead locked and contacts' suppression asked again; a LinkedIn thread,
// its account and the person's member id; then linkedin's reserveSend of one message under the
// message's id, its switches, health, hours and budgets read again. A refusal settles the row in the
// same run, nothing reserved. The request file, in linkedin's sendRequestFile shape, is written after
// the run (workflows/reply.ts), so the text never enters a workflow's input, result or history.
import { errors as contactsErrors, lockLeadStatus, suppressionOf } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { releaseSend, reserveSend, type SendRequestFile, sendRequestFile } from "@whytide/linkedin";
import { errors } from "../../errors.ts";
import { accountOf, memberRefOf } from "./channel.ts";
import { INPUT_INVALID, REPLY_ACTION, REPLY_CHANNEL, type SendStatus } from "./constants.ts";
import { replyRow, settleRow } from "./row.ts";

/** Nothing to send: the row's status as it stands, `gone` once erased. */
export type Unsent = { readonly settled: SendStatus | "gone" };
/**
 * The send's channel, the thread's; its person, whose chat is read first; its slot under the
 * message's id, and its request file to write.
 */
export type Prepared = {
  readonly channel: "linkedin";
  readonly accountId: string;
  readonly personId: string;
  readonly reservationId: string;
  readonly file: SendRequestFile;
};

/** The slot and the file of a sending reply; else why nothing is sent, the row settled. */
export async function prepareReply(messageId: string): Promise<Prepared | Unsent> {
  const row = await replyRow(messageId);
  if (row === null) return { settled: "gone" };
  if (row.sendStatus !== "sending") return { settled: row.sendStatus };
  const refuse = async (code: string): Promise<Unsent> => {
    await settleRow(messageId, "refused", code);
    return { settled: "refused" };
  };
  const { senderAccountId: accountId, channel } = await tenantClient.thread.findFirstOrThrow({
    where: { id: row.threadId },
    select: { senderAccountId: true, channel: true },
  });
  // The lead before anything of the person's, as the route and the store lock it.
  await lockLeadStatus(row.personId);
  const suppression = await suppressionOf(row.personId, { newEnrollment: false });
  if (suppression.suppressed) return refuse(contactsErrors.person_suppressed);
  const memberRef = await memberRefOf(row.personId);
  if (channel !== REPLY_CHANNEL || memberRef === null || (await accountOf(accountId)) === null) {
    return refuse(errors.reply_channel_unavailable);
  }
  const idempotencyKey = messageId;
  const slot = await reserveSend({ accountId, actionType: REPLY_ACTION, idempotencyKey });
  if ("refused" in slot) return refuse(slot.refused);
  const file = sendRequestFile.safeParse({
    ...{ actionType: REPLY_ACTION, stepExecutionId: messageId, idempotencyKey },
    ...{ personId: row.personId, memberRef, text: row.body },
  });
  if (!file.success) {
    // A defect: the route takes no text the channel refuses.
    if (slot.status === "reserved") await releaseSend(slot.reservationId);
    await settleRow(messageId, "failed", INPUT_INVALID);
    return { settled: "failed" };
  }
  const { personId } = row;
  return { channel, accountId, personId, reservationId: slot.reservationId, file: file.data };
}
