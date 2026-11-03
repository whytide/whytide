// The two checks' runs (docs/flows.md "The send activities"), each under a read reserved first, kind
// send_check, so that it counts in the day's reads and in the 200: linkedin_check_sent, which a send
// activity runs before a retry too, and linkedin_check_reply. The port call sits between the two runs,
// in the activity (workflows/send.ts). A refused read changes nothing: the slot stays held. A port
// error is the account's as a send's is (outcome.ts settleFailed): its row, retry_at and health first,
// then the read committed and the step's slot held past the latest retry_at.
import type { AppError } from "@whytide/platform";
import type { RecentMessage } from "@whytide/providers";
import type { CheckReplyResult, CheckSentResult, SendRefused } from "../../schemas/send.ts";
import { outcomeOf } from "../action-log/log.ts";
import { now } from "../clock.ts";
import { afterPortError } from "../health/signals.ts";
import { commitReads, type Refusal, reserveReads } from "../quota/reservations.ts";
import { SEND_RESERVATION_MS } from "./constants.ts";
import { effectOf, later, pauseAccount, retryAfterOf, settleSent } from "./outcome.ts";
import { markReplied, outreachOf, type Sent } from "./outreach.ts";
import { holdSendUntil, releaseSend } from "./settle.ts";
import { keyRows, type Logged, logCheck, type Step } from "./step.ts";
import { type CheckAnswer, messagesSince, repliedAt, type WentOut, wentOut } from "./went-out.ts";

/** A check under way: its read, and what the port is asked with. */
export type CheckBegun = {
  readonly readId: string;
  readonly since: Date;
  readonly chatRef?: string;
};
export type ReplyBegun = {
  readonly readId: string;
  readonly outreachId: string;
  readonly memberRef: string;
  readonly chatRef: string;
  /** The last send's time. */
  readonly since: Date;
};

const refusal = ({ refused, retryAt }: Refusal): SendRefused => ({
  refused,
  retryAt: retryAt?.toISOString() ?? null,
});

/** The check's first run: none of the key's reservations, not sent and no read; else one read reserved. */
export async function beginCheck(step: Step): Promise<CheckBegun | CheckSentResult> {
  const [first] = await keyRows(step);
  const { accountId, personId, stepExecutionId } = step;
  if (first === undefined) return { outcome: "not_sent", stepExecutionId };
  const kind = "send_check";
  const read = await reserveReads({ accountId, count: 1, kind, objectRef: stepExecutionId });
  if ("refused" in read) return refusal(read);
  const chatRef = (await outreachOf(accountId, personId))?.providerChatRef ?? undefined;
  return { readId: read.reservationId, since: messagesSince(first.createdAt), chatRef };
}

/**
 * The check's second run: the read committed and logged; went out, settled as sent; did not, the
 * key's open reservation released, unless the send activity goes on with it (`release` false).
 */
export async function settleCheck(
  step: Step,
  begun: CheckBegun,
  answer: CheckAnswer,
  release: boolean,
): Promise<Logged<CheckSentResult>> {
  const { accountId, stepExecutionId } = step;
  await commitReads(begun.readId, 1);
  const logged = [await logCheck(accountId, stepExecutionId, "ok")];
  const out = wentOut(answer);
  if (out === null) {
    const open = (await keyRows(step)).filter((row) => row.status === "reserved");
    if (release) for (const row of open) await releaseSend(row.id);
    return { answer: { outcome: "not_sent", stepExecutionId }, logged };
  }
  const sent = await settleSent(step, foundOf(step, out));
  return { answer: { outcome: "sent", stepExecutionId }, logged: [...logged, ...sent.logged] };
}

/**
 * A port error during a check: the code logged; retry_at as the map says and the account's health
 * (health/signals.ts); the read committed; and the step's open reservations, a send check's, held
 * SEND_RESERVATION_MS past the latest retry_at, so that a check failing again never outlasts the hold
 * while the send's outcome is unknown.
 */
export async function checkFailed(
  accountId: string,
  objectRef: string,
  readId: string,
  error: AppError,
  step?: Step,
): Promise<Logged<SendRefused>> {
  const refused = outcomeOf(error);
  const logged = [await logCheck(accountId, objectRef, refused)];
  const paused = await pauseAccount(accountId, effectOf(error).account, retryAfterOf(error));
  const retryAt = later(paused, await afterPortError(accountId, error, now()));
  await commitReads(readId, 1);
  if (step !== undefined) {
    const until = new Date((retryAt ?? now()).getTime() + SEND_RESERVATION_MS);
    for (const row of await keyRows(step)) {
      if (row.status === "reserved") await holdSendUntil(row.id, until);
    }
  }
  return { answer: { refused, retryAt: retryAt?.toISOString() ?? null }, logged };
}

/** linkedin_check_reply's first run: no chat, member or send known, no read; else one read reserved. */
export async function beginReplyCheck(
  accountId: string,
  personId: string,
): Promise<ReplyBegun | CheckReplyResult> {
  const row = await outreachOf(accountId, personId);
  const { providerMemberRef: memberRef, providerChatRef: chatRef, lastSentAt: since } = row ?? {};
  if (!row || !memberRef || !chatRef || !since) return { checked: false, replied: false };
  const kind = "send_check";
  const read = await reserveReads({ accountId, count: 1, kind, objectRef: personId });
  if ("refused" in read) return refusal(read);
  return { readId: read.reservationId, outreachId: row.id, memberRef, chatRef, since };
}

/** linkedin_check_reply's second run: the read committed and logged; a reply marked on the row. */
export async function settleReplyCheck(
  accountId: string,
  personId: string,
  begun: ReplyBegun,
  messages: readonly RecentMessage[],
): Promise<Logged<CheckReplyResult>> {
  await commitReads(begun.readId, 1);
  const logged = [await logCheck(accountId, personId, "ok")];
  const at = repliedAt(messages, begun.since);
  if (at !== null) await markReplied(begun.outreachId, at);
  return { answer: { checked: true, replied: at !== null }, logged };
}

/** What the check found out, for the outreach row: a message's refs; an invite's or withdrawal's time. */
function foundOf(step: Step, out: NonNullable<WentOut>): Sent | null {
  if (step.actionType !== "message") return { actionType: step.actionType, at: now(), found: true };
  const { message } = out;
  if (message === undefined) return null;
  const { messageRef, chatRef, sentAt: at } = message;
  return { actionType: "message", at, messageRef, chatRef };
}
