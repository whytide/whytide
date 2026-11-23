// The platform's own messages (README.md "The platform's own messages"; docs/flows.md "The step's
// event"): campaigns.step_sent's subscriber stores a sent message step's message in its thread, in
// the delivery's tenant run (tenantClient is its transaction), from rows only: campaigns' sentStep,
// approvals' approvedContent and linkedin's sentMessageRef, the provider's refs linkedin's alone. No
// file, no provider. Stored once by its provider ref, whichever comes first, the step's event or the
// echo (echo.ts); the step's event always leaves the campaign's row, with the approved text. The
// step was sent, so its approval is taken as the send took it: a person's, or the campaign's mode's,
// stored with no `approved_by` (gamma-p4-090).
import { approvedContent } from "@whytide/approvals";
import { sentStep } from "@whytide/campaigns";
import { findSenderAccount, sentMessageRef } from "@whytide/linkedin";
import { createLogger, type Logger } from "@whytide/platform";
import { SENT_ACTION, SENT_UNMATCHED } from "./constants.ts";
import { claimEcho, insertOutbound, storedMessage } from "./message.ts";
import { lockKnown } from "./person.ts";
import { upsertThread } from "./thread.ts";

/** campaigns.step_sent's payload: ids and the action only. */
export type SentInput = {
  readonly stepExecutionId: string;
  readonly personId: string;
  readonly actionType: string;
};
/**
 * What the subscriber did: the message stored, or the echo stored first made the campaign's
 * (claimed); else nothing, for a step that is no message (skipped), an erased person (gone), a
 * redelivery (repeat) or a step without its send, its approval or its refs (unmatched, logged).
 */
export type SentOutcome = "stored" | "claimed" | "skipped" | "gone" | "repeat" | "unmatched";

let log: Logger | undefined;

/** The host's logger for the unmatched line (workflows/index.ts, onWorkerStart). */
export function useSentLog(logger: Logger): void {
  log = logger;
}

/**
 * The step's message in its thread, at `now` its received_at: by the step, a row holding it is a
 * redelivery; then by its provider ref, a new row, or the echo's made the campaign's. The person's
 * lead is locked first, as privacy's erasure locks it before it deletes their rows.
 */
export async function storeSent(input: SentInput, now: Date): Promise<SentOutcome> {
  const { stepExecutionId, personId } = input;
  if (input.actionType !== SENT_ACTION) return "skipped";
  if (!(await lockKnown(personId))) return "gone";
  // Before the reads: linkedin's refs answer the person's last send only, a later one's after it.
  if (await storedMessage({ stepExecutionId })) return "repeat";
  const step = await sentStep(stepExecutionId);
  const approved =
    step === null ? null : await approvedContent(stepExecutionId, { allowMode: true });
  const refs = approved === null ? null : await sentMessageRef(stepExecutionId);
  const matched = step?.personId === personId && step.actionType === SENT_ACTION;
  if (step === null || approved === null || refs === null || !matched) return unmatched(input);
  const { senderAccountId, executedAt: sentAt } = step;
  const { ownerUserId } = await findSenderAccount(senderAccountId);
  const thread = { senderAccountId, ownerUserId, personId, sentAt };
  const threadId = await upsertThread({ ...thread, providerThreadRef: refs.chatRef });
  const { text: body, approvedBy, approvedAt } = approved;
  const approval = { stepExecutionId, approvedBy, approvedAt };
  const message = { threadId, personId, body, providerMessageRef: refs.messageRef };
  if ((await insertOutbound({ ...message, sentAt, receivedAt: now }, approval)) !== null) {
    return "stored";
  }
  // The ref is held: the echo stored first as the user's, or, a defect, another step's row.
  return (await claimEcho(refs.messageRef, body, approval)) ? "claimed" : unmatched(input);
}

/** A defect, every `succeeded` message step having all three: the step's id logged, nothing stored. */
function unmatched({ stepExecutionId }: SentInput): "unmatched" {
  (log ??= createLogger()).error(
    { code: SENT_UNMATCHED, step_execution_id: stepExecutionId },
    "inbox: a sent message step without its send, its approval or its refs",
  );
  return "unmatched";
}
