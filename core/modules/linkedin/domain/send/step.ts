// A send's step as the send activities hold it (docs/flows.md "The send activities"): its request
// file on the account, its rows in the action log, which name its step execution, and the key's
// reservations of its account and type. Each runs in the activity's tenant run.
import { tenantClient } from "@whytide/db";
import type { ActionOutcome } from "../../schemas/quota.ts";
import type { SendRequestFile, SendSent } from "../../schemas/send.ts";
import { type LoggedAction, logAction } from "../action-log/log.ts";
import { SEND_ERROR_MAP } from "./error-map.ts";
import { reservationsOfKey, type SendReservationRow } from "./readers.ts";

/** A send's step: its request file, on the account. */
export type Step = SendRequestFile & { readonly accountId: string };
/** An answer and the log rows its run wrote, which the activity counts once the run has returned. */
export type Logged<T> = { readonly answer: T; readonly logged: readonly LoggedAction[] };

/** The outcomes after which the send may have gone out: the error map's slot kept for the check. */
const UNKNOWN = Object.entries(SEND_ERROR_MAP)
  .filter(([, effect]) => effect.slot === "keep_until_checked")
  .map(([code]) => code as ActionOutcome);

/** The note an invite sends: none when empty. */
export const noteOf = (step: Step): string | undefined =>
  step.actionType === "invite" && step.note?.trim() ? step.note : undefined;

export const sentAnswer = (step: Step): SendSent => ({
  sent: true,
  stepExecutionId: step.stepExecutionId,
});

/**
 * The step's row: its kind, its step execution, count 1, and an invite's note. The step execution is
 * its call too (`callRef`): each attempt and retry of one send, under any reservation of its key,
 * counts once towards the third error.
 */
export const logStep = (step: Step, outcome: ActionOutcome): Promise<LoggedAction> =>
  logAction({
    accountId: step.accountId,
    kind: step.actionType,
    objectRef: step.stepExecutionId,
    count: 1,
    outcome,
    withNote: noteOf(step) !== undefined,
    callRef: step.stepExecutionId,
  });

/** A check's row: `send_check`, naming the step execution or, for a reply's, the person. */
export const logCheck = (accountId: string, objectRef: string, outcome: ActionOutcome) =>
  logAction({ accountId, kind: "send_check", objectRef, count: 1, outcome });

/** The key's reservations of the step's account and type, oldest first. */
export async function keyRows(step: Step): Promise<SendReservationRow[]> {
  const rows = await reservationsOfKey(step.idempotencyKey);
  const { accountId, actionType } = step;
  return rows.filter((row) => row.senderAccountId === accountId && row.actionType === actionType);
}

export const isCounted = (row: SendReservationRow): boolean =>
  row.status === "committed" || row.status === "committed_late";

/** Whether the step has a row with `outcome`, or one of `outcomes`. */
export async function hasRow(step: Step, outcomes: readonly ActionOutcome[]): Promise<boolean> {
  const found = await tenantClient.senderActionLog.findFirst({
    where: {
      senderAccountId: step.accountId,
      kind: step.actionType,
      objectRef: step.stepExecutionId,
      outcome: { in: [...outcomes] },
    },
    select: { id: true },
  });
  return found !== null;
}

/** Whether an earlier call of the step left its outcome unknown: the next one checks first. */
export const outcomeUnknown = (step: Step): Promise<boolean> => hasRow(step, UNKNOWN);
