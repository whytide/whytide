// The acceptance and the first message (README.md "Acceptance and the first message"; docs/flows.md
// "Acceptance → the first message"; briefs RB-9.2.2, RB-11.2.4). firstMessageDueAt, pure but for
// its source of numbers: the first message's earliest time, a draw of 1 to 3 hours after the
// acceptance is detected, never within 10 minutes of it, moved to the next window start on a weekday
// when it falls outside the sender account's window. recordAcceptance, the body of the subscriber to
// linkedin.invite_accepted (events.ts), in the delivery's transaction: the person's active
// enrollment with the account locked, then its steps, never the lead (README.md "Decided here");
// the connection request's accepted_at, the detection, while it is null and the request went out;
// then message_1's due time, while it is planned without one. The delay counts from the detection,
// never from LinkedIn's acceptance time: an invite without a note can be reported hours late
// (docs/07 §5.3). No step's status changes here, since only the sender settles its steps, and no
// provider is called; the queue opens message_1's item once it is due within its window (queue/).
import type { TenantClient } from "@whytide/db";
import { findSenderAccount, errors as linkedinErrors } from "@whytide/linkedin";
import {
  currentTenant,
  isAppError,
  isWindowOpen,
  type LocalHours,
  MONDAY_TO_FRIDAY,
  nextWindowAt,
  randomTimesInWindow,
} from "@whytide/platform";
import { random as chance } from "./clock.ts";
import { MS_PER_HOUR, MS_PER_MINUTE, WENT_OUT_STATUSES, WINDOW_STARTS_TRIED } from "./constants.ts";
import { requireInstant } from "./gate/instant.ts";
import {
  FIRST_MESSAGE_DELAY_HOURS,
  MIN_MINUTES_AFTER_ACCEPTANCE,
  TEMPLATE_STEPS,
} from "./template/constants.ts";

/** The template's connection request, whose acceptance is recorded… */
const INVITE = TEMPLATE_STEPS[0] satisfies { readonly action: "invite" };
/** …and its first message, the step whose delay counts from the acceptance's detection. */
const FIRST_MESSAGE = TEMPLATE_STEPS[1] satisfies {
  readonly delay: { readonly anchor: "accepted" };
};

/** A sender account's time as the due time reads it: its IANA zone and its working hours. */
export type AccountHours = { readonly timeZone: string; readonly workingHours: LocalHours };

/** linkedin.invite_accepted as the subscriber reads it: ids, and when Whytide learned of it. */
export type InviteAccepted = {
  readonly senderAccountId: string;
  readonly personId: string;
  readonly detectedAt: Date;
};

/**
 * What a delivery did: nothing; the acceptance recorded alone (message_1 not planned without a due
 * time, or no window to place it in); or that and message_1's due time.
 */
export type AcceptanceOutcome = "unchanged" | "accepted" | "due";

const STEP_FIELDS = {
  id: true,
  stepKey: true,
  status: true,
  dueAt: true,
  acceptedAt: true,
} as const;

/**
 * The first message's due time after an acceptance detected at `detectedAt`: the detection plus a
 * uniform draw in FIRST_MESSAGE_DELAY_HOURS, never under MIN_MINUTES_AFTER_ACCEPTANCE after it; when
 * that falls outside the account's window, its days cut to Monday to Friday, the next window start
 * where the window is open, so a start whose whole window a spring-forward skips is passed over. Null
 * when the account's days hold no weekday: no window ever opens. `random` gives numbers in [0, 1);
 * any other value throws (platform's time_argument_invalid) and places no time.
 */
export function firstMessageDueAt(
  detectedAt: Date,
  account: AccountHours,
  random: () => number,
): Date | null {
  const detected = requireInstant(detectedAt, "detectedAt").getTime();
  const { timeZone, workingHours } = account;
  const days = MONDAY_TO_FRIDAY.filter((day) => workingHours.days.includes(day));
  if (days.length === 0) return null;
  const hours: LocalHours = { ...workingHours, days };
  const from = new Date(detected + FIRST_MESSAGE_DELAY_HOURS.min * MS_PER_HOUR);
  const to = new Date(detected + FIRST_MESSAGE_DELAY_HOURS.max * MS_PER_HOUR);
  const [drawn = from] = randomTimesInWindow({ from, to, count: 1, minGapMs: 0, random });
  const earliest = new Date(detected + MIN_MINUTES_AFTER_ACCEPTANCE * MS_PER_MINUTE);
  let due = drawn > earliest ? drawn : earliest;
  for (let tried = 0; !isWindowOpen(due, timeZone, hours); tried += 1) {
    if (tried === WINDOW_STARTS_TRIED) return null;
    due = nextWindowAt(due, timeZone, hours);
  }
  return due;
}

/**
 * The acceptance recorded on the person's active enrollment with the account, in the delivery's
 * transaction (the file's header). A redelivery, or the daily check's acceptance of the same person,
 * finds accepted_at set and changes nothing; so does an enrollment that ended, a connection request
 * that never went out, or another account's acceptance.
 */
export async function recordAcceptance(
  tx: TenantClient,
  accepted: InviteAccepted,
): Promise<AcceptanceOutcome> {
  const detectedAt = requireInstant(accepted.detectedAt, "detectedAt");
  const enrollmentId = await lockActiveEnrollment(tx, accepted);
  if (enrollmentId === null) return "unchanged";
  const steps = await tx.stepExecution.findMany({
    where: { enrollmentId, stepKey: { in: [INVITE.stepKey, FIRST_MESSAGE.stepKey] } },
    select: STEP_FIELDS,
  });
  const invite = steps.find(({ stepKey }) => stepKey === INVITE.stepKey);
  if (invite === undefined || invite.acceptedAt !== null || !wentOut(invite.status)) {
    return "unchanged";
  }
  // Conditional on the request still out, not on the status read: the sender may settle it meanwhile.
  const { count } = await tx.stepExecution.updateMany({
    where: { id: invite.id, status: { in: [...WENT_OUT_STATUSES] }, acceptedAt: null },
    data: { acceptedAt: detectedAt },
  });
  if (count === 0) return "unchanged";
  const message = steps.find(({ stepKey }) => stepKey === FIRST_MESSAGE.stepKey);
  if (message === undefined || message.status !== "planned" || message.dueAt !== null) {
    return "accepted";
  }
  // An account linkedin no longer holds, or one with no weekday: nothing could go from it.
  const account = await accountOf(accepted.senderAccountId);
  const dueAt = account === null ? null : firstMessageDueAt(detectedAt, account, chance);
  if (dueAt === null) return "accepted";
  const due = await tx.stepExecution.updateMany({
    where: { id: message.id, status: "planned", dueAt: null },
    data: { dueAt },
  });
  return due.count === 1 ? "due" : "accepted";
}

/**
 * The id of the person's active enrollment with the account, its row locked until the delivery ends;
 * null for none. A hold that ended it meanwhile is waited for, and its row then no longer matches.
 */
async function lockActiveEnrollment(
  tx: TenantClient,
  accepted: InviteAccepted,
): Promise<string | null> {
  const { workspaceId } = currentTenant();
  const { personId, senderAccountId } = accepted;
  const [enrollment] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM enrollments
    WHERE workspace_id = ${workspaceId} AND person_id = ${personId}
      AND sender_account_id = ${senderAccountId} AND status = 'active'
    FOR UPDATE`;
  return enrollment?.id ?? null;
}

const wentOut = (status: string): boolean =>
  (WENT_OUT_STATUSES as readonly string[]).includes(status);

/**
 * The account's zone and hours; null once linkedin no longer holds it in the run's workspace. The
 * queue's recovery of a first message reads it too (queue/recover.ts).
 */
export async function accountOf(senderAccountId: string): Promise<AccountHours | null> {
  try {
    return await findSenderAccount(senderAccountId);
  } catch (error) {
    if (isAppError(error) && error.code === linkedinErrors.sender_account_not_found) return null;
    throw error;
  }
}
