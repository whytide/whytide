// A send's settle, in one run of the activity after its port call (docs/flows.md "The send
// activities"): the slot as SEND_ERROR_MAP says, the step's row in the action log, the outreach row,
// and the account's retry_at after a rate limit or an unknown outcome, so that a send that went out
// is counted when the call returns; after an error, its health (health/signals.ts). The account's
// row is written before the day's row is locked, the order applyHealth keeps. The check settles with
// settleSent too, once it found the send out.
import { tenantClient } from "@whytide/db";
import type { AppError } from "@whytide/platform";
import { linkedinPort } from "@whytide/providers";
import type { SendFailed, SendSent } from "../../schemas/send.ts";
import { outcomeOf } from "../action-log/log.ts";
import { now } from "../clock.ts";
import { afterPortError } from "../health/signals.ts";
import { PROVIDER_ERROR_PAUSE_MS, SECOND_MS, SEND_RESERVATION_MS } from "./constants.ts";
import { type AccountEffect, refusedReasonOf, SEND_ERROR_MAP, sendAnswerOf } from "./error-map.ts";
import { recordSend, type Sent } from "./outreach.ts";
import { commitSend, holdSendUntil, releaseSend } from "./settle.ts";
import { hasRow, isCounted, keyRows, type Logged, logStep, type Step, sentAnswer } from "./step.ts";

/**
 * The send counted once: the activity's reservation committed; without one (a check), the key's
 * latest, released or expired included, or, when one is counted already, the open ones released.
 * The `ok` row unless the step has one; the outreach row with what went out, when known.
 */
export async function settleSent(
  step: Step,
  sent: Sent | null,
  reservationId?: string,
): Promise<Logged<SendSent>> {
  if (reservationId !== undefined) await commitSend(reservationId);
  else {
    const rows = await keyRows(step);
    const latest = rows.at(-1);
    if (rows.some(isCounted)) {
      for (const row of rows) if (row.status === "reserved") await releaseSend(row.id);
    } else if (latest !== undefined) await commitSend(latest.id);
  }
  const logged = (await hasRow(step, ["ok"])) ? [] : [await logStep(step, "ok")];
  if (sent !== null) await recordSend(step, sent);
  return { answer: sentAnswer(step), logged };
}

/**
 * The port's typed error after the call: the step's row with the code; the account's retry_at and
 * its health (a warning pauses it, the third provider error in the hour moves retry_at to its next
 * working day); then the slot as the map's row for the step's action says, held past the latest
 * retry_at while the outcome is unknown. The answer names the row's reason beside the code when it
 * has one (refusedReasonOf).
 */
export async function settleFailed(
  step: Step,
  reservationId: string,
  error: AppError,
): Promise<Logged<SendFailed>> {
  const answer = sendAnswerOf(error.code, error.details?.reason, step.actionType);
  const effect = SEND_ERROR_MAP[answer];
  const retryAfterSec = retryAfterOf(error);
  const refused = outcomeOf(error);
  const logged = [await logStep(step, refused)];
  const paused = await pauseAccount(step.accountId, effect.account, retryAfterSec);
  const retryAt = later(paused, await afterPortError(step.accountId, error, now()));
  if (effect.slot === "commit") await commitSend(reservationId);
  if (effect.slot === "commit_not_pending") await commitSend(reservationId, { pending: false });
  if (effect.slot === "release") await releaseSend(reservationId);
  if (effect.slot === "keep_until_checked") {
    const from = (retryAt ?? now()).getTime();
    await holdSendUntil(reservationId, new Date(from + SEND_RESERVATION_MS));
  }
  const reason = refusedReasonOf(answer);
  const failed = reason === undefined ? { refused } : { refused, reason };
  return { answer: retryAfterSec === undefined ? failed : { ...failed, retryAfterSec }, logged };
}

/** The later of two instants, either null. */
export function later(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  return b !== null && b > a ? b : a;
}

/** The error map's row for a port error. */
export const effectOf = (error: AppError) =>
  SEND_ERROR_MAP[sendAnswerOf(error.code, error.details?.reason)];

/** A rate limit's wait, in seconds, when the provider gave one. */
export function retryAfterOf(error: AppError): number | undefined {
  const seconds = error.details?.retryAfterSec;
  const limited = error.code === linkedinPort.errors.linkedin_rate_limited;
  return limited && typeof seconds === "number" && seconds > 0 ? seconds : undefined;
}

/**
 * retry_at at now plus the effect's wait (a rate limit's retryAfterSec, else PROVIDER_ERROR_PAUSE_MS;
 * a pause's own), never moved earlier: the account's retry_at after it, a later one that stood
 * already included; null when the effect sets none.
 */
export async function pauseAccount(
  accountId: string,
  effect: AccountEffect | null,
  retryAfterSec: number | undefined,
): Promise<Date | null> {
  if (effect === null || !("retryAt" in effect)) return null;
  const limit = retryAfterSec === undefined ? PROVIDER_ERROR_PAUSE_MS : retryAfterSec * SECOND_MS;
  const until = new Date(now().getTime() + (effect.retryAt === "pause" ? effect.pauseMs : limit));
  const earlier = [{ retryAt: null }, { retryAt: { lt: until } }];
  const moved = await tenantClient.senderAccount.updateMany({
    where: { id: accountId, OR: earlier },
    data: { retryAt: until },
  });
  if (moved.count > 0) return until;
  const standing = await tenantClient.senderAccount.findFirst({
    where: { id: accountId },
    select: { retryAt: true },
  });
  return standing?.retryAt ?? until;
}
