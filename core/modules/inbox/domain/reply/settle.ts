// A reply's settle (README.md "Replies from the inbox"; docs/flows.md "A reply from the inbox"), in a
// tenant run of inbox_send_reply after the chat's read, the send or its check, the person's lead
// locked first: sent, the row with the provider's ref and time from linkedin's sentMessageRef, an
// echo the receiver stored first as the user's removed so the reply is stored once, the thread moved
// forward and the person's touch; refused or failed, the row with the code, and a read refused before
// the send frees the slot; unknown, the row left sending and the wait before linkedin_check_sent: a
// minute past the account's retry_at or the send, past a refused check's time, or an hour. The lead's
// lock orders it with the echo's store, which takes it first.
import { recordTouch } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { findSendReservation, releaseSend, sentMessageRef } from "@whytide/linkedin";
import { lockKnown } from "../store/person.ts";
import { accountOf } from "./channel.ts";
import { CHECK_MARGIN_MS, CHECK_WAIT_MAX_MS, CHECK_WAIT_MS, type SendStatus } from "./constants.ts";
import { type Answer, checkOutcome, type Outcome, readOutcome, sendOutcome } from "./outcome.ts";
import { type ReplyRow, replyRow, settleRow } from "./row.ts";

export type SettleInput = {
  readonly messageId: string;
  readonly accountId: string;
  readonly reservationId: string;
  /**
   * Whose answer: the chat's read before the send (linkedin_check_reply's refusal), the send's, or
   * the check's after an unknown outcome.
   */
  readonly phase: "read" | "send" | "check";
  readonly answer: Answer | null;
  /** The send's code, which a check's "not sent" fails the reply with. */
  readonly code: string | null;
};
export type Settled =
  | { readonly status: Exclude<SendStatus, "sending"> | "gone" }
  | { readonly status: "unknown"; readonly code: string | null; readonly waitMs: number };

/** The reply settled on the answer, at `now`; a row settled already answers as it stands. */
export async function settleReply(input: SettleInput, now: Date): Promise<Settled> {
  const row = await replyRow(input.messageId);
  if (row === null || !(await lockKnown(row.personId))) return { status: "gone" };
  if (row.sendStatus !== "sending") return { status: row.sendStatus };
  const outcome = await outcomeOf(input);
  if (outcome.kind === "sent") return markSent(row, now);
  if (outcome.kind !== "unknown") {
    // A read refused before the send: no send took the slot, so it is freed here.
    const slot = input.phase === "read" ? await findSendReservation(input.reservationId) : null;
    if (slot?.status === "reserved") await releaseSend(slot.id);
    await settleRow(row.id, outcome.kind, outcome.code);
    return { status: outcome.kind };
  }
  const waitMs = await waitOf(input, outcome, now);
  return { status: "unknown", code: outcome.code, waitMs };
}

async function outcomeOf(input: SettleInput): Promise<Outcome> {
  if (input.phase === "read") return readOutcome(input.answer);
  if (input.phase === "check") return checkOutcome(input.answer, input.code);
  const slot = await findSendReservation(input.reservationId);
  return sendOutcome(input.answer, slot?.status === "reserved");
}

/**
 * The wait before the check, CHECK_MARGIN_MS after a time: after the send, the account's retry_at
 * (an unknown outcome pauses it) or now, so a message still on its way is seen; after a refused
 * check, its time, else CHECK_WAIT_MS; within CHECK_WAIT_MAX_MS.
 */
async function waitOf(input: SettleInput, outcome: Outcome, now: Date): Promise<number> {
  const retryAt =
    input.phase === "send"
      ? ((await accountOf(input.accountId))?.retryAt ?? now)
      : outcome.kind === "unknown" && outcome.retryAt !== null
        ? new Date(outcome.retryAt)
        : null;
  if (retryAt === null) return CHECK_WAIT_MS;
  const from = Math.max(retryAt.getTime(), now.getTime());
  return Math.min(from + CHECK_MARGIN_MS - now.getTime(), CHECK_WAIT_MAX_MS);
}

/**
 * The reply sent: its ref and the provider's time from linkedin's outreach row, which names the
 * message as its last send; an echo stored first (the user's, no member, no step) removed, so the ref
 * is the reply's; a ref another row holds stays there, the reply without one.
 */
async function markSent(row: ReplyRow, now: Date): Promise<Settled> {
  const refs = await sentMessageRef(row.id);
  const sentAt = refs?.sentAt ?? now;
  let providerMessageRef: string | null = null;
  if (refs !== null) {
    const echo = {
      direction: "out",
      sentBy: "user",
      createdBy: null,
      stepExecutionId: null,
    } as const;
    await tenantClient.message.deleteMany({
      where: { ...echo, providerMessageRef: refs.messageRef, id: { not: row.id } },
    });
    const held = await tenantClient.message.findFirst({
      where: { providerMessageRef: refs.messageRef },
      select: { id: true },
    });
    if (held === null) providerMessageRef = refs.messageRef;
  }
  await tenantClient.message.updateMany({
    where: { id: row.id, sendStatus: "sending" },
    data: { sendStatus: "sent", errorCode: null, providerMessageRef, sentAt },
  });
  await tenantClient.thread.updateMany({
    where: { id: row.threadId, lastMessageAt: { lt: sentAt } },
    data: { lastMessageAt: sentAt },
  });
  await recordTouch(row.personId, sentAt);
  return { status: "sent" };
}
